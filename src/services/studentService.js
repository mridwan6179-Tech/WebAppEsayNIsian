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
          INSERT INTO pengerjaan (ulangan_id, peserta_id, status, soal_ids, started_at, last_active_at)
          VALUES (?, ?, 'mengerjakan', ?, ?, ?)
        `).run(ulanganId, peserta.id, soalIdsJson, nowIso, nowIso);
        pengerjaan = db.prepare('SELECT * FROM pengerjaan WHERE id = ?').get(info.lastInsertRowid);
      } else {
        db.prepare('UPDATE pengerjaan SET soal_ids = ?, last_active_at = CURRENT_TIMESTAMP WHERE id = ?').run(soalIdsJson, pengerjaan.id);
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
  saveDraft(pengerjaanId, rawAnswers, pasteCount = null, pasteDetails = null) {
    if (!pengerjaanId) throw new Error('ID pengerjaan tidak valid');
    const pengerjaan = db.prepare('SELECT id, status FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    if (!pengerjaan) {
      throw new Error('Data pengerjaan tidak ditemukan');
    }
    if (pengerjaan.status === 'submitted') {
      return { success: true, message: 'Ulangan sudah dikumpulkan', alreadySubmitted: true };
    }

    // Perbarui waktu aktif pengerjaan (presence / heartbeat)
    db.prepare('UPDATE pengerjaan SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?').run(pengerjaanId);

    // Ambil daftar soal yang sah ditugaskan untuk pengerjaan siswa ini
    let allowedSoalSet = null;
    if (pengerjaan.soal_ids) {
      try {
        const parsed = JSON.parse(pengerjaan.soal_ids);
        if (Array.isArray(parsed) && parsed.length > 0) {
          allowedSoalSet = new Set(parsed.map(Number));
        }
      } catch (e) {
        allowedSoalSet = null;
      }
    }

    let answers = [];
    if (Array.isArray(rawAnswers)) {
      answers = rawAnswers;
    } else if (rawAnswers && typeof rawAnswers === 'object') {
      answers = Object.entries(rawAnswers).map(([k, v]) => ({
        soal_id: Number(k),
        jawaban_siswa: typeof v === 'object' && v !== null ? (v.jawaban_siswa || v.teks_jawaban || '') : String(v || ''),
        paste_count: typeof v === 'object' && v !== null ? (Number(v.paste_count) || 0) : 0
      }));
    }

    if (answers.length === 0 && (pasteCount === null || pasteCount === undefined)) {
      return { success: true, savedCount: 0 };
    }

    // Deduplikasi payload jawaban berdasarkan soal_id dan filter hanya soal yang ditugaskan
    const uniqueAnswersMap = new Map();
    for (const a of answers) {
      if (!a || !a.soal_id) continue;
      const sId = Number(a.soal_id);
      if (allowedSoalSet && !allowedSoalSet.has(sId)) {
        // Abaikan soal yang tidak termasuk dalam paket ujian siswa ini (mencegah kelebihan kuota)
        continue;
      }
      uniqueAnswersMap.set(sId, {
        text: String(a.jawaban_siswa !== undefined ? a.jawaban_siswa : (a.teks_jawaban || '')),
        paste_count: Number(a.paste_count) || (pasteDetails && pasteDetails[sId] ? Number(pasteDetails[sId]) : 0)
      });
    }

    const saveTx = db.transaction(() => {
      const upsertStmt = db.prepare(`
        INSERT INTO jawaban (pengerjaan_id, soal_id, jawaban_siswa, skor_maksimum, status_penilaian, paste_count)
        VALUES (?, ?, ?, ?, 'menunggu', ?)
        ON CONFLICT(pengerjaan_id, soal_id) DO UPDATE 
        SET jawaban_siswa = excluded.jawaban_siswa,
            paste_count = MAX(COALESCE(jawaban.paste_count, 0), excluded.paste_count)
      `);
      const soalStmt = db.prepare('SELECT bobot FROM soal WHERE id = ?');

      let savedCount = 0;
      for (const [soalId, item] of uniqueAnswersMap.entries()) {
        const s = soalStmt.get(soalId);
        const bobot = s ? s.bobot : 10;
        upsertStmt.run(pengerjaanId, soalId, item.text, bobot, item.paste_count);
        savedCount++;
      }

      if (pasteCount !== null && pasteCount !== undefined) {
        const pasteDetailsStr = pasteDetails && typeof pasteDetails === 'object' ? JSON.stringify(pasteDetails) : null;
        db.prepare(`
          UPDATE pengerjaan 
          SET paste_count = MAX(COALESCE(paste_count, 0), ?),
              paste_details = COALESCE(?, paste_details)
          WHERE id = ?
        `).run(Number(pasteCount) || 0, pasteDetailsStr, pengerjaanId);
      }

      return savedCount;
    });

    const savedCount = saveTx();
    return { success: true, savedCount };
  },

  // FR-08 & NFR-01: Submit Seluruh Jawaban Siswa
  submitExam(pengerjaanId, rawAnswers, pasteCount = 0, isAutoSubmit = false, pasteDetails = null) {
    const pengerjaan = db.prepare('SELECT * FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    if (!pengerjaan) {
      throw new Error('Data pengerjaan tidak ditemukan');
    }

    if (pengerjaan.status === 'submitted') {
      return {
        success: true,
        message: 'Ulangan sudah pernah dikumpulkan sebelumnya',
        alreadySubmitted: true,
        submitted_at: pengerjaan.submitted_at
      };
    }

    // Ambil daftar soal yang sah untuk pengerjaan siswa ini (mencegah duplikasi kuota soal)
    let assignedSoalIds = [];
    if (pengerjaan.soal_ids) {
      try {
        const parsed = JSON.parse(pengerjaan.soal_ids);
        if (Array.isArray(parsed) && parsed.length > 0) {
          assignedSoalIds = parsed.map(Number);
        }
      } catch (e) {
        assignedSoalIds = [];
      }
    }

    // Jika soal_ids belum tercatat, ambil dari master ulangan
    if (assignedSoalIds.length === 0) {
      const allSoal = db.prepare('SELECT id FROM soal WHERE ulangan_id = ?').all(pengerjaan.ulangan_id);
      assignedSoalIds = allSoal.map(s => s.id);
    }

    const assignedSet = new Set(assignedSoalIds);

    // Ambil bobot untuk setiap soal yang sah
    const soalMap = new Map();
    for (const sId of assignedSoalIds) {
      const s = db.prepare('SELECT id, bobot FROM soal WHERE id = ?').get(sId);
      if (s) soalMap.set(s.id, s.bobot);
    }

    // Map jawaban yang dikirimkan oleh siswa, buang soal yang bukan haknya
    let answers = [];
    if (Array.isArray(rawAnswers)) {
      answers = rawAnswers;
    } else if (rawAnswers && typeof rawAnswers === 'object') {
      answers = Object.entries(rawAnswers).map(([k, v]) => ({
        soal_id: Number(k),
        jawaban_siswa: typeof v === 'object' && v !== null ? (v.jawaban_siswa || v.teks_jawaban || '') : String(v || ''),
        paste_count: typeof v === 'object' && v !== null ? (Number(v.paste_count) || 0) : 0
      }));
    }

    const submittedMap = new Map();
    const submittedMapPaste = new Map();
    for (const a of answers) {
      if (!a || !a.soal_id) continue;
      const sId = Number(a.soal_id);
      if (!assignedSet.has(sId)) continue; // Tolak soal di luar kuota pengerjaan siswa ini
      submittedMap.set(sId, String(a.jawaban_siswa !== undefined ? a.jawaban_siswa : (a.teks_jawaban || '')));
      if (a.paste_count !== undefined) {
        submittedMapPaste.set(sId, Number(a.paste_count) || 0);
      }
    }

    // Verifikasi jawaban tidak kosong
    const hasAnySubmittedText = Array.from(submittedMap.values()).some(txt => txt && txt.trim() !== '');
    if (!hasAnySubmittedText && !isAutoSubmit) {
      const draftRows = db.prepare('SELECT jawaban_siswa FROM jawaban WHERE pengerjaan_id = ?').all(pengerjaanId);
      const hasAnyDraft = draftRows.some(r => r.jawaban_siswa && r.jawaban_siswa.trim() !== '');
      if (!hasAnyDraft) {
        return {
          success: false,
          empty: true,
          message: 'Kamu belum mengisi jawaban apapun. Ulangan tidak dapat dikumpulkan dalam kondisi kosong.'
        };
      }
    }

    // Transaksi penyimpanan jawaban agar atomik
    const insertOrUpdateJawaban = db.transaction(() => {
      const checkStmt = db.prepare('SELECT id, jawaban_siswa FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?');
      const upsertStmt = db.prepare(`
        INSERT INTO jawaban (pengerjaan_id, soal_id, jawaban_siswa, skor_maksimum, status_penilaian, paste_count)
        VALUES (?, ?, ?, ?, 'menunggu', ?)
        ON CONFLICT(pengerjaan_id, soal_id) DO UPDATE 
        SET jawaban_siswa = excluded.jawaban_siswa,
            skor_maksimum = excluded.skor_maksimum,
            status_penilaian = 'menunggu',
            paste_count = MAX(COALESCE(jawaban.paste_count, 0), excluded.paste_count)
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

        const itemPaste = (pasteDetails && pasteDetails[soalId]) ? Number(pasteDetails[soalId]) : (submittedMapPaste.get(soalId) || 0);
        upsertStmt.run(pengerjaanId, soalId, finalJawaban, bobot, itemPaste);
      }

      // Update status pengerjaan ke submitted & catat paste_count, paste_details dan auto_submitted
      const nowIso = new Date().toISOString();
      const pasteDetailsStr = pasteDetails && typeof pasteDetails === 'object' ? JSON.stringify(pasteDetails) : null;
      db.prepare(`
        UPDATE pengerjaan 
        SET status = 'submitted', submitted_at = ?, paste_count = MAX(COALESCE(paste_count, 0), ?), auto_submitted = ?, paste_details = COALESCE(?, paste_details)
        WHERE id = ?
      `).run(nowIso, Number(pasteCount) || 0, isAutoSubmit ? 1 : 0, pasteDetailsStr, pengerjaanId);
    });

    insertOrUpdateJawaban();

    const updated = db.prepare('SELECT submitted_at FROM pengerjaan WHERE id = ?').get(pengerjaanId);

    return {
      success: true,
      message: 'Jawaban berhasil dikumpulkan',
      submitted_at: updated.submitted_at
    };
  },

  // Pembersihan Otomatis Sesi Terputus (DC) / Sesi Kedaluwarsa
  cleanAbandonedSessions(ulanganId = null) {
    try {
      const candidates = db.prepare(`
        SELECT 
          p.id as pengerjaan_id,
          p.peserta_id,
          p.ulangan_id,
          p.started_at,
          p.last_active_at,
          u.durasi_menit,
          pes.nama as nama_siswa,
          pes.kelas as kelas_siswa,
          COUNT(j.id) as total_jawaban,
          SUM(CASE WHEN j.jawaban_siswa IS NOT NULL AND TRIM(j.jawaban_siswa) != '' THEN 1 ELSE 0 END) as total_terisi,
          CAST(ROUND((julianday('now') - julianday(COALESCE(p.last_active_at, p.started_at))) * 86400) AS INTEGER) as detik_inaktif,
          CAST(ROUND((julianday('now') - julianday(p.started_at)) * 1440) AS INTEGER) as menit_berjalan
        FROM pengerjaan p
        JOIN ulangan u ON p.ulangan_id = u.id
        JOIN peserta pes ON p.peserta_id = pes.id
        LEFT JOIN jawaban j ON p.id = j.pengerjaan_id
        WHERE p.status = 'mengerjakan'
          AND (? IS NULL OR p.ulangan_id = ?)
        GROUP BY p.id
      `).all(ulanganId, ulanganId);

      const deletedSessions = [];
      const autoSubmittedSessions = [];

      for (const row of candidates) {
        const totalTerisi = Number(row.total_terisi || 0);
        const detikInaktif = Number(row.detik_inaktif || 0);
        const menitBerjalan = Number(row.menit_berjalan || 0);
        const durasiMenit = Number(row.durasi_menit || 0);

        // Sesi DC > 1 jam: pengerjaan harus sudah dimulai minimal 60 menit lalu DAN (offline atau inaktif > 3600 detik)
        const isDcOver1Hour = (menitBerjalan >= 60) && (
          (row.last_active_at && String(row.last_active_at).startsWith('2000-01-01')) || detikInaktif >= 3600
        );
        const isPastDuration = (durasiMenit > 0 && menitBerjalan > durasiMenit); // Melewati durasi pengerjaan ulangan

        // KASUS 1: Jawabannya KOSONG (0 terisi) DAN (DC > 1 jam ATAU waktu durasi pengerjaan telah habis)
        // -> HAPUS pengerjaan dan peserta, jangan disimpan sebagai sampah data
        if (totalTerisi === 0 && (isDcOver1Hour || isPastDuration)) {
          const deleteTx = db.transaction(() => {
            db.prepare('DELETE FROM jawaban WHERE pengerjaan_id = ?').run(row.pengerjaan_id);
            db.prepare('DELETE FROM pengerjaan WHERE id = ?').run(row.pengerjaan_id);
            const otherCount = db.prepare('SELECT COUNT(*) as cnt FROM pengerjaan WHERE peserta_id = ?').get(row.peserta_id);
            if (!otherCount || otherCount.cnt === 0) {
              db.prepare('DELETE FROM peserta WHERE id = ?').run(row.peserta_id);
            }
          });
          deleteTx();
          deletedSessions.push({
            pengerjaan_id: row.pengerjaan_id,
            nama: row.nama_siswa,
            kelas: row.kelas_siswa,
            alasan: isDcOver1Hour ? 'DC > 1 jam tanpa jawaban' : 'Waktu habis tanpa jawaban'
          });
          console.log(`[CLEANUP] Menghapus pengerjaan kosong ID ${row.pengerjaan_id} (${row.nama_siswa} - ${row.kelas_siswa}) karena ${isDcOver1Hour ? 'DC > 1 jam' : 'durasi habis'} dengan 0 jawaban.`);
        }
        // KASUS 2: Jawabannya SUDAH ADA YANG TERISI, namun waktu ujian telah habis atau DC > 1 jam
        // -> Otomatis finalisasi / submit agar siswa tidak menggantung di DC mengerjakan
        else if (totalTerisi > 0 && (isPastDuration || isDcOver1Hour)) {
          const nowIso = new Date().toISOString();
          db.prepare(`
            UPDATE pengerjaan
            SET status = 'submitted', submitted_at = ?, auto_submitted = 1
            WHERE id = ?
          `).run(nowIso, row.pengerjaan_id);
          autoSubmittedSessions.push({
            pengerjaan_id: row.pengerjaan_id,
            nama: row.nama_siswa,
            kelas: row.kelas_siswa,
            terisi: totalTerisi
          });
          console.log(`[AUTO-FINALIZE] Memfinalisasi submit otomatis ID ${row.pengerjaan_id} (${row.nama_siswa} - ${row.kelas_siswa}) dengan ${totalTerisi} jawaban terisi.`);
        }
      }

      return {
        success: true,
        deleted: deletedSessions,
        autoSubmitted: autoSubmittedSessions
      };
    } catch (err) {
      console.error('[CLEANUP ERROR] Gagal membersihkan sesi kedaluwarsa:', err.message);
      return { success: false, error: err.message };
    }
  },

  // Finalisasi pengerjaan siswa terputus (DC) oleh guru (Force Submit)
  forceSubmitByGuru(pengerjaanId, guruId) {
    if (!pengerjaanId) throw new Error('ID pengerjaan tidak valid');
    const pengerjaan = db.prepare(`
      SELECT p.*, u.guru_id
      FROM pengerjaan p
      JOIN ulangan u ON p.ulangan_id = u.id
      WHERE p.id = ?
    `).get(pengerjaanId);

    if (!pengerjaan) throw new Error('Data pengerjaan tidak ditemukan');
    if (pengerjaan.guru_id !== guruId) throw new Error('Akses ditolak: bukan ulangan milik Anda');

    if (pengerjaan.status === 'submitted') {
      return { success: true, message: 'Ulangan sudah berstatus dikumpulkan', alreadySubmitted: true, submitted_at: pengerjaan.submitted_at };
    }

    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE pengerjaan
      SET status = 'submitted', submitted_at = ?, auto_submitted = 1
      WHERE id = ?
    `).run(nowIso, pengerjaanId);

    return {
      success: true,
      message: 'Pengerjaan siswa berhasil dikumpulkan secara resmi oleh guru',
      submitted_at: nowIso
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
  },

  // Rekam detak jantung / presence siswa saat mengerjakan (mendeteksi aktif vs terputus/dc)
  recordPing(pengerjaanId, status = 'active') {
    if (!pengerjaanId) return { success: false, message: 'pengerjaan_id wajib diisi' };
    const pengerjaan = db.prepare('SELECT id, status FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    if (!pengerjaan || pengerjaan.status !== 'mengerjakan') {
      return { success: false, message: 'Pengerjaan tidak ditemukan atau sudah dikumpulkan' };
    }

    if (status === 'offline') {
      // Disconnect eksplisit (misal user tutup tab / browser pagehide)
      db.prepare(`UPDATE pengerjaan SET last_active_at = '2000-01-01 00:00:00' WHERE id = ?`).run(pengerjaanId);
      return { success: true, status: 'offline' };
    }

    db.prepare('UPDATE pengerjaan SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?').run(pengerjaanId);
    return { success: true, status: 'active' };
  }
};

module.exports = studentService;
