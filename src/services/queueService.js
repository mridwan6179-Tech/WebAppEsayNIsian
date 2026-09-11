const db = require('../config/database');
require('dotenv').config();

// Track status worker per ulangan
const runningWorkers = new Map(); // ulanganId -> { isRunning: boolean, shouldStop: boolean }

const queueService = {
  // Hitung jeda acak 5 - 13 detik (atau dari env)
  getRandomDelay(minVal = null, maxVal = null) {
    const min = minVal ?? Number(process.env.DELAY_MIN || 5);
    const max = maxVal ?? Number(process.env.DELAY_MAX || 13);
    const seconds = Math.floor(Math.random() * (max - min + 1)) + min;
    return seconds * 1000; // milidetik
  },

  // Pemulihan kunci antrean yang macet (misal serverless restart/crash/timeout > 2 menit)
  recoverStaleLocks(ulanganId = null) {
    try {
      const condition = ulanganId 
        ? `AND jawaban_id IN (SELECT j.id FROM jawaban j JOIN pengerjaan p ON j.pengerjaan_id = p.id WHERE p.ulangan_id = ?)`
        : '';
      const params = ulanganId ? [ulanganId] : [];

      db.prepare(`
        UPDATE antrean_review 
        SET status = 'menunggu' 
        WHERE status = 'diproses' 
          AND (locked_at IS NULL OR datetime(locked_at) <= datetime('now', '-2 minutes'))
          ${condition}
      `).run(...params);

      db.prepare(`
        UPDATE jawaban 
        SET status_penilaian = 'menunggu' 
        WHERE status_penilaian = 'diproses' 
          AND id IN (SELECT jawaban_id FROM antrean_review WHERE status = 'menunggu')
      `).run();
    } catch (e) {
      console.warn('⚠️ Recover stale locks warning:', e.message);
    }
  },

  // FR-09: Masukkan seluruh jawaban yang belum dinilai ke dalam antrean
  enqueueUlangan(ulanganId) {
    this.recoverStaleLocks(ulanganId);

    // Ambil semua jawaban dari pengerjaan yang sudah di-submit untuk ulangan ini
    const pendingAnswers = db.prepare(`
      SELECT j.id as jawaban_id
      FROM jawaban j
      JOIN pengerjaan p ON j.pengerjaan_id = p.id
      WHERE p.ulangan_id = ? 
        AND p.status = 'submitted'
        AND j.status_penilaian != 'selesai'
    `).all(ulanganId);

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO antrean_review (jawaban_id, status, attempt_count)
      VALUES (?, 'menunggu', 0)
    `);

    const updateStatusStmt = db.prepare(`
      UPDATE antrean_review 
      SET status = 'menunggu', error_message = NULL
      WHERE jawaban_id = ? AND status != 'selesai'
    `);

    const updateJawabanStmt = db.prepare(`
      UPDATE jawaban 
      SET status_penilaian = 'menunggu' 
      WHERE id = ? AND status_penilaian != 'selesai'
    `);

    const transaction = db.transaction(() => {
      for (const item of pendingAnswers) {
        insertStmt.run(item.jawaban_id);
        updateStatusStmt.run(item.jawaban_id);
        updateJawabanStmt.run(item.jawaban_id);
      }
    });

    transaction();
    if (typeof db.syncCloud === 'function') {
      db.syncCloud(true);
    }
    return this.getQueueStatus(ulanganId);
  },

  // Masukkan seluruh jawaban dari satu pengerjaan siswa ke antrean (atau reset jika ingin dinilai ulang)
  enqueuePengerjaan(pengerjaanId) {
    const pengerjaan = db.prepare('SELECT id, ulangan_id, status FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    if (!pengerjaan) throw new Error('Pengerjaan tidak ditemukan');
    if (pengerjaan.status !== 'submitted') throw new Error('Siswa belum mengumpulkan ujian');

    this.recoverStaleLocks(pengerjaan.ulangan_id);

    let pendingAnswers = db.prepare(`
      SELECT j.id as jawaban_id
      FROM jawaban j
      WHERE j.pengerjaan_id = ? AND j.status_penilaian != 'selesai'
    `).all(pengerjaanId);

    // Jika seluruh jawaban sudah berstatus 'selesai', reset agar bisa dinilai ulang dengan AI
    if (pendingAnswers.length === 0) {
      db.prepare(`
        UPDATE jawaban 
        SET status_penilaian = 'menunggu', attempt_count = 0 
        WHERE pengerjaan_id = ?
      `).run(pengerjaanId);

      pendingAnswers = db.prepare(`
        SELECT j.id as jawaban_id
        FROM jawaban j
        WHERE j.pengerjaan_id = ?
      `).all(pengerjaanId);
    }

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO antrean_review (jawaban_id, status, attempt_count)
      VALUES (?, 'menunggu', 0)
    `);

    const updateStatusStmt = db.prepare(`
      UPDATE antrean_review 
      SET status = 'menunggu', error_message = NULL
      WHERE jawaban_id = ?
    `);

    const updateJawabanStmt = db.prepare(`
      UPDATE jawaban 
      SET status_penilaian = 'menunggu' 
      WHERE id = ?
    `);

    const transaction = db.transaction(() => {
      for (const item of pendingAnswers) {
        insertStmt.run(item.jawaban_id);
        updateStatusStmt.run(item.jawaban_id);
        updateJawabanStmt.run(item.jawaban_id);
      }
    });

    transaction();
    if (typeof db.syncCloud === 'function') {
      db.syncCloud(true);
    }
    return pendingAnswers;
  },

  // Mendapatkan status & statistik antrean untuk ulangan ini
  getQueueStatus(ulanganId) {
    this.recoverStaleLocks(ulanganId);

    const stats = db.prepare(`
      SELECT 
        COUNT(j.id) as total,
        SUM(CASE WHEN j.status_penilaian = 'selesai' THEN 1 ELSE 0 END) as selesai,
        SUM(CASE WHEN j.status_penilaian = 'diproses' THEN 1 ELSE 0 END) as diproses,
        SUM(CASE WHEN j.status_penilaian = 'menunggu' THEN 1 ELSE 0 END) as menunggu,
        SUM(CASE WHEN j.status_penilaian = 'gagal' THEN 1 ELSE 0 END) as gagal
      FROM jawaban j
      JOIN pengerjaan p ON j.pengerjaan_id = p.id
      WHERE p.ulangan_id = ? AND p.status = 'submitted'
    `).get(ulanganId);

    const workerState = runningWorkers.get(Number(ulanganId));

    return {
      total: stats?.total || 0,
      selesai: stats?.selesai || 0,
      diproses: stats?.diproses || 0,
      menunggu: stats?.menunggu || 0,
      gagal: stats?.gagal || 0,
      isRunning: Boolean(workerState?.isRunning)
    };
  },

  // FR-13: Hentikan worker antrean
  stopReview(ulanganId) {
    const id = Number(ulanganId);
    const worker = runningWorkers.get(id);
    if (worker) {
      worker.shouldStop = true;
    }
    return { success: true, message: 'Proses review dihentikan' };
  },

  // Evaluasi 1 jawaban berikutnya dari antrean (bisa dipanggil berulang oleh browser/serverless atau background worker)
  async processNextAnswer(ulanganId, gradeFunction = null) {
    const id = Number(ulanganId);
    this.recoverStaleLocks(id);

    // Ambil 1 pekerjaan antrean tertua yang siap diproses
    const queueItem = db.prepare(`
      SELECT a.id as antrean_id, a.jawaban_id, a.attempt_count,
             j.pengerjaan_id, j.jawaban_siswa, j.skor_maksimum,
             s.pertanyaan, s.jenis, s.bobot, s.kunci_jawaban, s.rubrik, s.tingkat_kelas, s.tingkat_kesulitan,
             s.pembahasan, s.audio_script, s.is_listening, s.bahasa,
             u.izinkan_singkatan, u.izinkan_informal, u.toleransi_typo, u.instruksi_penilaian_khusus
      FROM antrean_review a
      JOIN jawaban j ON a.jawaban_id = j.id
      JOIN soal s ON j.soal_id = s.id
      JOIN pengerjaan p ON j.pengerjaan_id = p.id
      JOIN ulangan u ON p.ulangan_id = u.id
      WHERE p.ulangan_id = ? 
        AND j.status_penilaian != 'selesai'
        AND (a.status = 'menunggu' OR (a.status = 'gagal' AND a.attempt_count < 3))
        AND (a.next_attempt_at IS NULL OR datetime(a.next_attempt_at) <= datetime('now'))
      ORDER BY a.attempt_count ASC, a.id ASC
      LIMIT 1
    `).get(id);

    if (!queueItem) {
      return {
        success: true,
        done: true,
        message: 'Semua jawaban selesai dinilai atau antrean kosong',
        status: this.getQueueStatus(id)
      };
    }

    // Kunci item antrean (status: diproses)
    db.prepare(`
      UPDATE antrean_review 
      SET status = 'diproses', locked_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(queueItem.antrean_id);

    db.prepare(`
      UPDATE jawaban 
      SET status_penilaian = 'diproses' 
      WHERE id = ?
    `).run(queueItem.jawaban_id);

    try {
      let result;
      if (gradeFunction) {
        result = await gradeFunction(queueItem);
      } else {
        const geminiService = require('./geminiService');
        result = await geminiService.gradeAnswer(queueItem);
      }

      let normalizedStatus = result.status_jawaban;
      if (!['benar', 'parsial', 'salah', 'perlu_review'].includes(normalizedStatus)) {
        if (normalizedStatus === 'sebagian') normalizedStatus = 'parsial';
        else normalizedStatus = 'perlu_review';
      }

      // Simpan hasil penilaian yang berhasil
      db.transaction(() => {
        db.prepare(`
          UPDATE jawaban
          SET status_penilaian = 'selesai',
              skor_rekomendasi = ?,
              status_jawaban = ?,
              alasan_ai = ?,
              model_ai = ?,
              reviewed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          result.skor_rekomendasi,
          normalizedStatus,
          result.alasan_ai,
          result.model_ai || 'gemini',
          queueItem.jawaban_id
        );

        db.prepare(`
          UPDATE antrean_review
          SET status = 'selesai', completed_at = CURRENT_TIMESTAMP, error_message = NULL
          WHERE id = ?
        `).run(queueItem.antrean_id);
      })();

      // Auto-kalkulasi nilai total pengerjaan siswa saat butir soal dinilai AI
      // Nilai AI & Nilai Final langsung muncul di tabel depan guru (status tetap belum dirilis / released_at tetap NULL)
      try {
        const reviewService = require('./reviewService');
        if (queueItem.pengerjaan_id) {
          reviewService.recalculatePengerjaanTotal(queueItem.pengerjaan_id);
        }
      } catch (e) {
        console.warn('⚠️ Gagal auto-kalkulasi nilai pengerjaan:', e.message);
      }

      if (typeof db.syncCloud === 'function') {
        db.syncCloud(true);
      }

      return {
        success: true,
        done: false,
        jawaban_id: queueItem.jawaban_id,
        result,
        status: this.getQueueStatus(id)
      };

    } catch (err) {
      const isRateLimit = err?.status === 429 || String(err?.message || '').toLowerCase().includes('rate') || String(err?.message || '').includes('429');
      const newAttempt = queueItem.attempt_count + 1;
      const maxRetry = 3;

      // Adaptive delay jika terjadi rate limit (FR-12 & NFR-05)
      const retrySeconds = isRateLimit ? 25 : 10;
      const finalStatus = newAttempt >= maxRetry ? 'gagal' : 'menunggu';

      db.transaction(() => {
        db.prepare(`
          UPDATE antrean_review
          SET status = ?,
              attempt_count = ?,
              next_attempt_at = datetime('now', '+' || ? || ' seconds'),
              error_message = ?
          WHERE id = ?
        `).run(finalStatus, newAttempt, retrySeconds, String(err.message), queueItem.antrean_id);

        db.prepare(`
          UPDATE jawaban
          SET status_penilaian = ?,
              attempt_count = ?,
              last_error = ?
          WHERE id = ?
        `).run(finalStatus, newAttempt, String(err.message), queueItem.jawaban_id);
      })();

      if (typeof db.syncCloud === 'function') {
        db.syncCloud(true);
      }

      return {
        success: false,
        done: false,
        jawaban_id: queueItem.jawaban_id,
        error: String(err.message),
        status: this.getQueueStatus(id)
      };
    }
  },

  // FR-10, FR-11, FR-12, FR-13: Jalankan worker antrean
  async startReview(ulanganId, gradeFunction = null, delayOverride = null) {
    const id = Number(ulanganId);

    // Pastikan tidak ada 2 worker aktif bersamaan untuk ulangan yang sama (NFR-02)
    if (runningWorkers.get(id)?.isRunning) {
      return { success: false, message: 'Review sedang berjalan' };
    }

    // Enqueue jawaban baru jika ada
    this.enqueueUlangan(id);

    const workerState = { isRunning: true, shouldStop: false };
    runningWorkers.set(id, workerState);

    // Jalankan pemrosesan di latar belakang
    const runWorker = async () => {
      try {
        while (!workerState.shouldStop) {
          const stepResult = await this.processNextAnswer(id, gradeFunction);
          if (stepResult.done) {
            break;
          }

          if (workerState.shouldStop) break;

          // FR-11 & NFR-03: Jeda acak antar-request
          const delayMs = delayOverride !== null ? delayOverride : this.getRandomDelay();
          if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        }
      } finally {
        workerState.isRunning = false;
        runningWorkers.delete(id);
      }
    };

    // Jalankan tanpa menunggu seluruh antrean tuntas agar request HTTP segera merespons
    runWorker();

    return {
      success: true,
      message: 'Review AI berhasil dimulai',
      status: this.getQueueStatus(id)
    };
  },

  // Jalankan review AI khusus untuk 1 pengerjaan siswa secara perorangan / individual
  async startReviewSingle(pengerjaanId, guruId, gradeFunction = null, delayOverride = null) {
    const pengerjaan = db.prepare(`
      SELECT p.id, p.ulangan_id, p.status, p.nilai_ai, p.nilai_final, u.guru_id
      FROM pengerjaan p
      JOIN ulangan u ON p.ulangan_id = u.id
      WHERE p.id = ?
    `).get(pengerjaanId);

    if (!pengerjaan) throw new Error('Data pengerjaan tidak ditemukan');
    if (pengerjaan.guru_id !== guruId) throw new Error('Akses ditolak: bukan ulangan milik Anda');
    if (pengerjaan.status !== 'submitted') throw new Error('Ujian belum dikumpulkan oleh siswa');

    const ulanganId = pengerjaan.ulangan_id;
    if (runningWorkers.get(Number(ulanganId))?.isRunning) {
      return {
        success: false,
        message: 'Review massal seluruh ulangan sedang berjalan. Harap tunggu hingga selesai atau hentikan review massal terlebih dahulu.'
      };
    }

    const pendingAnswers = this.enqueuePengerjaan(pengerjaanId);
    if (pendingAnswers.length === 0) {
      return {
        success: true,
        message: 'Tidak ada jawaban yang perlu dinilai',
        nilai_ai: pengerjaan.nilai_ai,
        nilai_final: pengerjaan.nilai_final
      };
    }

    const geminiService = require('./geminiService');
    const reviewService = require('./reviewService');

    const results = [];
    for (let i = 0; i < pendingAnswers.length; i++) {
      const item = pendingAnswers[i];
      const queueItem = db.prepare(`
        SELECT a.id as antrean_id, a.jawaban_id, a.attempt_count,
               j.jawaban_siswa, j.skor_maksimum,
               s.pertanyaan, s.jenis, s.bobot, s.kunci_jawaban, s.rubrik, s.tingkat_kelas, s.tingkat_kesulitan,
               s.pembahasan, s.audio_script, s.is_listening, s.bahasa,
               u.izinkan_singkatan, u.izinkan_informal, u.toleransi_typo, u.instruksi_penilaian_khusus
        FROM antrean_review a
        JOIN jawaban j ON a.jawaban_id = j.id
        JOIN soal s ON j.soal_id = s.id
        JOIN pengerjaan p ON j.pengerjaan_id = p.id
        JOIN ulangan u ON p.ulangan_id = u.id
        WHERE j.id = ?
      `).get(item.jawaban_id);

      if (!queueItem) continue;

      db.prepare(`UPDATE antrean_review SET status = 'diproses', locked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(queueItem.antrean_id);
      db.prepare(`UPDATE jawaban SET status_penilaian = 'diproses' WHERE id = ?`).run(queueItem.jawaban_id);

      try {
        let result;
        if (gradeFunction) {
          result = await gradeFunction(queueItem);
        } else {
          result = await geminiService.gradeAnswer(queueItem);
        }

        let normalizedStatus = result.status_jawaban;
        if (!['benar', 'parsial', 'salah', 'perlu_review'].includes(normalizedStatus)) {
          if (normalizedStatus === 'sebagian') normalizedStatus = 'parsial';
          else normalizedStatus = 'perlu_review';
        }

        db.transaction(() => {
          db.prepare(`
            UPDATE jawaban
            SET status_penilaian = 'selesai',
                skor_rekomendasi = ?,
                status_jawaban = ?,
                alasan_ai = ?,
                model_ai = ?,
                reviewed_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            result.skor_rekomendasi,
            normalizedStatus,
            result.alasan_ai,
            result.model_ai || 'gemini',
            queueItem.jawaban_id
          );

          db.prepare(`
            UPDATE antrean_review
            SET status = 'selesai', completed_at = CURRENT_TIMESTAMP, error_message = NULL
            WHERE id = ?
          `).run(queueItem.antrean_id);
        })();

        results.push({ jawaban_id: queueItem.jawaban_id, success: true, result });
      } catch (err) {
        db.transaction(() => {
          db.prepare(`
            UPDATE antrean_review
            SET status = 'gagal', error_message = ?
            WHERE id = ?
          `).run(String(err.message), queueItem.antrean_id);

          db.prepare(`
            UPDATE jawaban
            SET status_penilaian = 'gagal', last_error = ?
            WHERE id = ?
          `).run(String(err.message), queueItem.jawaban_id);
        })();

        results.push({ jawaban_id: queueItem.jawaban_id, success: false, error: String(err.message) });
      }

      if (i < pendingAnswers.length - 1) {
        const delayMs = delayOverride !== null ? delayOverride : 600;
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    const scores = reviewService.recalculatePengerjaanTotal(pengerjaanId);
    if (typeof db.syncCloud === 'function') {
      db.syncCloud(true);
    }

    const successCount = results.filter(r => r.success).length;
    return {
      success: true,
      message: `Review AI perorangan selesai (${successCount}/${pendingAnswers.length} jawaban dinilai)`,
      pengerjaan_id: pengerjaanId,
      nilai_ai: scores.nilai_ai,
      nilai_final: scores.nilai_final,
      total_dinilai: successCount,
      results
    };
  }
};

module.exports = queueService;
