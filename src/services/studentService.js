const db = require('../config/database');
const examService = require('./examService');

const studentService = {
  // FR-06: Validasi Kode Ulangan
  validateExamCode(kodeUjian) {
    if (!kodeUjian || typeof kodeUjian !== 'string') {
      return { valid: false, message: 'Kode ulangan tidak boleh kosong' };
    }

    const cleanCode = kodeUjian.trim().toUpperCase();
    const ulangan = db.prepare('SELECT id, judul, mata_pelajaran, tingkat_kelas, deskripsi, status, jumlah_soal_tampil, jumlah_soal_isian, jumlah_soal_essay, jumlah_soal_listening, acak_soal, tanggal_mulai, tanggal_selesai, durasi_menit, kkm, zona_waktu, tampilkan_simbol, link_kisi_kisi, tampilkan_kisi_kisi, tampilkan_teks_listening FROM ulangan WHERE kode_ujian = ?').get(cleanCode);

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

    // Ambil daftar kelas yang ditautkan ke ulangan ini
    let kelasList = db.prepare(`
      SELECT k.nama_kelas 
      FROM ulangan_kelas uk 
      JOIN kelas k ON uk.kelas_id = k.id 
      WHERE uk.ulangan_id = ? 
      ORDER BY k.nama_kelas ASC
    `).all(ulangan.id).map(k => k.nama_kelas);

    if (kelasList.length === 0) {
      // Periksa apakah tingkat_kelas berisi nama-nama kelas yang dipisah koma (cth: "7A, 7B")
      if (ulangan.tingkat_kelas && ulangan.tingkat_kelas.trim() && ulangan.tingkat_kelas.toLowerCase() !== 'umum') {
        const parsed = ulangan.tingkat_kelas.split(/[,;/]+/).map(s => s.trim()).filter(Boolean);
        if (parsed.length > 0) {
          kelasList = parsed;
          // Auto-link ke ulangan_kelas jika ada kecocokan di tabel kelas guru
          try {
            const teacherId = db.prepare('SELECT guru_id FROM ulangan WHERE id = ?').get(ulangan.id)?.guru_id;
            if (teacherId) {
              const matchingClasses = db.prepare('SELECT id, nama_kelas FROM kelas WHERE guru_id = ?').all(teacherId);
              const nameMap = new Map(matchingClasses.map(k => [k.nama_kelas.toLowerCase(), k.id]));
              const idsToLink = parsed.map(name => nameMap.get(name.toLowerCase())).filter(Boolean);
              if (idsToLink.length > 0) {
                const insertUk = db.prepare('INSERT OR IGNORE INTO ulangan_kelas (ulangan_id, kelas_id) VALUES (?, ?)');
                idsToLink.forEach(kid => insertUk.run(ulangan.id, kid));
              }
            }
          } catch (e) {
            console.warn('Auto-link class error:', e);
          }
        }
      }
    }

    if (kelasList.length === 0) {
      // Fallback: hanya jika ulangan berstatus "Umum" tanpa spesifikasi kelas tertentu
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
        jumlah_soal_listening: ulangan.jumlah_soal_listening,
        acak_soal: ulangan.acak_soal,
        tanggal_mulai: ulangan.tanggal_mulai,
        tanggal_selesai: ulangan.tanggal_selesai,
        durasi_menit: ulangan.durasi_menit,
        kkm: ulangan.kkm || 75,
        zona_waktu: ulangan.zona_waktu || 'WIB',
        tampilkan_simbol: (ulangan.tampilkan_simbol !== undefined && ulangan.tampilkan_simbol !== null) ? Number(ulangan.tampilkan_simbol) : 1,
        link_kisi_kisi: (ulangan.tampilkan_kisi_kisi && ulangan.link_kisi_kisi) ? ulangan.link_kisi_kisi : null,
        tampilkan_kisi_kisi: (ulangan.tampilkan_kisi_kisi && ulangan.link_kisi_kisi) ? 1 : 0,
        tampilkan_teks_listening: (ulangan.tampilkan_teks_listening !== undefined && ulangan.tampilkan_teks_listening !== null) ? Number(ulangan.tampilkan_teks_listening) : 0,
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

    const ulanganInfo = db.prepare('SELECT jumlah_soal_tampil, jumlah_soal_isian, jumlah_soal_essay, jumlah_soal_listening, acak_soal FROM ulangan WHERE id = ?').get(ulanganId);
    let soalList = [];

    if (Array.isArray(assignedQuestionIds) && assignedQuestionIds.length > 0) {
      // Siswa sudah memulai sebelumnya: muat soal yang sama persis (persisten / anti-refresh)
      const placeholders = assignedQuestionIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT id, nomor, jenis, pertanyaan, gambar_url, bobot, tingkat_kelas, urutan, audio_url, audio_script, is_listening, bahasa, tampilkan_teks_listening
        FROM soal
        WHERE id IN (${placeholders})
      `).all(...assignedQuestionIds);

      const rowMap = new Map(rows.map(r => [r.id, r]));
      soalList = assignedQuestionIds.map(id => rowMap.get(id)).filter(Boolean);
    } else {
      // Pengerjaan baru: ambil semua soal dari bank soal
      const allQuestions = db.prepare(`
        SELECT id, nomor, jenis, pertanyaan, gambar_url, bobot, tingkat_kelas, urutan, audio_url, audio_script, is_listening, bahasa, tampilkan_teks_listening
        FROM soal
        WHERE ulangan_id = ?
        ORDER BY urutan ASC, nomor ASC
      `).all(ulanganId);

      const limitSoal = ulanganInfo?.jumlah_soal_tampil;
      const targetIsian = ulanganInfo?.jumlah_soal_isian;
      const targetEssay = ulanganInfo?.jumlah_soal_essay;
      const targetListening = (ulanganInfo?.jumlah_soal_listening !== undefined && ulanganInfo?.jumlah_soal_listening !== null)
        ? Math.max(0, Number(ulanganInfo.jumlah_soal_listening))
        : null;
      const hasSpecificQuota = (targetIsian !== null && targetIsian !== undefined && targetIsian > 0) ||
                               (targetEssay !== null && targetEssay !== undefined && targetEssay > 0);
      const hasListeningLimit = (targetListening !== null);
      const isAcak = (ulanganInfo?.acak_soal === 1);
      const needRandom = isAcak || (limitSoal && limitSoal < allQuestions.length) || hasSpecificQuota || hasListeningLimit;

      const shuffleArr = (arr) => {
        const res = [...arr];
        for (let i = res.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [res[i], res[j]] = [res[j], res[i]];
        }
        return res;
      };

      if (hasListeningLimit) {
        // Kuota khusus soal listening: pisahkan pool listening dan non-listening
        const listeningPool = allQuestions.filter(q => Number(q.is_listening) === 1);
        const nonListeningPool = allQuestions.filter(q => Number(q.is_listening) !== 1);

        const maxListening = Math.min(targetListening, listeningPool.length);
        const readyListening = (isAcak || maxListening < listeningPool.length) ? shuffleArr(listeningPool) : [...listeningPool];
        const selectedListening = readyListening.slice(0, maxListening);

        if (hasSpecificQuota) {
          const listeningIsianCount = selectedListening.filter(q => q.jenis === 'isian').length;
          const listeningEssayCount = selectedListening.filter(q => q.jenis === 'essay').length;

          const neededIsian = (targetIsian !== null && targetIsian !== undefined && targetIsian > 0)
            ? Math.max(0, targetIsian - listeningIsianCount)
            : 0;
          const neededEssay = (targetEssay !== null && targetEssay !== undefined && targetEssay > 0)
            ? Math.max(0, targetEssay - listeningEssayCount)
            : 0;

          const nonListeningIsian = nonListeningPool.filter(q => q.jenis === 'isian');
          const nonListeningEssay = nonListeningPool.filter(q => q.jenis === 'essay');

          const readyNonIsian = (isAcak || neededIsian < nonListeningIsian.length) ? shuffleArr(nonListeningIsian) : [...nonListeningIsian];
          const readyNonEssay = (isAcak || neededEssay < nonListeningEssay.length) ? shuffleArr(nonListeningEssay) : [...nonListeningEssay];

          const selectedIsian = readyNonIsian.slice(0, Math.min(neededIsian, readyNonIsian.length));
          const selectedEssay = readyNonEssay.slice(0, Math.min(neededEssay, readyNonEssay.length));

          let combined = [...selectedListening, ...selectedIsian, ...selectedEssay];

          // Jika ada limitSoal total yang lebih besar dari kuota wajib, penuhi dari nonListeningPool
          if (limitSoal && limitSoal > combined.length) {
            const chosenIds = new Set(combined.map(s => s.id));
            const unchosenNon = nonListeningPool.filter(q => !chosenIds.has(q.id));
            const remainingPool = isAcak ? shuffleArr(unchosenNon) : unchosenNon;
            const needed = limitSoal - combined.length;
            combined.push(...remainingPool.slice(0, needed));
          } else if (limitSoal && limitSoal < combined.length) {
            combined = combined.slice(0, limitSoal);
          }

          if (isAcak) {
            soalList = shuffleArr(combined);
          } else {
            combined.sort((a, b) => (a.urutan - b.urutan) || (a.nomor - b.nomor));
            soalList = combined;
          }
        } else {
          // Tanpa kuota isian/essay spesifik: sisa diambil dari nonListeningPool
          const targetTotal = limitSoal ? limitSoal : (selectedListening.length + nonListeningPool.length);
          const remainingNeeded = Math.max(0, targetTotal - selectedListening.length);

          const readyNonListening = (isAcak || remainingNeeded < nonListeningPool.length) ? shuffleArr(nonListeningPool) : [...nonListeningPool];
          const selectedNonListening = readyNonListening.slice(0, remainingNeeded);

          let combined = [...selectedListening, ...selectedNonListening];
          if (limitSoal && combined.length > limitSoal) {
            combined = combined.slice(0, limitSoal);
          }

          if (isAcak) {
            soalList = shuffleArr(combined);
          } else {
            combined.sort((a, b) => (a.urutan - b.urutan) || (a.nomor - b.nomor));
            soalList = combined;
          }
        }
      } else if (hasSpecificQuota) {
        // Kuota wajib per jenis soal: pisahkan bank isian dan essay
        const isianPool = allQuestions.filter(q => q.jenis === 'isian');
        const essayPool = allQuestions.filter(q => q.jenis === 'essay');

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

    // Ambil draft jawaban yang tersimpan di server jika ada (misal siswa login ulang)
    const existingJawabanRows = db.prepare('SELECT soal_id, jawaban_siswa FROM jawaban WHERE pengerjaan_id = ?').all(pengerjaan.id);
    const existingJawabanMap = new Map(existingJawabanRows.map(j => [j.soal_id, j.jawaban_siswa]));

    // Berikan nomor urut tampilan yang rapi 1..N dan sertakan jawaban_siswa jika ada
    const displaySoalList = soalList.map((s, idx) => ({
      ...s,
      nomor: idx + 1,
      jawaban_siswa: existingJawabanMap.get(s.id) || ''
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

  // Auto-Save Draft Jawaban Siswa (Sinkronisasi berkala dari HP/Klien ke Server)
  saveDraft(pengerjaanId, rawAnswers) {
    if (!pengerjaanId) throw new Error('ID pengerjaan tidak valid');
    const pengerjaan = db.prepare('SELECT id, status FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    if (!pengerjaan) {
      throw new Error('Data pengerjaan tidak ditemukan');
    }
    if (pengerjaan.status === 'submitted') {
      return { success: true, message: 'Ulangan sudah dikumpulkan', alreadySubmitted: true };
    }

    const answers = Array.isArray(rawAnswers) ? rawAnswers : [];
    if (answers.length === 0) {
      return { success: true, savedCount: 0 };
    }

    const saveTx = db.transaction(() => {
      const checkStmt = db.prepare('SELECT id, jawaban_siswa FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?');
      const updateStmt = db.prepare('UPDATE jawaban SET jawaban_siswa = ? WHERE id = ?');
      const insertStmt = db.prepare(`INSERT INTO jawaban (pengerjaan_id, soal_id, jawaban_siswa, skor_maksimum, status_penilaian) VALUES (?, ?, ?, ?, 'menunggu')`);
      const soalStmt = db.prepare('SELECT bobot FROM soal WHERE id = ?');

      let savedCount = 0;
      for (const a of answers) {
        if (!a || !a.soal_id) continue;
        const soalId = Number(a.soal_id);
        const text = String(a.jawaban_siswa || '');
        const existing = checkStmt.get(pengerjaanId, soalId);
        if (existing) {
          updateStmt.run(text, existing.id);
          savedCount++;
        } else {
          const s = soalStmt.get(soalId);
          const bobot = s ? s.bobot : 10;
          insertStmt.run(pengerjaanId, soalId, text, bobot);
          savedCount++;
        }
      }
      return savedCount;
    });

    const savedCount = saveTx();
    return { success: true, savedCount };
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

    // Guard: Tolak submit manual yang sama sekali kosong (tidak ada jawaban terisi)
    // Kecuali auto-submit karena waktu habis — di sana kita submit apa pun yang ada.
    if (!isAutoSubmit) {
      // Deteksi apakah ada jawaban terisi, mendukung tiga format rawAnswers:
      //   1. Array standar: [{ soal_id, jawaban_siswa }]
      //   2. Array legacy test: [{ soal_id, teks_jawaban }]
      //   3. Objek plain legacy: { [soalId]: 'nilai' }
      let hasAnyFilledAnswer;
      if (Array.isArray(rawAnswers)) {
        hasAnyFilledAnswer = rawAnswers.some(a => {
          const val = a && (a.jawaban_siswa !== undefined ? a.jawaban_siswa : a.teks_jawaban);
          return String(val || '').trim() !== '';
        });
      } else if (rawAnswers && typeof rawAnswers === 'object') {
        // Plain-object format: nilai-nilai adalah string jawaban
        hasAnyFilledAnswer = Object.values(rawAnswers).some(v => String(v || '').trim() !== '');
      } else {
        hasAnyFilledAnswer = false;
      }

      if (!hasAnyFilledAnswer) {
        // Cek juga draft yang sudah tersimpan di server sebelum menolak
        const existingDraft = db.prepare(
          "SELECT id FROM jawaban WHERE pengerjaan_id = ? AND jawaban_siswa IS NOT NULL AND jawaban_siswa != '' LIMIT 1"
        ).get(pengerjaanId);
        if (!existingDraft) {
          // Tidak ada jawaban apapun — tolak, jangan ubah status
          return {
            success: false,
            empty: true,
            message: 'Jawaban masih kosong. Silakan isi jawaban terlebih dahulu sebelum mengumpulkan.'
          };
        }
        // Ada draft tersimpan di server → boleh submit (akan pakai data draft)
      }
    }

    // Transaksi penyimpanan jawaban agar atomik
    const insertOrUpdateJawaban = db.transaction(() => {
      const checkStmt = db.prepare('SELECT id, jawaban_siswa FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?');
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
        const submittedText = submittedMap.get(soalId);
        const existing = checkStmt.get(pengerjaanId, soalId);

        // Proteksi: jangan menimpa jawaban yang sudah tersimpan di draft server jika submittedText kosong/tidak ada
        let finalJawaban = '';
        if (submittedText !== undefined && submittedText !== null && submittedText.trim() !== '') {
          finalJawaban = submittedText;
        } else if (existing && existing.jawaban_siswa && existing.jawaban_siswa.trim() !== '') {
          finalJawaban = existing.jawaban_siswa;
        } else if (submittedText !== undefined && submittedText !== null) {
          finalJawaban = submittedText;
        }

        if (existing) {
          updateStmt.run(finalJawaban, bobot, existing.id);
        } else {
          insertStmt.run(pengerjaanId, soalId, finalJawaban, bobot);
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
  },

  // Mengambil sesi pengerjaan aktif siswa (Mendukung Resume Sesi & Anti-Refresh)
  getActiveSession(pengerjaanId) {
    if (!pengerjaanId) return null;

    const pengerjaan = db.prepare(`
      SELECT p.*, u.id as ulangan_id, u.judul, u.mata_pelajaran, u.tingkat_kelas, u.deskripsi,
             u.kode_ujian, u.durasi_menit, u.tanggal_mulai, u.tanggal_selesai, u.kkm, u.zona_waktu,
             u.tampilkan_simbol, u.link_kisi_kisi, u.tampilkan_kisi_kisi, u.jumlah_soal_listening, u.tampilkan_teks_listening, pes.id as peserta_id, pes.nama as nama_peserta, pes.kelas as kelas_peserta
      FROM pengerjaan p
      JOIN ulangan u ON p.ulangan_id = u.id
      JOIN peserta pes ON p.peserta_id = pes.id
      WHERE p.id = ?
    `).get(pengerjaanId);

    if (!pengerjaan) return null;

    if (pengerjaan.status === 'submitted') {
      return {
        alreadySubmitted: true,
        pengerjaanId: pengerjaan.id,
        submittedAt: pengerjaan.submitted_at,
        releasedAt: pengerjaan.released_at,
        nilaiFinal: pengerjaan.nilai_final,
        message: 'Anda sudah mengumpulkan ulangan ini sebelumnya.'
      };
    }

    // Hitung batas waktu deadline pengerjaan siswa
    let deadlineAt = null;
    const startedAtStr = pengerjaan.started_at
      ? (pengerjaan.started_at.includes('T') ? pengerjaan.started_at : pengerjaan.started_at.replace(' ', 'T') + 'Z')
      : new Date().toISOString();
    const startedAt = new Date(startedAtStr);

    if (pengerjaan.durasi_menit) {
      const durationDeadline = new Date(startedAt.getTime() + pengerjaan.durasi_menit * 60 * 1000);
      deadlineAt = durationDeadline;
    }

    if (pengerjaan.tanggal_selesai) {
      const closeDeadline = new Date(pengerjaan.tanggal_selesai);
      if (!deadlineAt || closeDeadline < deadlineAt) {
        deadlineAt = closeDeadline;
      }
    }

    // Ambil jawaban draft yang tersimpan di server jika ada
    const existingJawabanRows = db.prepare('SELECT soal_id, jawaban_siswa FROM jawaban WHERE pengerjaan_id = ?').all(pengerjaanId);
    const existingJawabanMap = new Map(existingJawabanRows.map(j => [j.soal_id, j.jawaban_siswa]));

    const now = new Date();
    const isTimeExpired = Boolean(deadlineAt && now > deadlineAt);

    if (isTimeExpired) {
      if (existingJawabanRows.length > 0) {
        // Jika sudah ada jawaban tersimpan di server dan waktu benar-benar habis, submit dengan jawaban yang ada
        const formattedAnswers = existingJawabanRows.map(j => ({ soal_id: j.soal_id, jawaban_siswa: j.jawaban_siswa }));
        this.submitExam(pengerjaan.id, formattedAnswers, pengerjaan.paste_count || 0, true);
        return {
          alreadySubmitted: true,
          pengerjaanId: pengerjaan.id,
          autoSubmitted: true,
          message: 'Waktu pengerjaan telah habis.'
        };
      }
      // Jika di server belum ada jawaban, JANGAN pernah submit [] kosong yang menghancurkan data!
      // Biarkan client menerima sesi dan mengirimkan draft localStorage-nya
    }

    // Ambil soal yang ditugaskan ke pengerjaan ini
    let assignedQuestionIds = null;
    if (pengerjaan.soal_ids) {
      try {
        assignedQuestionIds = JSON.parse(pengerjaan.soal_ids);
      } catch (e) {
        assignedQuestionIds = null;
      }
    }

    let displaySoalList = [];
    if (Array.isArray(assignedQuestionIds) && assignedQuestionIds.length > 0) {
      const placeholders = assignedQuestionIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT id, nomor, jenis, pertanyaan, gambar_url, bobot, tingkat_kelas, urutan, audio_url, audio_script, is_listening, bahasa, tampilkan_teks_listening
        FROM soal
        WHERE id IN (${placeholders})
      `).all(...assignedQuestionIds);

      const rowMap = new Map(rows.map(r => [r.id, r]));
      displaySoalList = assignedQuestionIds.map((id, idx) => {
        const item = rowMap.get(id);
        return item ? { ...item, nomor: idx + 1 } : null;
      }).filter(Boolean);
    } else {
      displaySoalList = db.prepare(`
        SELECT id, nomor, jenis, pertanyaan, gambar_url, bobot, tingkat_kelas, urutan, audio_url, audio_script, is_listening, bahasa, tampilkan_teks_listening
        FROM soal
        WHERE ulangan_id = ?
        ORDER BY urutan ASC, nomor ASC
      `).all(pengerjaan.ulangan_id).map((s, idx) => ({ ...s, nomor: idx + 1 }));
    }

    // Pasangkan teks draft jawaban tersimpan ke butir soal
    const displaySoalWithAnswers = displaySoalList.map(s => ({
      ...s,
      jawaban_siswa: existingJawabanMap.get(s.id) || ''
    }));

    const stats = db.prepare('SELECT COUNT(*) as total_soal, COALESCE(SUM(bobot), 0) as total_bobot FROM soal WHERE ulangan_id = ?').get(pengerjaan.ulangan_id);

    return {
      alreadySubmitted: false,
      timeExpired: isTimeExpired,
      pengerjaanId: pengerjaan.id,
      peserta: {
        id: pengerjaan.peserta_id,
        nama: pengerjaan.nama_peserta,
        kelas: pengerjaan.kelas_peserta
      },
      ulangan: {
        id: pengerjaan.ulangan_id,
        judul: pengerjaan.judul,
        mata_pelajaran: pengerjaan.mata_pelajaran,
        tingkat_kelas: pengerjaan.tingkat_kelas,
        deskripsi: pengerjaan.deskripsi,
        total_soal: stats.total_soal,
        soal_dikerjakan: displaySoalWithAnswers.length,
        total_bobot: stats.total_bobot,
        kkm: pengerjaan.kkm || 75,
        zona_waktu: pengerjaan.zona_waktu || 'WIB',
        tampilkan_simbol: (pengerjaan.tampilkan_simbol !== undefined && pengerjaan.tampilkan_simbol !== null) ? Number(pengerjaan.tampilkan_simbol) : 1,
        link_kisi_kisi: (pengerjaan.tampilkan_kisi_kisi && pengerjaan.link_kisi_kisi) ? pengerjaan.link_kisi_kisi : null,
        tampilkan_kisi_kisi: (pengerjaan.tampilkan_kisi_kisi && pengerjaan.link_kisi_kisi) ? 1 : 0,
        jumlah_soal_listening: pengerjaan.jumlah_soal_listening,
        tampilkan_teks_listening: Number(pengerjaan.tampilkan_teks_listening || 0)
      },
      deadline_at: deadlineAt ? deadlineAt.toISOString() : null,
      server_time: new Date().toISOString(),
      soal: displaySoalWithAnswers
    };
  }
};

module.exports = studentService;
