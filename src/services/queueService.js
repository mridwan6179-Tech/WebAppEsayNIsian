const db = require('../config/database');
require('dotenv').config();

// Track status worker per ulangan
const runningWorkers = new Map(); // ulanganId -> { isRunning: boolean, shouldStop: boolean }
let lastAutoTickAt = 0;
let isCurrentlyGradingAnswer = false;
let lastProcessedPengerjaanId = null;

const queueService = {
  // Hitung jeda acak 5 - 13 detik (atau dari env)
  getRandomDelay(minVal = null, maxVal = null) {
    const min = minVal ?? Number(process.env.DELAY_MIN || 5);
    const max = maxVal ?? Number(process.env.DELAY_MAX || 13);
    const seconds = Math.floor(Math.random() * (max - min + 1)) + min;
    return seconds * 1000; // milidetik
  },

  // Pemulihan kunci antrean yang macet (misal serverless restart/crash/timeout > 25 detik)
  recoverStaleLocks(ulanganId = null) {
    try {
      const condition = ulanganId 
        ? `AND jawaban_id IN (SELECT j.id FROM jawaban j JOIN pengerjaan p ON j.pengerjaan_id = p.id WHERE p.ulangan_id = ?)`
        : '';
      const params = ulanganId ? [ulanganId] : [];

      // Ambil butir yang terkunci lebih dari 25 detik (hang / crash / timeout)
      const staleProcessing = db.prepare(`
        SELECT a.id as antrean_id, j.id as jawaban_id, j.pengerjaan_id, j.jawaban_siswa, j.skor_maksimum,
               s.pertanyaan, s.jenis, s.bobot, s.kunci_jawaban, s.rubrik
        FROM antrean_review a
        JOIN jawaban j ON a.jawaban_id = j.id
        JOIN soal s ON j.soal_id = s.id
        JOIN pengerjaan p ON j.pengerjaan_id = p.id
        WHERE a.status = 'diproses'
          AND (a.locked_at IS NULL OR datetime(a.locked_at) <= datetime('now', '-25 seconds'))
          ${condition}
      `).all(...params);

      if (staleProcessing.length > 0) {
        const geminiService = require('./geminiService');
        const reviewService = require('./reviewService');
        for (const item of staleProcessing) {
          try {
            const fb = geminiService.fallbackOfflineEvaluation({
              pertanyaan: item.pertanyaan,
              kunci_jawaban: item.kunci_jawaban || '',
              rubrik: item.rubrik || '',
              jawaban_siswa: item.jawaban_siswa || '',
              bobot: item.bobot,
              skor_maksimum: item.skor_maksimum,
              jenis: item.jenis
            });
            db.prepare(`
              UPDATE jawaban
              SET skor_rekomendasi = ?, status_jawaban = ?, alasan_ai = ?, model_ai = 'fallback_offline', status_penilaian = 'selesai', reviewed_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(fb.skor_rekomendasi, fb.status_jawaban, (fb.alasan_ai || '') + ' (Watchdog auto-recovery)', item.jawaban_id);
            db.prepare(`
              UPDATE antrean_review
              SET status = 'selesai', completed_at = CURRENT_TIMESTAMP, error_message = 'Auto-recovered from stale lock'
              WHERE id = ?
            `).run(item.antrean_id);
            if (item.pengerjaan_id) {
              reviewService.recalculatePengerjaanTotal(item.pengerjaan_id);
            }
          } catch (healErr) {
            db.prepare(`UPDATE antrean_review SET status = 'menunggu' WHERE id = ?`).run(item.antrean_id);
            db.prepare(`UPDATE jawaban SET status_penilaian = 'menunggu' WHERE id = ?`).run(item.jawaban_id);
          }
        }
      }

      // Auto-heal butir gagal agar antrean tidak macet selamanya
      const failedItems = db.prepare(`
        SELECT a.id as antrean_id, j.id as jawaban_id, j.pengerjaan_id, j.jawaban_siswa, j.skor_maksimum,
               s.pertanyaan, s.jenis, s.bobot, s.kunci_jawaban, s.rubrik
        FROM antrean_review a
        JOIN jawaban j ON a.jawaban_id = j.id
        JOIN soal s ON j.soal_id = s.id
        JOIN pengerjaan p ON j.pengerjaan_id = p.id
        WHERE (a.status = 'gagal' OR j.status_penilaian = 'gagal')
          ${condition}
        LIMIT 5
      `).all(...params);

      if (failedItems.length > 0) {
        const geminiService = require('./geminiService');
        const reviewService = require('./reviewService');
        for (const item of failedItems) {
          try {
            const fb = geminiService.fallbackOfflineEvaluation({
              pertanyaan: item.pertanyaan,
              kunci_jawaban: item.kunci_jawaban || '',
              rubrik: item.rubrik || '',
              jawaban_siswa: item.jawaban_siswa || '',
              bobot: item.bobot,
              skor_maksimum: item.skor_maksimum,
              jenis: item.jenis
            });
            db.prepare(`
              UPDATE jawaban
              SET skor_rekomendasi = ?, status_jawaban = ?, alasan_ai = ?, model_ai = 'fallback_offline', status_penilaian = 'selesai', reviewed_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(fb.skor_rekomendasi, fb.status_jawaban, (fb.alasan_ai || '') + ' (Auto-recovery)', item.jawaban_id);
            db.prepare(`
              UPDATE antrean_review
              SET status = 'selesai', completed_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(item.antrean_id);
            if (item.pengerjaan_id) {
              reviewService.recalculatePengerjaanTotal(item.pengerjaan_id);
            }
          } catch (healErr) {}
        }
      }
    } catch (e) {
      console.warn('⚠️ Recover stale locks warning:', e.message);
    }
  },

  // FR-09: Masukkan jawaban ke dalam antrean (opsional: forceAll untuk menilai ulang seluruhnya)
  enqueueUlangan(ulanganId, options = {}) {
    const forceAll = typeof options === 'boolean' ? options : Boolean(options && options.forceAll);
    this.recoverStaleLocks(ulanganId);

    if (forceAll) {
      // Reset seluruh jawaban yang sudah submitted agar dinilai ulang dari awal oleh AI
      db.prepare(`
        UPDATE jawaban
        SET status_penilaian = 'menunggu', attempt_count = 0, last_error = NULL
        WHERE pengerjaan_id IN (
          SELECT id FROM pengerjaan WHERE ulangan_id = ? AND status = 'submitted'
        )
      `).run(ulanganId);

      db.prepare(`
        INSERT OR IGNORE INTO antrean_review (jawaban_id, status, attempt_count)
        SELECT j.id, 'menunggu', 0
        FROM jawaban j
        JOIN pengerjaan p ON j.pengerjaan_id = p.id
        WHERE p.ulangan_id = ? AND p.status = 'submitted'
      `).run(ulanganId);

      db.prepare(`
        UPDATE antrean_review
        SET status = 'menunggu', attempt_count = 0, next_attempt_at = NULL, error_message = NULL
        WHERE jawaban_id IN (
          SELECT j.id
          FROM jawaban j
          JOIN pengerjaan p ON j.pengerjaan_id = p.id
          WHERE p.ulangan_id = ? AND p.status = 'submitted'
        )
      `).run(ulanganId);

      if (typeof db.syncCloud === 'function') {
        db.syncCloud(true);
      }
      return this.getQueueStatus(ulanganId);
    }

    // Ambil semua jawaban dari pengerjaan yang sudah di-submit untuk ulangan ini yang belum dinilai
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

    // Ambil butir antrean yang saat ini sedang aktif dievaluasi (status 'diproses')
    let activeItem = null;
    try {
      activeItem = db.prepare(`
        SELECT a.id as antrean_id, j.id as jawaban_id, j.pengerjaan_id,
               pes.nama as nama_siswa, pes.kelas as kelas_siswa,
               s.nomor as nomor_soal, s.jenis as jenis_soal
        FROM antrean_review a
        JOIN jawaban j ON a.jawaban_id = j.id
        JOIN pengerjaan p ON j.pengerjaan_id = p.id
        JOIN peserta pes ON p.peserta_id = pes.id
        JOIN soal s ON j.soal_id = s.id
        WHERE p.ulangan_id = ? AND a.status = 'diproses'
        ORDER BY a.locked_at DESC
        LIMIT 1
      `).get(ulanganId);
    } catch (eActive) {}

    // Ambil urutan seluruh siswa yang sedang mengantre penilaian AI (FIFO)
    let waitingStudents = [];
    try {
      waitingStudents = db.prepare(`
        SELECT 
          p.id as pengerjaan_id,
          pes.nama as nama_siswa,
          pes.kelas as kelas_siswa,
          COALESCE(p.submitted_at, p.started_at) as submitted_at,
          COUNT(j.id) as total_butir,
          SUM(CASE WHEN j.status_penilaian = 'selesai' THEN 1 ELSE 0 END) as selesai_butir,
          SUM(CASE WHEN j.status_penilaian = 'diproses' THEN 1 ELSE 0 END) as diproses_butir,
          SUM(CASE WHEN j.status_penilaian = 'menunggu' THEN 1 ELSE 0 END) as menunggu_butir
        FROM pengerjaan p
        JOIN peserta pes ON p.peserta_id = pes.id
        JOIN jawaban j ON j.pengerjaan_id = p.id
        WHERE p.ulangan_id = ? AND p.status = 'submitted'
        GROUP BY p.id, pes.nama, pes.kelas, p.submitted_at, p.started_at
        HAVING SUM(CASE WHEN j.status_penilaian != 'selesai' THEN 1 ELSE 0 END) > 0
        ORDER BY COALESCE(p.submitted_at, p.started_at) ASC, p.id ASC
      `).all(ulanganId).map((row, idx) => ({
        urutan: idx + 1,
        pengerjaan_id: row.pengerjaan_id,
        nama_siswa: row.nama_siswa,
        kelas_siswa: row.kelas_siswa,
        total_butir: Number(row.total_butir) || 0,
        selesai_butir: Number(row.selesai_butir) || 0,
        diproses_butir: Number(row.diproses_butir) || 0,
        menunggu_butir: Number(row.menunggu_butir) || 0,
        isCurrentlyGraded: (activeItem && activeItem.pengerjaan_id === row.pengerjaan_id) || idx === 0
      }));
    } catch (eWait) {}

    const currentlyGrading = waitingStudents.length > 0 ? waitingStudents[0] : null;

    return {
      total: stats?.total || 0,
      selesai: stats?.selesai || 0,
      diproses: stats?.diproses || 0,
      menunggu: stats?.menunggu || 0,
      gagal: stats?.gagal || 0,
      isRunning: Boolean(workerState?.isRunning),
      activeItem: activeItem || null,
      currentlyGrading,
      waitingStudents: waitingStudents.slice(0, 10),
      totalWaitingStudents: waitingStudents.length
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

    // Strict Concurrency = 1: Cegah dual-evaluasi bersamaan agar CPU server & API AI tidak overload
    if (isCurrentlyGradingAnswer) {
      return {
        success: true,
        busy: true,
        message: 'AI sedang mengevaluasi jawaban sebelumnya secara antrean satu per satu.',
        status: this.getQueueStatus(id)
      };
    }

    try {
      const activeLock = db.prepare(`
        SELECT a.id 
        FROM antrean_review a
        JOIN jawaban j ON a.jawaban_id = j.id
        JOIN pengerjaan p ON j.pengerjaan_id = p.id
        WHERE p.ulangan_id = ?
          AND a.status = 'diproses' 
          AND a.locked_at IS NOT NULL 
          AND datetime(a.locked_at) >= datetime('now', '-25 seconds')
        LIMIT 1
      `).get(id);

      if (activeLock) {
        return {
          success: true,
          busy: true,
          message: 'AI sedang mengevaluasi jawaban sebelumnya secara antrean satu per satu.',
          status: this.getQueueStatus(id)
        };
      }
    } catch (eLock) {}

    // Ambil dan kunci 1 pekerjaan antrean tertua yang siap diproses secara atomik
    // PRIORITAS: Siswa yang submit duluan dinilai tuntas terlebih dahulu (FIFO per siswa)
    let queueItem = null;
    db.transaction(() => {
      queueItem = db.prepare(`
        SELECT a.id as antrean_id, a.jawaban_id, a.attempt_count,
               j.pengerjaan_id, j.jawaban_siswa, j.skor_maksimum,
               s.pertanyaan, s.jenis, s.bobot, s.kunci_jawaban, s.rubrik, s.tingkat_kelas, s.tingkat_kesulitan,
               s.pembahasan, s.audio_script, s.is_listening, s.bahasa,
               u.izinkan_singkatan, u.izinkan_informal, u.toleransi_typo, u.instruksi_penilaian_khusus,
               u.skor_langsung_ai
        FROM antrean_review a
        JOIN jawaban j ON a.jawaban_id = j.id
        JOIN soal s ON j.soal_id = s.id
        JOIN pengerjaan p ON j.pengerjaan_id = p.id
        JOIN ulangan u ON p.ulangan_id = u.id
        WHERE p.ulangan_id = ? 
          AND j.status_penilaian != 'selesai'
          AND (a.status = 'menunggu' OR (a.status = 'gagal' AND a.attempt_count < 3))
          AND (a.next_attempt_at IS NULL OR datetime(a.next_attempt_at) <= datetime('now'))
        ORDER BY COALESCE(p.submitted_at, p.started_at) ASC, p.id ASC, a.attempt_count ASC, a.id ASC
        LIMIT 1
      `).get(id);

      if (queueItem) {
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
      }
    })();

    if (!queueItem) {
      return {
        success: true,
        done: true,
        message: 'Semua jawaban selesai dinilai atau antrean kosong',
        status: this.getQueueStatus(id)
      };
    }

    isCurrentlyGradingAnswer = true;
    try {
      // Jeda AI antar user (pacing) agar antrean adil dan memberi nafas pada server & AI API
      const isTestEnv = process.env.NODE_ENV === 'test' || process.argv.some(arg => arg.includes('test'));
      const pacingDelay = isTestEnv ? 0 : 800;
      if (pacingDelay > 0 && lastProcessedPengerjaanId !== null && lastProcessedPengerjaanId !== queueItem.pengerjaan_id) {
        await new Promise(resolve => setTimeout(resolve, pacingDelay));
      }
      lastProcessedPengerjaanId = queueItem.pengerjaan_id;

      let result;
      if (gradeFunction) {
        result = await gradeFunction(queueItem);
      } else {
        const geminiService = require('./geminiService');
        try {
          result = await geminiService.gradeAnswer(queueItem);
        } catch (aiErr) {
          // Jaring Pengaman Anti-Stuck: Jika API Gemini timeout, 429 rate limit, atau server offline,
          // langsung evaluasi semantik offline agar antrean siswa berikutnya tidak tertahan!
          console.warn(`[GEMINI GRADING NOTICE] Butir #${queueItem.jawaban_id} gagal dinilai online (${aiErr.message}). Menggunakan evaluasi offline darurat.`);
          result = geminiService.fallbackOfflineEvaluation(queueItem);
        }
      }

      let normalizedStatus = result.status_jawaban;
      if (!['benar', 'parsial', 'salah', 'perlu_review'].includes(normalizedStatus)) {
        if (normalizedStatus === 'sebagian') normalizedStatus = 'parsial';
        else normalizedStatus = 'perlu_review';
      }

      const maxBobot = Number(queueItem.bobot) || 1;
      const rawSkor = Number(result.skor_rekomendasi ?? 0);
      const clampedScore = Math.max(0, Math.min(maxBobot, Math.round(rawSkor * 100) / 100));

      // Simpan hasil penilaian yang berhasil
      db.transaction(() => {
        db.prepare(`
          UPDATE jawaban
          SET status_penilaian = 'selesai',
              skor_rekomendasi = ?,
              skor_maksimum = ?,
              status_jawaban = ?,
              alasan_ai = ?,
              model_ai = ?,
              reviewed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          clampedScore,
          maxBobot,
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
      // Jika skor_langsung_ai = 1 dan seluruh soal pengerjaan ini selesai, recalculatePengerjaanTotal otomatis merilis nilai
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

      if (newAttempt >= maxRetry) {
        // FAILOVER OTOMATIS: Jangan biarkan antrean macet selamanya!
        // Jika AI gagal 3x, otomatis evaluasi dengan fallback offline
        try {
          const geminiService = require('./geminiService');
          const fb = geminiService.fallbackOfflineEvaluation({
            pertanyaan: queueItem.pertanyaan,
            kunci_jawaban: queueItem.kunci_jawaban || '',
            rubrik: queueItem.rubrik || '',
            jawaban_siswa: queueItem.jawaban_siswa || '',
            bobot: queueItem.bobot,
            skor_maksimum: queueItem.skor_maksimum,
            jenis: queueItem.jenis
          });

          db.transaction(() => {
            db.prepare(`
              UPDATE jawaban
              SET skor_rekomendasi = ?,
                  status_jawaban = ?,
                  alasan_ai = ?,
                  model_ai = 'fallback_offline',
                  status_penilaian = 'selesai',
                  reviewed_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(
              fb.skor_rekomendasi,
              fb.status_jawaban,
              (fb.alasan_ai || 'Penilaian otomatis cadangan.') + ' (Fallback offline AI limit/timeout)',
              queueItem.jawaban_id
            );

            db.prepare(`
              UPDATE antrean_review
              SET status = 'selesai', completed_at = CURRENT_TIMESTAMP, error_message = 'Fallback offline sukses'
              WHERE id = ?
            `).run(queueItem.antrean_id);
          })();

          try {
            const reviewService = require('./reviewService');
            if (queueItem.pengerjaan_id) {
              reviewService.recalculatePengerjaanTotal(queueItem.pengerjaan_id);
            }
          } catch (eRec) {}

          console.log(`[QUEUE FAILOVER] Butir jawaban ID ${queueItem.jawaban_id} dievaluasi otomatis via offline fallback agar antrean AI tidak stuck.`);
        } catch (fbErr) {
          console.warn('[QUEUE FAILOVER ERROR]', fbErr.message);
        }
      } else {
        // Adaptive delay jika terjadi rate limit (FR-12 & NFR-05)
        const retrySeconds = isRateLimit ? 15 : 8;

        db.transaction(() => {
          db.prepare(`
            UPDATE antrean_review
            SET status = 'menunggu',
                attempt_count = ?,
                next_attempt_at = datetime('now', '+' || ? || ' seconds'),
                error_message = ?
            WHERE id = ?
          `).run(newAttempt, retrySeconds, String(err.message), queueItem.antrean_id);

          db.prepare(`
            UPDATE jawaban
            SET status_penilaian = 'menunggu',
                attempt_count = ?,
                last_error = ?
            WHERE id = ?
          `).run(newAttempt, String(err.message), queueItem.jawaban_id);
        })();
      }

      if (typeof db.syncCloud === 'function') {
        db.syncCloud(true);
      }

      return {
        success: false,
        done: false,
        isRateLimit,
        jawaban_id: queueItem.jawaban_id,
        error: String(err.message),
        status: this.getQueueStatus(id)
      };
    } finally {
      isCurrentlyGradingAnswer = false;
    }
  },

  // Pemrosesan antrean bertahap otomatis (Serverless-safe & Anti-Rate-Limit)
  // Dipanggil saat siswa menunggu skor langsung AI di halaman hasil ujian
  async tickAutoQueueIfDue(ulanganId, options = {}) {
    const id = Number(ulanganId);
    if (!id) return { skipped: true, reason: 'invalid_id' };

    // Jika background worker lokal sudah aktif untuk ulangan ini, biarkan worker yang memproses
    if (runningWorkers.get(id)?.isRunning && !options.forceStep) {
      return { skipped: true, reason: 'worker_running' };
    }

    if (isCurrentlyGradingAnswer && !options.forceStep) {
      return { skipped: true, reason: 'concurrency_lock' };
    }

    const isTestEnv = process.env.NODE_ENV === 'test' || process.argv.some(arg => arg.includes('test'));
    const minIntervalMs = options.minIntervalMs !== undefined ? Number(options.minIntervalMs) : (isTestEnv ? 0 : 2200);
    const now = Date.now();

    if (minIntervalMs > 0 && (now - lastAutoTickAt) < minIntervalMs) {
      return { skipped: true, reason: 'throttled_memory' };
    }

    // Pastikan tidak ada item antrean yang saat ini sedang aktif dievaluasi (< 5 detik)
    if (minIntervalMs > 0) {
      try {
        const recentActivity = db.prepare(`
          SELECT id FROM antrean_review
          WHERE status = 'diproses' AND locked_at IS NOT NULL AND datetime(locked_at) >= datetime('now', '-5 seconds')
          LIMIT 1
        `).get();
        if (recentActivity) {
          return { skipped: true, reason: 'throttled_db' };
        }
      } catch (e) {}
    }

    lastAutoTickAt = now;

    // Pastikan jawaban submitted yang belum masuk antrean_review sudah di-enqueue
    try {
      this.enqueueUlangan(id, { forceAll: false });
    } catch (e) {}

    return await this.processNextAnswer(id, options.gradeFunction || null);
  },

  // FR-10, FR-11, FR-12, FR-13: Jalankan worker antrean
  async startReview(ulanganId, gradeFunction = null, delayOverride = null, options = {}) {
    const id = Number(ulanganId);
    const forceAll = Boolean(options?.forceAll);
    const mode = options?.mode || 'background';

    // Enqueue jawaban baru jika ada (atau reset seluruhnya jika forceAll = true)
    this.enqueueUlangan(id, { forceAll });

    const currentStatus = this.getQueueStatus(id);

    // Jika mode adalah 'step' (digunakan oleh browser UI guru.html),
    // jangan jalankan background worker loop agar tidak terjadi bentrokan dual-worker
    if (mode === 'step') {
      return {
        success: true,
        message: 'Antrean AI siap diproses',
        status: currentStatus
      };
    }

    // Mode background: Pastikan tidak ada 2 worker aktif bersamaan untuk ulangan yang sama (NFR-02)
    if (runningWorkers.get(id)?.isRunning) {
      return { success: false, message: 'Review sedang berjalan', status: currentStatus };
    }

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
      status: currentStatus
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
    
    if (pengerjaan.status !== 'submitted') {
      // Periksa apakah siswa sudah memiliki draf jawaban yang terisi
      const hasDraft = db.prepare("SELECT id FROM jawaban WHERE pengerjaan_id = ? AND jawaban_siswa IS NOT NULL AND TRIM(jawaban_siswa) != '' LIMIT 1").get(pengerjaanId);
      if (!hasDraft) {
        throw new Error('Ujian belum dikumpulkan dan belum ada jawaban yang terisi');
      }
      // Finalisasi pengerjaan siswa secara otomatis oleh guru agar siap dinilai
      const nowIso = new Date().toISOString();
      db.prepare("UPDATE pengerjaan SET status = 'submitted', submitted_at = ?, auto_submitted = 1 WHERE id = ?").run(nowIso, pengerjaanId);
      pengerjaan.status = 'submitted';
    }

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

        const maxBobot = Number(queueItem.bobot) || 1;
        const rawSkor = Number(result.skor_rekomendasi ?? 0);
        const clampedScore = Math.max(0, Math.min(maxBobot, Math.round(rawSkor * 100) / 100));

        db.transaction(() => {
          db.prepare(`
            UPDATE jawaban
            SET status_penilaian = 'selesai',
                skor_rekomendasi = ?,
                skor_maksimum = ?,
                status_jawaban = ?,
                alasan_ai = ?,
                model_ai = ?,
                reviewed_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            clampedScore,
            maxBobot,
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
        const delayMs = delayOverride !== null ? delayOverride : 50;
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
