const db = require('../config/database');
const examService = require('./examService');

const studentService = {
  // FR-06: Validasi Kode Ulangan
  validateExamCode(kodeUjian) {
    if (!kodeUjian || typeof kodeUjian !== 'string') {
      return { valid: false, message: 'Kode ulangan tidak boleh kosong' };
    }

    const cleanCode = kodeUjian.trim().toUpperCase();
    const ulangan = db.prepare('SELECT id, judul, mata_pelajaran, tingkat_kelas, deskripsi, status, jumlah_soal_tampil, jumlah_soal_isian, jumlah_soal_essay, acak_soal, tanggal_mulai, tanggal_selesai, durasi_menit, kkm, zona_waktu FROM ulangan WHERE kode_ujian = ?').get(cleanCode);

    if (!ulangan) {
      return { valid: false, message: 'Kode ulangan tidak ditemukan' };
    }

    if (ulangan.status !== 'dibuka') {
      let msg = 'Ulangan ini belum dibuka oleh guru';
      if (ulangan.status === 'ditutup' || ulangan.status === 'selesai') {
        msg = 'Ulangan ini sudah ditutup dan tidak menerima pengerjaan baru';
      }
      return { valid: false, status: ulangan.status, message: msg };
    }

    const now = new Date();
    const zw = ulangan.zona_waktu || 'WIB';

    if (ulangan.tanggal_mulai) {
      const startTime = new Date(ulangan.tanggal_mulai);
      if (now < startTime) {
        const scheduleStr = examService.formatIndonesianDateTime(ulangan.tanggal_mulai, zw);
        const serverNowStr = examService.formatIndonesianDateTime(now.toISOString(), zw);
        return {
          valid: false,
          status: 'belum_buka',
          tanggal_mulai: ulangan.tanggal_mulai,
          zona_waktu: zw,
          server_time: now.toISOString(),
          message: `Ulangan belum dibuka. Jadwal buka: ${scheduleStr} (Waktu server saat ini: ${serverNowStr})`
        };
      }
    }

    if (ulangan.tanggal_selesai) {
      const endTime = new Date(ulangan.tanggal_selesai);
      if (now > endTime) {
        const scheduleStr = examService.formatIndonesianDateTime(ulangan.tanggal_selesai, zw);
        return {
          valid: false,
          status: 'sudah_tutup',
          tanggal_selesai: ulangan.tanggal_selesai,
          zona_waktu: zw,
          server_time: now.toISOString(),
          message: `Ulangan telah ditutup pada: ${scheduleStr}`
        };
      }
    }

    // Hitung total soal & total bobot tanpa membocorkan soal
    const stats = db.prepare('SELECT COUNT(*) as total_soal, COALESCE(SUM(bobot), 0) as total_bobot FROM soal WHERE ulangan_id = ?').get(ulangan.id);

    // Ambil daftar kelas yang ditautkan ke ulangan ini, atau seluruh kelas guru jika belum dispesifikasi
    let kelasList = db.prepare(`
      SELECT k.nama_kelas 
      FROM ulangan_kelas uk 
      JOIN kelas k ON uk.kelas_id = k.id 
      WHERE uk.ulangan_id = ? 
      ORDER BY k.nama_kelas ASC
    `).all(ulangan.id).map(k => k.nama_kelas);

    if (kelasList.length === 0) {
      // Fallback: ambil semua kelas yang dibuat guru pemilik ulangan
      const teacherId = db.prepare('SELECT guru_id FROM ulangan WHERE id = ?').get(ulangan.id)?.guru_id;
      if (teacherId) {
        kelasList = db.prepare('SELECT nama_kelas FROM kelas WHERE guru_id = ? ORDER BY nama_kelas ASC').all(teacherId).map(k => k.nama_kelas);
      }
    }

    const soalDikerjakan = (ulangan.jumlah_soal_tampil && ulangan.jumlah_soal_tampil < stats.total_soal)
      ? ulangan.jumlah_soal_tampil
      : stats.total_soal;

    return {
      valid: true,
      ulangan: {
        id: ulangan.id,
        judul: ulangan.judul,
        mata_pelajaran: ulangan.mata_pelajaran,
        tingkat_kelas: ulangan.tingkat_kelas,
        deskripsi: ulangan.deskripsi,
        total_soal: stats.total_soal,
        soal_dikerjakan: soalDikerjakan,
        total_bobot: stats.total_bobot,
        jumlah_soal_tampil: ulangan.jumlah_soal_tampil,
        jumlah_soal_isian: ulangan.jumlah_soal_isian,
        jumlah_soal_essay: ulangan.jumlah_soal_essay,
        acak_soal: ulangan.acak_soal,
        tanggal_mulai: ulangan.tanggal_mulai,
        tanggal_selesai: ulangan.tanggal_selesai,
        durasi_menit: ulangan.durasi_menit,
        kkm: ulangan.kkm || 75,
        zona_waktu: ulangan.zona_waktu || 'WIB',
        available_classes: kelasList
      }
    };
  },

  // FR-07: Identitas Siswa & Memulai Pengerjaan (Mendukung Paket Soal Acak per Siswa)
  startExam(kodeUjian, nama, kelas) {
    const val = this.validateExamCode(kodeUjian);
    if (!val.valid) {
      throw new Error(val.message);
    }

    if (!nama || !nama.trim()) {
      throw new Error('Nama siswa wajib diisi');
    }
    if (!kelas || !kelas.trim()) {
      throw new Error('Kelas siswa wajib diisi');
    }

    const cleanNama = nama.trim();
    const cleanKelas = kelas.trim();
    const ulanganId = val.ulangan.id;

    // Cek apakah peserta sudah pernah mengerjakan ulangan ini
    let peserta = db.prepare('SELECT id FROM peserta WHERE ulangan_id = ? AND LOWER(nama) = LOWER(?) AND LOWER(kelas) = LOWER(?)').get(ulanganId, cleanNama, cleanKelas);

    if (!peserta) {
      const pInfo = db.prepare('INSERT INTO peserta (ulangan_id, nama, kelas) VALUES (?, ?, ?)').run(ulanganId, cleanNama, cleanKelas);
      peserta = { id: pInfo.lastInsertRowid };
    }

    // Cek pengerjaan aktif atau submitted
    let pengerjaan = db.prepare('SELECT * FROM pengerjaan WHERE ulangan_id = ? AND peserta_id = ?').get(ulanganId, peserta.id);

    if (pengerjaan && pengerjaan.status === 'submitted') {
      return {
        alreadySubmitted: true,
        pengerjaanId: pengerjaan.id,
        submittedAt: pengerjaan.submitted_at,
        releasedAt: pengerjaan.released_at,
        nilaiFinal: pengerjaan.nilai_final,
        message: 'Anda sudah mengumpulkan ulangan ini sebelumnya.'
      };
    }

    // Periksa apakah siswa sudah memiliki paket soal yang telah ditetapkan sebelumnya
    let assignedQuestionIds = null;
    if (pengerjaan && pengerjaan.soal_ids) {
      try {
        assignedQuestionIds = JSON.parse(pengerjaan.soal_ids);
      } catch (e) {
        assignedQuestionIds = null;
      }
    }

    const ulanganInfo = db.prepare('SELECT jumlah_soal_tampil, jumlah_soal_isian, jumlah_soal_essay, acak_soal FROM ulangan WHERE id = ?').get(ulanganId);
    let soalList = [];

    if (Array.isArray(assignedQuestionIds) && assignedQuestionIds.length > 0) {
      // Siswa sudah memulai sebelumnya: muat soal yang sama persis (persisten / anti-refresh)
      const placeholders = assignedQuestionIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT id, nomor, jenis, pertanyaan, gambar_url, bobot, tingkat_kelas, urutan
        FROM soal
        WHERE id IN (${placeholders})
      `).all(...assignedQuestionIds);

      const rowMap = new Map(rows.map(r => [r.id, r]));
      soalList = assignedQuestionIds.map(id => rowMap.get(id)).filter(Boolean);
    } else {
      // Pengerjaan baru: ambil semua soal dari bank soal
      const allQuestions = db.prepare(`
        SELECT id, nomor, jenis, pertanyaan, gambar_url, bobot, tingkat_kelas, urutan
        FROM soal
        WHERE ulangan_id = ?
        ORDER BY urutan ASC, nomor ASC
      `).all(ulanganId);

      const limitSoal = ulanganInfo?.jumlah_soal_tampil;
      const targetIsian = ulanganInfo?.jumlah_soal_isian;
      const targetEssay = ulanganInfo?.jumlah_soal_essay;
      const hasSpecificQuota = (targetIsian !== null && targetIsian !== undefined && targetIsian > 0) ||
                               (targetEssay !== null && targetEssay !== undefined && targetEssay > 0);
      const isAcak = (ulanganInfo?.acak_soal === 1);
      const needRandom = isAcak || (limitSoal && limitSoal < allQuestions.length) || hasSpecificQuota;

      if (hasSpecificQuota) {
        // Kuota wajib per jenis soal: pisahkan bank isian dan essay
        const isianPool = allQuestions.filter(q => q.jenis === 'isian');
        const essayPool = allQuestions.filter(q => q.jenis === 'essay');

        const shuffleArr = (arr) => {
          const res = [...arr];
          for (let i = res.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [res[i], res[j]] = [res[j], res[i]];
          }
          return res;
        };

        const readyIsian = (isAcak || (targetIsian && targetIsian < isianPool.length)) ? shuffleArr(isianPool) : [...isianPool];
        const readyEssay = (isAcak || (targetEssay && targetEssay < essayPool.length)) ? shuffleArr(essayPool) : [...essayPool];

        let selectedIsian = [];
        if (targetIsian !== null && targetIsian !== undefined && targetIsian > 0) {
          selectedIsian = readyIsian.slice(0, Math.min(targetIsian, readyIsian.length));
        }

        let selectedEssay = [];
        if (targetEssay !== null && targetEssay !== undefined && targetEssay > 0) {
          selectedEssay = readyEssay.slice(0, Math.min(targetEssay, readyEssay.length));
        }

        let combined = [...selectedIsian, ...selectedEssay];

        // Jika ada limitSoal total yang lebih besar dari targetIsian + targetEssay, lengkapi sisa kuota
        if (limitSoal && limitSoal > combined.length) {
          const chosenIds = new Set(combined.map(s => s.id));
          const unchosen = allQuestions.filter(q => !chosenIds.has(q.id));
          const remainingPool = isAcak ? shuffleArr(unchosen) : unchosen;
          const needed = limitSoal - combined.length;
          combined.push(...remainingPool.slice(0, needed));
        } else if (limitSoal && limitSoal < combined.length) {
          combined = combined.slice(0, limitSoal);
        }

        soalList = combined;
      } else if (needRandom) {
        // Fisher-Yates shuffle untuk mengacak paket soal
        const shuffled = [...allQuestions];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        if (limitSoal && limitSoal < shuffled.length) {
          soalList = shuffled.slice(0, limitSoal);
        } else {
          soalList = shuffled;
        }
      } else {
        if (limitSoal && limitSoal < allQuestions.length) {
          soalList = allQuestions.slice(0, limitSoal);
        } else {
          soalList = allQuestions;
        }
      }

      assignedQuestionIds = soalList.map(s => s.id);
      const soalIdsJson = JSON.stringify(assignedQuestionIds);

      const nowIso = new Date().toISOString();
      if (!pengerjaan) {
        const info = db.prepare(`
          INSERT INTO pengerjaan (ulangan_id, peserta_id, status, soal_ids, started_at)
          VALUES (?, ?, 'mengerjakan', ?, ?)
        `).run(ulanganId, peserta.id, soalIdsJson, nowIso);
        pengerjaan = db.prepare('SELECT * FROM pengerjaan WHERE id = ?').get(info.lastInsertRowid);
      } else {
        db.prepare('UPDATE pengerjaan SET soal_ids = ? WHERE id = ?').run(soalIdsJson, pengerjaan.id);
        pengerjaan.soal_ids = soalIdsJson;
      }
    }

    // Berikan nomor urut tampilan yang rapi 1..N
    const displaySoalList = soalList.map((s, idx) => ({
      ...s,
      nomor: idx + 1
    }));

    // Hitung batas waktu deadline pengerjaan siswa
    let deadlineAt = null;
    const startedAtStr = pengerjaan.started_at
      ? (pengerjaan.started_at.includes('T') ? pengerjaan.started_at : pengerjaan.started_at.replace(' ', 'T') + 'Z')
      : new Date().toISOString();
    const startedAt = new Date(startedAtStr);

    if (val.ulangan.durasi_menit) {
      const durationDeadline = new Date(startedAt.getTime() + val.ulangan.durasi_menit * 60 * 1000);
      deadlineAt = durationDeadline;
    }

    if (val.ulangan.tanggal_selesai) {
      const closeDeadline = new Date(val.ulangan.tanggal_selesai);
      if (!deadlineAt || closeDeadline < deadlineAt) {
        deadlineAt = closeDeadline;
      }
    }

    return {
      alreadySubmitted: false,
      pengerjaanId: pengerjaan.id,
      peserta: { id: peserta.id, nama: cleanNama, kelas: cleanKelas },
      ulangan: val.ulangan,
      deadline_at: deadlineAt ? deadlineAt.toISOString() : null,
      server_time: new Date().toISOString(),
      soal: displaySoalList
    };
  },

  // FR-08 & NFR-01: Submit Seluruh Jawaban Siswa
  submitExam(pengerjaanId, rawAnswers, pasteCount = 0, isAutoSubmit = false) {
    const pengerjaan = db.prepare('SELECT * FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    if (!pengerjaan) {
      throw new Error('Data pengerjaan tidak ditemukan');
    }

    if (pengerjaan.status === 'submitted') {
      return { success: true, message: 'Ulangan sudah dikumpulkan sebelumnya', submitted_at: pengerjaan.submitted_at };
    }

    // Ambil daftar soal yang ditugaskan secara spesifik untuk pengerjaan siswa ini
    let assignedIds = null;
    if (pengerjaan.soal_ids) {
      try {
        assignedIds = JSON.parse(pengerjaan.soal_ids);
      } catch (e) {
        assignedIds = null;
      }
    }

    let soalList;
    if (Array.isArray(assignedIds) && assignedIds.length > 0) {
      const placeholders = assignedIds.map(() => '?').join(',');
      soalList = db.prepare(`SELECT id, bobot FROM soal WHERE id IN (${placeholders})`).all(...assignedIds);
    } else {
      soalList = db.prepare('SELECT id, bobot FROM soal WHERE ulangan_id = ?').all(pengerjaan.ulangan_id);
    }
    const soalMap = new Map(soalList.map(s => [s.id, s.bobot]));

    // Format jawaban
    const answers = Array.isArray(rawAnswers) ? rawAnswers : [];
    const submittedMap = new Map();
    for (const a of answers) {
      if (a && a.soal_id) {
        submittedMap.set(Number(a.soal_id), String(a.jawaban_siswa || ''));
      }
    }

    // Transaksi penyimpanan jawaban agar atomik
    const insertOrUpdateJawaban = db.transaction(() => {
      const checkStmt = db.prepare('SELECT id FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?');
      const updateStmt = db.prepare(`
        UPDATE jawaban 
        SET jawaban_siswa = ?, skor_maksimum = ?, status_penilaian = 'menunggu'
        WHERE id = ?
      `);
      const insertStmt = db.prepare(`
        INSERT INTO jawaban (pengerjaan_id, soal_id, jawaban_siswa, skor_maksimum, status_penilaian)
        VALUES (?, ?, ?, ?, 'menunggu')
      `);

      for (const [soalId, bobot] of soalMap.entries()) {
        const jawabanText = submittedMap.get(soalId) || '';
        const existing = checkStmt.get(pengerjaanId, soalId);

        if (existing) {
          updateStmt.run(jawabanText, bobot, existing.id);
        } else {
          insertStmt.run(pengerjaanId, soalId, jawabanText, bobot);
        }
      }

      // Update status pengerjaan ke submitted & catat paste_count dan auto_submitted
      db.prepare(`
        UPDATE pengerjaan 
        SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP, paste_count = ?, auto_submitted = ?
        WHERE id = ?
      `).run(Number(pasteCount) || 0, isAutoSubmit ? 1 : 0, pengerjaanId);
    });

    insertOrUpdateJawaban();

    const updated = db.prepare('SELECT submitted_at FROM pengerjaan WHERE id = ?').get(pengerjaanId);

    return {
      success: true,
      message: 'Jawaban berhasil dikumpulkan',
      submitted_at: updated.submitted_at
    };
  },

  // Cek status pengerjaan untuk siswa
  getPengerjaanStatus(pengerjaanId) {
    const pengerjaan = db.prepare(`
      SELECT p.*, u.judul, u.mata_pelajaran, u.status as status_ulangan, u.kkm, u.kode_ujian,
             u.instruksi_remedial, u.link_remedial, pes.nama, pes.kelas,
             g.nama as nama_guru, g.email as email_guru, g.no_wa as no_wa_guru
      FROM pengerjaan p
      JOIN ulangan u ON p.ulangan_id = u.id
      JOIN guru g ON u.guru_id = g.id
      JOIN peserta pes ON p.peserta_id = pes.id
      WHERE p.id = ?
    `).get(pengerjaanId);

    if (!pengerjaan) return null;

    const isReleased = Boolean(pengerjaan.released_at);
    const examKkm = pengerjaan.kkm || 75;
    const finalScore = isReleased ? (pengerjaan.nilai_final !== null ? pengerjaan.nilai_final : pengerjaan.nilai_ai) : null;
    const isRemedial = Boolean(isReleased && finalScore !== null && finalScore < examKkm);

    // Normalisasi nomor WA untuk link wa.me
    let cleanWa = (pengerjaan.no_wa_guru || '').replace(/\D/g, '');
    if (cleanWa.startsWith('0')) cleanWa = '62' + cleanWa.slice(1);
    const waLink = cleanWa ? `https://wa.me/${cleanWa}?text=${encodeURIComponent(
      `Halo Bapak/Ibu ${pengerjaan.nama_guru || 'Guru'}, saya ${pengerjaan.nama} (${pengerjaan.kelas}) ingin meminta arahan remedial dan token ujian baru untuk ulangan "${pengerjaan.judul}". Terima kasih.`
    )}` : null;

    // Ambil jawaban
    let jawabanList = [];
    let rekapNilaiKelas = [];

    if (isReleased) {
      jawabanList = db.prepare(`
        SELECT j.id, j.soal_id, j.jawaban_siswa, j.skor_rekomendasi, j.skor_maksimum, 
               j.status_jawaban, j.alasan_ai, s.pertanyaan, s.gambar_url, s.nomor, s.jenis, s.kunci_jawaban,
               rg.skor_final, rg.catatan_guru
        FROM jawaban j
        JOIN soal s ON j.soal_id = s.id
        LEFT JOIN review_guru rg ON j.id = rg.jawaban_id
        WHERE j.pengerjaan_id = ?
        ORDER BY s.urutan ASC, s.nomor ASC
      `).all(pengerjaanId);

      // Ambil seluruh rekap nilai peserta yang sudah dirilis pada ulangan ini untuk tabel leaderboard
      rekapNilaiKelas = db.prepare(`
        SELECT 
          pes.id as peserta_id,
          pes.nama as nama_siswa,
          pes.kelas as kelas_siswa,
          p2.id as pengerjaan_id,
          p2.nilai_final,
          p2.nilai_ai,
          p2.auto_submitted
        FROM pengerjaan p2
        JOIN peserta pes ON p2.peserta_id = pes.id
        WHERE p2.ulangan_id = ? AND p2.status = 'submitted' AND p2.released_at IS NOT NULL
        ORDER BY COALESCE(p2.nilai_final, p2.nilai_ai, 0) DESC, pes.nama ASC
      `).all(pengerjaan.ulangan_id).map((r, idx) => {
        const score = r.nilai_final !== null ? r.nilai_final : (r.nilai_ai !== null ? r.nilai_ai : 0);
        return {
          ranking: idx + 1,
          pesertaId: r.peserta_id,
          nama: r.nama_siswa,
          kelas: r.kelas_siswa,
          nilai: score,
          isCurrentStudent: r.pengerjaan_id === pengerjaan.id,
          isTuntas: score >= examKkm,
          autoSubmitted: Boolean(r.auto_submitted)
        };
      });
    }

    return {
      pengerjaanId: pengerjaan.id,
      nama: pengerjaan.nama,
      kelas: pengerjaan.kelas,
      judul: pengerjaan.judul,
      mataPelajaran: pengerjaan.mata_pelajaran,
      kodeUjian: pengerjaan.kode_ujian,
      status: pengerjaan.status,
      submittedAt: pengerjaan.submitted_at,
      isReleased,
      releasedAt: pengerjaan.released_at,
      kkm: examKkm,
      nilaiFinal: finalScore,
      isRemedial,
      instruksi_remedial: pengerjaan.instruksi_remedial || null,
      link_remedial: pengerjaan.link_remedial || null,
      guru: {
        nama: pengerjaan.nama_guru,
        email: pengerjaan.email_guru,
        no_wa: pengerjaan.no_wa_guru,
        wa_link: waLink
      },
      jawaban: jawabanList,
      rekapNilaiKelas
    };
  },

  // Riwayat pengerjaan seluruh ulangan siswa urut tanggal terbaru ke lama (descending)
  getStudentExamHistory(pengerjaanId) {
    const current = db.prepare(`
      SELECT pes.nama, pes.kelas 
      FROM pengerjaan p 
      JOIN peserta pes ON p.peserta_id = pes.id 
      WHERE p.id = ?
    `).get(pengerjaanId);

    if (!current) return [];

    const history = db.prepare(`
      SELECT 
        p.id as pengerjaan_id,
        p.ulangan_id,
        p.status,
        p.started_at,
        p.submitted_at,
        p.nilai_final,
        p.nilai_ai,
        p.released_at,
        u.judul,
        u.mata_pelajaran,
        u.kode_ujian,
        u.kkm,
        u.instruksi_remedial,
        u.link_remedial,
        g.nama as nama_guru,
        g.email as email_guru,
        g.no_wa as no_wa_guru
      FROM pengerjaan p
      JOIN peserta pes ON p.peserta_id = pes.id
      JOIN ulangan u ON p.ulangan_id = u.id
      JOIN guru g ON u.guru_id = g.id
      WHERE LOWER(pes.nama) = LOWER(?) AND LOWER(pes.kelas) = LOWER(?) AND p.status = 'submitted'
      ORDER BY COALESCE(p.submitted_at, p.started_at) DESC, p.id DESC
    `).all(current.nama, current.kelas);

    return history.map(item => {
      const isReleased = Boolean(item.released_at);
      const kkm = item.kkm || 75;
      const finalScore = isReleased ? (item.nilai_final !== null ? item.nilai_final : item.nilai_ai) : null;
      const isRemedial = Boolean(isReleased && finalScore !== null && finalScore < kkm);

      let cleanWa = (item.no_wa_guru || '').replace(/\D/g, '');
      if (cleanWa.startsWith('0')) cleanWa = '62' + cleanWa.slice(1);
      const waLink = cleanWa ? `https://wa.me/${cleanWa}?text=${encodeURIComponent(
        `Halo Bapak/Ibu ${item.nama_guru || 'Guru'}, saya ${current.nama} (${current.kelas}) ingin meminta arahan remedial dan token ujian baru untuk ulangan "${item.judul}". Terima kasih.`
      )}` : null;

      return {
        pengerjaanId: item.pengerjaan_id,
        ulanganId: item.ulangan_id,
        judul: item.judul,
        mataPelajaran: item.mata_pelajaran,
        kodeUjian: item.kode_ujian,
        submittedAt: item.submitted_at || item.started_at,
        isReleased,
        kkm,
        nilaiFinal: finalScore,
        isRemedial,
        instruksi_remedial: item.instruksi_remedial || null,
        link_remedial: item.link_remedial || null,
        isCurrentExam: item.pengerjaan_id === Number(pengerjaanId),
        guru: {
          nama: item.nama_guru,
          email: item.email_guru,
          no_wa: item.no_wa_guru,
          wa_link: waLink
        }
      };
    });
  }
};

module.exports = studentService;
