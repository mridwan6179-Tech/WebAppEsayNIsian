const db = require('../config/database');
const examService = require('./examService');
const packageService = require('./packageService');
const codingGameService = require('./codingGameService');
const crypto = require('crypto');

function createStudentSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function createStudentRecoveryToken() {
  return `REC-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function parseStoredDate(value) {
  if (!value) return null;
  const raw = String(value);
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function tokensMatch(expected, received) {
  if (!expected || !received || typeof received !== 'string') return false;
  const expectedBuffer = Buffer.from(String(expected));
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function maskStudentName(name) {
  if (!name || typeof name !== 'string') return '-';
  const clean = name.trim();
  if (!clean) return '-';
  const words = clean.split(/\s+/);
  return words.map(word => {
    if (word.length <= 2) {
      return word[0] + '*';
    }
    if (word.length === 3) {
      return word.slice(0, 2) + '*';
    }
    const visibleCount = Math.min(3, Math.max(2, Math.floor(word.length / 2)));
    const maskedCount = Math.max(2, word.length - visibleCount);
    return word.slice(0, visibleCount) + '*'.repeat(maskedCount);
  }).join(' ');
}

const studentService = {
  generateStudentSessionToken: createStudentSessionToken,
  generateStudentRecoveryToken: createStudentRecoveryToken,

  // Pastikan attempt memiliki token pemilik sebelum dikirim ke browser.
  ensureStudentSessionToken(pengerjaan) {
    if (!pengerjaan || !pengerjaan.id) return pengerjaan;
    if (pengerjaan.student_session_token) return pengerjaan;

    const token = createStudentSessionToken();
    try {
      db.prepare(`
        UPDATE pengerjaan
        SET student_session_token = ?
        WHERE id = ? AND (student_session_token IS NULL OR student_session_token = '')
      `).run(token, pengerjaan.id);
      if (typeof db.sync === 'function') {
        try { db.sync(); } catch (_) {}
      }
    } catch (e) {
      // Another instance may have won the race to assign the token.
    }
    const refreshed = db.prepare('SELECT * FROM pengerjaan WHERE id = ?').get(pengerjaan.id);
    return refreshed || { ...pengerjaan, student_session_token: token };
  },

  // Verifikasi bukti kepemilikan attempt untuk seluruh endpoint siswa.
  verifyStudentSession(pengerjaanId, studentSessionToken) {
    if (!pengerjaanId || !studentSessionToken) return null;
    const pengerjaan = this.findPengerjaanWithSync(pengerjaanId);
    if (!pengerjaan) return null;
    const secured = this.ensureStudentSessionToken(pengerjaan);
    return tokensMatch(secured.student_session_token, studentSessionToken) ? secured : null;
  },

  ensureStudentRecoveryToken(pengerjaan) {
    if (!pengerjaan || !pengerjaan.id) return pengerjaan;
    if (pengerjaan.student_recovery_token) return pengerjaan;

    let token = createStudentRecoveryToken();
    try {
      const existing = db.prepare('SELECT id FROM pengerjaan WHERE student_recovery_token = ?').get(token);
      if (existing) token = createStudentRecoveryToken();
      db.prepare(`
        UPDATE pengerjaan
        SET student_recovery_token = ?, student_recovery_issued_at = COALESCE(student_recovery_issued_at, CURRENT_TIMESTAMP)
        WHERE id = ? AND (student_recovery_token IS NULL OR student_recovery_token = '')
      `).run(token, pengerjaan.id);
    } catch (e) {
      // Instance lain mungkin sudah mengisi token. Ambil ulang row di bawah.
    }
    const refreshed = db.prepare('SELECT * FROM pengerjaan WHERE id = ?').get(pengerjaan.id);
    return refreshed || { ...pengerjaan, student_recovery_token: token };
  },

  verifyStudentRecoveryToken(pengerjaanId, recoveryToken, nama = null, kelas = null) {
    if (!pengerjaanId || !recoveryToken) return false;
    const pengerjaan = this.findPengerjaanWithSync(pengerjaanId);
    if (!pengerjaan || pengerjaan.status !== 'mengerjakan') return false;
    const secured = this.ensureStudentRecoveryToken(pengerjaan);
    if (!tokensMatch(secured.student_recovery_token, String(recoveryToken).trim().toUpperCase())) return false;

    const lastActive = parseStoredDate(secured.disconnected_at || secured.last_active_at || secured.started_at);
    if (!lastActive || (Date.now() - lastActive.getTime()) > 60 * 60 * 1000) return false;
    const peserta = db.prepare('SELECT nama, kelas FROM peserta WHERE id = ?').get(secured.peserta_id);
    if (!peserta) return false;
    if (nama && String(peserta.nama || '').trim().toLowerCase() !== String(nama).trim().toLowerCase()) return false;
    if (kelas && String(peserta.kelas || '').trim().toLowerCase() !== String(kelas).trim().toLowerCase()) return false;
    return true;
  },

  recoverStudentSession(kodeUjian, nama, kelas, recoveryToken, sesiId = null) {
    const val = this.validateExamCode(kodeUjian);
    if (!val.valid) throw new Error(val.message);
    const cleanNama = String(nama || '').trim();
    const cleanKelas = String(kelas || '').trim();
    const token = String(recoveryToken || '').trim().toUpperCase();
    if (!cleanNama || !cleanKelas || !token) throw new Error('Kode ulangan, nama, kelas, dan token pemulihan wajib diisi');

    const recoveryQuery = db.prepare(`
      SELECT p.id, p.ulangan_id, p.peserta_id, p.status, p.student_session_token, p.student_recovery_token,
             pes.nama, pes.kelas, pes.id AS peserta_row_id, p.sesi_id
      FROM pengerjaan p
      JOIN peserta pes ON pes.id = p.peserta_id
      WHERE p.student_recovery_token = ?
    `);
    let row = recoveryQuery.get(token);
    if (!row && typeof db.sync === 'function') {
      const delays = [150, 300, 500, 800, 1200];
      for (let attempt = 0; attempt < delays.length && !row; attempt++) {
        try { db.sync(); } catch (_) {}
        row = recoveryQuery.get(token);
        if (!row && attempt < delays.length - 1) {
          const waitTill = Date.now() + delays[attempt];
          while (Date.now() < waitTill) {}
        }
      }
    }
    if (!row || Number(row.ulangan_id) !== Number(val.ulangan.id)
      || row.nama.trim().toLowerCase() !== cleanNama.toLowerCase()
      || row.kelas.trim().toLowerCase() !== cleanKelas.toLowerCase()
      || !this.verifyStudentRecoveryToken(row.id, token, cleanNama, cleanKelas)) {
      const err = new Error('Token pemulihan tidak valid, sudah kedaluwarsa, atau identitas tidak cocok.');
      err.code = 'INVALID_STUDENT_RECOVERY_TOKEN';
      throw err;
    }

    const nextSessionToken = createStudentSessionToken();
    const securedRow = this.ensureStudentSessionToken(row);
    const rotated = db.prepare(`
      UPDATE pengerjaan
      SET student_session_token = ?, last_active_at = CURRENT_TIMESTAMP, disconnected_at = NULL
      WHERE id = ? AND status = 'mengerjakan' AND student_session_token = ?
    `).run(nextSessionToken, row.id, securedRow.student_session_token);
    if (Number(rotated?.changes || 0) !== 1) {
      const err = new Error('Sesi baru saja dipulihkan di perangkat lain. Gunakan token pemulihan sekali lagi.');
      err.code = 'INVALID_STUDENT_RECOVERY_TOKEN';
      throw err;
    }

    return this.startExam(
      kodeUjian,
      cleanNama,
      cleanKelas,
      sesiId || row.sesi_id || null,
      false,
      nextSessionToken,
      true,
      row.id,
      nextSessionToken
    );
  },

  // FR-06: Validasi Kode Ulangan
  validateExamCode(kodeUjian) {
    if (!kodeUjian || typeof kodeUjian !== 'string') {
      return { valid: false, message: 'Kode ulangan tidak boleh kosong' };
    }

    const cleanCode = kodeUjian.trim().toUpperCase();

    // 1. Cek apakah kode yang dimasukkan adalah Token Sesi (ulangan_sesi)
    let sesiActive = null;
    try {
      const sesiRow = db.prepare(`
        SELECT s.*, u.id as ulangan_id
        FROM ulangan_sesi s
        JOIN ulangan u ON s.ulangan_id = u.id
        WHERE UPPER(s.kode_sesi) = ?
      `).get(cleanCode);
      if (sesiRow) {
        sesiActive = sesiRow;
      }
    } catch (e) {}

    let ulangan = null;
    if (sesiActive) {
      if (sesiActive.status !== 'aktif') {
        return { valid: false, message: `Sesi ujian "${sesiActive.nama_sesi}" sedang dinonaktifkan oleh guru.` };
      }
      ulangan = db.prepare('SELECT id, judul, mata_pelajaran, tingkat_kelas, deskripsi, status, jumlah_soal_tampil, jumlah_soal_pg, jumlah_soal_pg_kompleks, jumlah_soal_isian, jumlah_soal_essay, jumlah_soal_koding, jumlah_soal_listening, acak_soal, tanggal_mulai, tanggal_selesai, durasi_menit, kkm, zona_waktu, tampilkan_simbol, link_kisi_kisi, konten_kisi_kisi, tampilkan_kisi_kisi, tampilkan_teks_listening, pin_aktif, token_ujian, remedial_langsung, maksimal_percobaan, kebijakan_nilai FROM ulangan WHERE id = ?').get(sesiActive.ulangan_id);
    } else {
      ulangan = db.prepare('SELECT id, judul, mata_pelajaran, tingkat_kelas, deskripsi, status, jumlah_soal_tampil, jumlah_soal_pg, jumlah_soal_pg_kompleks, jumlah_soal_isian, jumlah_soal_essay, jumlah_soal_koding, jumlah_soal_listening, acak_soal, tanggal_mulai, tanggal_selesai, durasi_menit, kkm, zona_waktu, tampilkan_simbol, link_kisi_kisi, konten_kisi_kisi, tampilkan_kisi_kisi, tampilkan_teks_listening, pin_aktif, token_ujian, remedial_langsung, maksimal_percobaan, kebijakan_nilai FROM ulangan WHERE kode_ujian = ?').get(cleanCode);
    }

    if (!ulangan) {
      return { valid: false, message: 'Kode ulangan tidak ditemukan' };
    }

    const isRemedialSesi = Boolean(sesiActive && /^remedial\b/i.test(String(sesiActive.nama_sesi || '')) && sesiActive.status === 'aktif');
    if (ulangan.status !== 'dibuka') {
      if (!sesiActive || (ulangan.status === 'selesai' && !isRemedialSesi)) {
        let msg = 'Ulangan ini belum dibuka oleh guru';
        if (ulangan.status === 'ditutup' || ulangan.status === 'selesai') {
          msg = 'Ulangan ini sudah ditutup dan tidak menerima pengerjaan baru';
        }
        return { valid: false, status: ulangan.status, message: msg };
      }
    }

    const now = new Date();
    const zw = ulangan.zona_waktu || 'WIB';

    // Jika masuk melalui Token Sesi, periksa rentang tanggal dan jam sesi
    if (sesiActive) {
      if (sesiActive.waktu_mulai) {
        const startSesi = new Date(sesiActive.waktu_mulai);
        if (now < startSesi) {
          const scheduleStr = examService.formatIndonesianDateTime(sesiActive.waktu_mulai, zw);
          const serverNowStr = examService.formatIndonesianDateTime(now.toISOString(), zw);
          return {
            valid: false,
            status: 'sesi_belum_buka',
            message: `Sesi "${sesiActive.nama_sesi}" belum dibuka. Jadwal buka sesi: ${scheduleStr} (Waktu server saat ini: ${serverNowStr})`
          };
        }
      }
      if (sesiActive.waktu_selesai) {
        const endSesi = new Date(sesiActive.waktu_selesai);
        if (now > endSesi) {
          const scheduleStr = examService.formatIndonesianDateTime(sesiActive.waktu_selesai, zw);
          return {
            valid: false,
            status: 'sesi_sudah_tutup',
            message: `Sesi "${sesiActive.nama_sesi}" telah berakhir pada: ${scheduleStr}`
          };
        }
      }
    } else {
      // Validasi jadwal umum ulangan jika tidak menggunakan sesi
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

    // Jika masuk dengan sesi dan sesi memiliki batasan kelas khusus, batasi pilihan kelas
    if (sesiActive && sesiActive.kelas && sesiActive.kelas.trim()) {
      const parsedSesiKelas = sesiActive.kelas.split(/[,;/]+/).map(s => s.trim()).filter(Boolean);
      if (parsedSesiKelas.length > 0) {
        kelasList = parsedSesiKelas;
      }
    }

    const soalDikerjakan = (ulangan.jumlah_soal_tampil && ulangan.jumlah_soal_tampil < stats.total_soal)
      ? ulangan.jumlah_soal_tampil
      : stats.total_soal;

    const hasKisiLink = Boolean(ulangan.link_kisi_kisi && String(ulangan.link_kisi_kisi).trim());
    const hasKisiKonten = Boolean(ulangan.konten_kisi_kisi && String(ulangan.konten_kisi_kisi).trim());
    const isKisiShown = Boolean(ulangan.tampilkan_kisi_kisi && (hasKisiLink || hasKisiKonten));

    // Ambil daftar sesi aktif ulangan jika ada (untuk info bagi siswa)
    let daftarSesi = [];
    try {
      daftarSesi = db.prepare(`
        SELECT id, nama_sesi, kode_sesi, kelas, waktu_mulai, waktu_selesai
        FROM ulangan_sesi
        WHERE ulangan_id = ? AND status = 'aktif'
        ORDER BY waktu_mulai ASC, id ASC
      `).all(ulangan.id);
    } catch (e) {}

    const sesiFormatted = sesiActive ? {
      id: sesiActive.id,
      nama_sesi: sesiActive.nama_sesi,
      kode_sesi: sesiActive.kode_sesi,
      kelas: sesiActive.kelas,
      waktu_mulai: sesiActive.waktu_mulai,
      waktu_selesai: sesiActive.waktu_selesai,
      remedial_question_count: sesiActive.remedial_question_count,
      remedial_question_ratios: sesiActive.remedial_question_ratios,
      remedial_student_ids: sesiActive.remedial_student_ids,
      waktu_mulai_formatted: sesiActive.waktu_mulai ? examService.formatIndonesianDateTime(sesiActive.waktu_mulai, zw) : null,
      waktu_selesai_formatted: sesiActive.waktu_selesai ? examService.formatIndonesianDateTime(sesiActive.waktu_selesai, zw) : null
    } : null;

    return {
      valid: true,
      sesi: sesiFormatted,
      daftar_sesi: daftarSesi,
      available_classes: kelasList,
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
        jumlah_soal_pg: ulangan.jumlah_soal_pg,
        jumlah_soal_pg_kompleks: ulangan.jumlah_soal_pg_kompleks,
        jumlah_soal_isian: ulangan.jumlah_soal_isian,
        jumlah_soal_essay: ulangan.jumlah_soal_essay,
        jumlah_soal_koding: ulangan.jumlah_soal_koding,
        jumlah_soal_listening: ulangan.jumlah_soal_listening,
        acak_soal: ulangan.acak_soal,
        tanggal_mulai: ulangan.tanggal_mulai,
        tanggal_selesai: ulangan.tanggal_selesai,
        durasi_menit: ulangan.durasi_menit,
        kkm: ulangan.kkm || 75,
        zona_waktu: ulangan.zona_waktu || 'WIB',
        tampilkan_simbol: (ulangan.tampilkan_simbol !== undefined && ulangan.tampilkan_simbol !== null) ? Number(ulangan.tampilkan_simbol) : 1,
        link_kisi_kisi: (isKisiShown && hasKisiLink) ? ulangan.link_kisi_kisi : null,
        konten_kisi_kisi: (isKisiShown && hasKisiKonten) ? ulangan.konten_kisi_kisi : null,
        tampilkan_kisi_kisi: isKisiShown ? 1 : 0,
        tampilkan_teks_listening: (ulangan.tampilkan_teks_listening !== undefined && ulangan.tampilkan_teks_listening !== null) ? Number(ulangan.tampilkan_teks_listening) : 0,
        pin_aktif: Number(ulangan.pin_aktif) === 1 ? 1 : 0,
        token_ujian: Number(ulangan.pin_aktif) === 1 ? (ulangan.token_ujian || null) : null,
        remedial_langsung: Number(ulangan.remedial_langsung || 0),
        maksimal_percobaan: (ulangan.maksimal_percobaan !== undefined && ulangan.maksimal_percobaan !== null) ? Number(ulangan.maksimal_percobaan) : 1,
        kebijakan_nilai: ulangan.kebijakan_nilai || 'tertinggi',
        available_classes: kelasList
      }
    };
  },

  // FR-07: Identitas Siswa & Memulai Pengerjaan (Mendukung Paket Soal Acak per Siswa & Multi-Sesi)
  // `requireExistingSessionToken` dipakai oleh endpoint publik agar nama/kelas
  // tidak lagi cukup untuk mengambil pengerjaan milik browser lain.
  startExam(
    kodeUjian,
    nama,
    kelas,
    sesiId = null,
    isRetake = false,
    requestedStudentSessionToken = null,
    requireExistingSessionToken = false,
    existingPengerjaanId = null,
    existingStudentSessionToken = null,
    allowQueuedNewEntry = false
  ) {
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

    // Cek pembatasan sesi (jika ulangan menggunakan sesi atau token sesi)
    let activeSesi = val.sesi || null;
    if (!activeSesi && sesiId) {
      try {
        const sRow = db.prepare("SELECT * FROM ulangan_sesi WHERE id = ? AND ulangan_id = ? AND status = 'aktif'").get(sesiId, ulanganId);
        if (sRow) activeSesi = sRow;
      } catch (e) {}
    }

    const isRemedialSession = Boolean(activeSesi && /^remedial\b/i.test(String(activeSesi.nama_sesi || '')));
    const allowRetakeFlow = Boolean(isRetake || isRemedialSession);

    if (activeSesi && activeSesi.kelas && activeSesi.kelas.trim()) {
      const allowedClasses = activeSesi.kelas.split(/[,;/]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
      if (allowedClasses.length > 0 && !allowedClasses.includes(cleanKelas.toLowerCase())) {
        throw new Error(`Sesi "${activeSesi.nama_sesi}" khusus untuk kelas ${activeSesi.kelas}. Kelas "${cleanKelas}" tidak diizinkan masuk ke sesi ini.`);
      }
    }

    if (isRemedialSession && activeSesi.remedial_student_ids) {
      let excludedStudentIds = [];
      try {
        const parsed = JSON.parse(activeSesi.remedial_student_ids);
        excludedStudentIds = Array.isArray(parsed)
          ? parsed.map(Number).filter(id => Number.isInteger(id) && id > 0)
          : [];
      } catch (e) {}
      if (excludedStudentIds.length > 0) {
        const matchingParticipants = db.prepare(`
          SELECT id FROM peserta
          WHERE ulangan_id = ?
            AND LOWER(TRIM(nama)) = LOWER(TRIM(?))
            AND LOWER(TRIM(kelas)) = LOWER(TRIM(?))
        `).all(ulanganId, cleanNama, cleanKelas);
        if (matchingParticipants.some(row => excludedStudentIds.includes(Number(row.id)))) {
          throw new Error('Nama ini termasuk daftar siswa yang tidak perlu mengulang pada sesi remedial.');
        }
      }
    }

    // Daftar nama pada sesi remedial adalah pengecualian untuk guru/sebaran.
    // Siswa tetap mengetik identitasnya sendiri; selama kelas dan jadwal valid,
    // siswa yang belum mengikuti ulangan utama juga boleh dibuatkan peserta baru.
    // Cek batas token ujian & kewajiban PIN HANYA jika sistem PIN / token aktif
    if (Number(val.ulangan.pin_aktif) === 1) {
      try {
        const pinServiceModule = require('./pinService');
        // Cek apakah peserta ini sudah pernah ada di peserta table
        const existingPeserta = db.prepare(
          'SELECT id FROM peserta WHERE ulangan_id = ? AND LOWER(nama) = LOWER(?) AND LOWER(kelas) = LOWER(?)'
        ).get(ulanganId, cleanNama, cleanKelas);
        const tokenCheck = pinServiceModule.checkTokenAvailable(ulanganId, existingPeserta?.id || null);
        if (!tokenCheck.allowed) {
          throw new Error(tokenCheck.message);
        }
      } catch (tokenErr) {
        if (tokenErr.message && tokenErr.message.includes('token')) {
          throw tokenErr;
        }
        // Jika error lain (misal modul tidak ada), abaikan saja
      }

      // Pastikan siswa sudah tervalidasi dengan PIN
      const pinSession = db.prepare(`
        SELECT id FROM pin_sessions 
        WHERE ulangan_id = ? AND is_used = 1 
          AND LOWER(TRIM(nama_siswa)) = LOWER(?) 
          AND LOWER(TRIM(kelas_siswa)) = LOWER(?)
      `).get(ulanganId, cleanNama, cleanKelas);
      if (!pinSession) {
        throw new Error('Ujian ini mewajibkan PIN sekali pakai. Silakan masukkan PIN yang valid dari guru Anda.');
      }
    }

    // Bukti sesi hanya boleh dipakai untuk attempt yang sama dan peserta yang sama.
    // Token dari URL/kode ujian tidak pernah dianggap sebagai bukti kepemilikan.
    let provedPengerjaan = null;
    if ((existingPengerjaanId || existingStudentSessionToken) && !allowQueuedNewEntry) {
      if (existingPengerjaanId && !existingStudentSessionToken) {
        const err = new Error('Bukti sesi siswa tidak lengkap. Silakan masuk kembali.');
        err.code = 'INVALID_STUDENT_SESSION';
        throw err;
      }
      if (existingPengerjaanId) {
        provedPengerjaan = this.verifyStudentSession(existingPengerjaanId, existingStudentSessionToken);
      } else {
        // Ticket antrean menyimpan token lama; token unik cukup untuk
        // menemukan attempt tanpa menaruh ID pengerjaan di tiket publik.
        const tokenRow = db.prepare('SELECT * FROM pengerjaan WHERE student_session_token = ?').get(existingStudentSessionToken);
        provedPengerjaan = tokenRow ? this.verifyStudentSession(tokenRow.id, existingStudentSessionToken) : null;
      }
      if (!provedPengerjaan || Number(provedPengerjaan.ulangan_id) !== Number(ulanganId)) {
        const err = new Error('Sesi siswa sudah tidak valid atau sudah berganti.');
        err.code = 'INVALID_STUDENT_SESSION';
        throw err;
      }
      const provedPeserta = db.prepare('SELECT id, ulangan_id, nama, kelas FROM peserta WHERE id = ?').get(provedPengerjaan.peserta_id);
      if (!provedPeserta || Number(provedPeserta.ulangan_id) !== Number(ulanganId)
        || provedPeserta.nama.trim().toLowerCase() !== cleanNama.toLowerCase()
        || provedPeserta.kelas.trim().toLowerCase() !== cleanKelas.toLowerCase()) {
        const err = new Error('Identitas siswa tidak cocok dengan sesi yang dipilih.');
        err.code = 'INVALID_STUDENT_SESSION';
        throw err;
      }
    }

    if (isRetake && requireExistingSessionToken && !provedPengerjaan) {
      const err = new Error('Untuk ujian ulang, sesi ujian sebelumnya harus diverifikasi terlebih dahulu.');
      err.code = 'INVALID_STUDENT_SESSION';
      throw err;
    }

    // Sesi publik baru tidak boleh memakai peserta lama hanya karena nama/kelas sama.
    // Pemanggilan internal lama (tanpa strict mode) tetap mempertahankan perilaku rejoin.
    const namedPeserta = db.prepare('SELECT id, ulangan_id, nama, kelas FROM peserta WHERE ulangan_id = ? AND LOWER(nama) = LOWER(?) AND LOWER(kelas) = LOWER(?)').get(ulanganId, cleanNama, cleanKelas);

    let peserta;
    if (provedPengerjaan) {
      peserta = db.prepare('SELECT id, ulangan_id, nama, kelas FROM peserta WHERE id = ?').get(provedPengerjaan.peserta_id);
    } else if (!requireExistingSessionToken) {
      // Pemanggilan service internal lama boleh melakukan rejoin berdasarkan
      // identitas. Endpoint HTTP siswa selalu memakai strict mode.
      peserta = namedPeserta;
    }

    if (!peserta) {
      const pInfo = db.prepare('INSERT INTO peserta (ulangan_id, nama, kelas) VALUES (?, ?, ?)').run(ulanganId, cleanNama, cleanKelas);
      peserta = { id: pInfo.lastInsertRowid, ulangan_id: ulanganId, nama: cleanNama, kelas: cleanKelas };
    }

    // Cek pengerjaan aktif atau submitted. Strict mode hanya boleh rejoin
    // attempt yang dibuktikan oleh token; login baru selalu membuat attempt baru.
    let pengerjaan = null;
    if (provedPengerjaan) {
      if (provedPengerjaan.status === 'mengerjakan' && allowRetakeFlow) {
        const err = new Error('Sesi ujian sebelumnya masih aktif. Selesaikan atau kumpulkan dahulu sebelum mengulang.');
        err.code = 'INVALID_STUDENT_SESSION';
        throw err;
      }
      pengerjaan = provedPengerjaan.status === 'mengerjakan' ? provedPengerjaan : null;
    } else if (!requireExistingSessionToken) {
      pengerjaan = db.prepare("SELECT * FROM pengerjaan WHERE ulangan_id = ? AND peserta_id = ? AND status = 'mengerjakan' ORDER BY attempt_ke DESC, id DESC").get(ulanganId, peserta.id);
    }
    if (pengerjaan) {
      pengerjaan = this.ensureStudentSessionToken(pengerjaan);
      pengerjaan = this.ensureStudentRecoveryToken(pengerjaan);
    }

    // Ambil seluruh riwayat pengerjaan yang sudah submitted
    const submittedAttempts = db.prepare("SELECT * FROM pengerjaan WHERE ulangan_id = ? AND peserta_id = ? AND status = 'submitted' ORDER BY attempt_ke DESC, id DESC").all(ulanganId, peserta.id);
    const countSubmitted = submittedAttempts.length;
    const remedialSubmittedCount = isRemedialSession && activeSesi
      ? submittedAttempts.filter(attempt => Number(attempt.sesi_id) === Number(activeSesi.id)).length
      : 0;

    const maxAttempts = (val.ulangan.maksimal_percobaan !== undefined && val.ulangan.maksimal_percobaan !== null) ? Number(val.ulangan.maksimal_percobaan) : 1;
    const kebijakanNilai = val.ulangan.kebijakan_nilai || 'tertinggi';

    // Hitung nilai terbaik sejauh ini
    let nilaiTerbaik = null;
    if (countSubmitted > 0) {
      if (kebijakanNilai === 'terakhir') {
        nilaiTerbaik = submittedAttempts[0].nilai_final ?? submittedAttempts[0].nilai_ai;
      } else {
        const scores = submittedAttempts.map(a => Number(a.nilai_final ?? a.nilai_ai ?? 0));
        nilaiTerbaik = Math.max(...scores);
      }
    }

    if (!pengerjaan && countSubmitted > 0) {
      const latestSubmitted = submittedAttempts[0];
      const securedLatest = this.ensureStudentSessionToken(latestSubmitted);
      // Sesi remedial adalah sesi baru yang dibuat guru untuk siswa yang
      // belum tuntas. Batas percobaan ulangan utama tidak boleh memblokir
      // masuk ke sesi remedial tersebut.
      const maxReached = isRemedialSession
        ? (maxAttempts > 0 && remedialSubmittedCount >= maxAttempts)
        : (maxAttempts > 0 && countSubmitted >= maxAttempts);

      if (maxReached || !allowRetakeFlow) {
        return {
          alreadySubmitted: true,
          pengerjaanId: securedLatest.id,
          studentSessionToken: securedLatest.student_session_token,
          studentRecoveryToken: this.ensureStudentRecoveryToken(securedLatest).student_recovery_token,
          submittedAt: securedLatest.submitted_at,
          releasedAt: securedLatest.released_at,
          nilaiFinal: securedLatest.nilai_final,
          nilaiTerbaik: nilaiTerbaik,
          attemptKe: securedLatest.attempt_ke || countSubmitted,
          totalAttempts: countSubmitted,
          maksimalPercobaan: maxAttempts,
          sisaPercobaan: maxAttempts === 0 ? 'Tanpa Batas' : Math.max(0, maxAttempts - countSubmitted),
          canRetake: !maxReached,
          kebijakanNilai: kebijakanNilai,
          maxAttemptsReached: maxReached,
          message: maxReached 
            ? `Anda sudah mencapai batas maksimal pengerjaan (${maxAttempts}x).` 
            : `Anda sudah mengumpulkan ulangan ini sebelumnya. (Percobaan ${latestSubmitted.attempt_ke || countSubmitted} dari ${maxAttempts === 0 ? 'Tanpa Batas' : maxAttempts})`
        };
      }
    }

    // Deteksi jika pengerjaan sebelumnya pada komputer ini sudah kadaluarsa (waktu habis)
    if (pengerjaan && pengerjaan.status === 'mengerjakan') {
      let isExpired = false;
      if (pengerjaan.remedial_deadline_at) {
        const remedialDeadline = parseStoredDate(pengerjaan.remedial_deadline_at);
        if (remedialDeadline && new Date() > remedialDeadline) isExpired = true;
      } else if (val.ulangan.durasi_menit) {
        const startedAtStr = pengerjaan.started_at
          ? (pengerjaan.started_at.includes('T') ? pengerjaan.started_at : pengerjaan.started_at.replace(' ', 'T') + 'Z')
          : new Date().toISOString();
        const startedAt = new Date(startedAtStr);
        const durationDeadline = new Date(startedAt.getTime() + val.ulangan.durasi_menit * 60 * 1000);
        if (new Date() > durationDeadline) {
          isExpired = true;
        }
      }
      if (val.ulangan.tanggal_selesai) {
        const closeDeadline = new Date(val.ulangan.tanggal_selesai);
        if (new Date() > closeDeadline) {
          isExpired = true;
        }
      }
      if (isExpired) {
        try {
          this.submitExam(pengerjaan.id, [], pengerjaan.paste_count || 0, true);
        } catch (eExp) {}
        const refreshedSubmitted = db.prepare("SELECT * FROM pengerjaan WHERE ulangan_id = ? AND peserta_id = ? AND status = 'submitted' ORDER BY attempt_ke DESC, id DESC").all(ulanganId, peserta.id).map(row => this.ensureStudentSessionToken(row));
        const refreshedCount = refreshedSubmitted.length;
        const refreshedRemedialCount = isRemedialSession && activeSesi
          ? refreshedSubmitted.filter(attempt => Number(attempt.sesi_id) === Number(activeSesi.id)).length
          : 0;
        const maxReached = isRemedialSession
          ? (maxAttempts > 0 && refreshedRemedialCount >= maxAttempts)
          : (maxAttempts > 0 && refreshedCount >= maxAttempts);
        if (maxReached || !allowRetakeFlow) {
          const latest = refreshedSubmitted[0];
          return {
            alreadySubmitted: true,
            pengerjaanId: latest ? latest.id : pengerjaan.id,
            studentSessionToken: latest ? latest.student_session_token : pengerjaan.student_session_token,
            submittedAt: latest ? latest.submitted_at : new Date().toISOString(),
            releasedAt: latest ? latest.released_at : null,
            nilaiFinal: latest ? latest.nilai_final : null,
            nilaiTerbaik: nilaiTerbaik,
            attemptKe: latest ? (latest.attempt_ke || refreshedCount) : 1,
            totalAttempts: refreshedCount,
            maksimalPercobaan: maxAttempts,
            sisaPercobaan: maxAttempts === 0 ? 'Tanpa Batas' : Math.max(0, maxAttempts - refreshedCount),
            canRetake: !maxReached,
            kebijakanNilai: kebijakanNilai,
            maxAttemptsReached: maxReached,
            message: 'Batas waktu pengerjaan sebelumnya telah habis.'
          };
        }
        pengerjaan = null;
      }
    }

    // Jika siswa masuk kembali setelah sempat terputus / DC,
    // perbarui last_active_at ke waktu saat ini agar batas toleransi DC di-reset kembali ke 1 jam penuh
    if (pengerjaan && pengerjaan.status === 'mengerjakan') {
      db.prepare('UPDATE pengerjaan SET last_active_at = CURRENT_TIMESTAMP, disconnected_at = NULL WHERE id = ?').run(pengerjaan.id);
      pengerjaan.last_active_at = new Date().toISOString();
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

    const ulanganInfo = db.prepare('SELECT jumlah_soal_tampil, jumlah_soal_pg, jumlah_soal_pg_kompleks, jumlah_soal_isian, jumlah_soal_essay, jumlah_soal_koding, jumlah_soal_listening, acak_soal FROM ulangan WHERE id = ?').get(ulanganId);
    let soalList = [];

    if (Array.isArray(assignedQuestionIds) && assignedQuestionIds.length > 0) {
      // Siswa sudah memulai sebelumnya: muat soal yang sama persis (persisten / anti-refresh)
      const placeholders = assignedQuestionIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT id, nomor, jenis, pertanyaan, gambar_url, bobot, tingkat_kelas, urutan, audio_url, audio_script, is_listening, bahasa, tampilkan_teks_listening, opsi_a, opsi_b, opsi_c, opsi_d, opsi_e, game_data, kunci_pg
        FROM soal
        WHERE id IN (${placeholders})
      `).all(...assignedQuestionIds);

      const rowMap = new Map(rows.map(r => [r.id, r]));
      soalList = assignedQuestionIds.map(id => rowMap.get(id)).filter(Boolean);
    } else {
      // Pengerjaan baru: ambil semua soal dari bank soal
      const allQuestions = db.prepare(`
        SELECT id, nomor, jenis, pertanyaan, gambar_url, bobot, tingkat_kelas, urutan, audio_url, audio_script, is_listening, bahasa, tampilkan_teks_listening, opsi_a, opsi_b, opsi_c, opsi_d, opsi_e, game_data, kunci_pg
        FROM soal
        WHERE ulangan_id = ?
        ORDER BY urutan ASC, nomor ASC
      `).all(ulanganId);

      const hasRemedialQuestionConfig = Boolean(
        activeSesi && /^remedial\b/i.test(String(activeSesi.nama_sesi || ''))
          && (activeSesi.remedial_question_count || activeSesi.remedial_question_ratios)
      );
      if (hasRemedialQuestionConfig) {
        let ratios = null;
        if (activeSesi.remedial_question_ratios) {
          try { ratios = JSON.parse(activeSesi.remedial_question_ratios); } catch (e) { ratios = null; }
        }
        const target = activeSesi.remedial_question_count || allQuestions.length;
        soalList = ratios
          ? packageService.sampleQuestionsWithRatios(allQuestions, target, ratios, `remedial-${activeSesi.id}-${peserta.id}`)
          : packageService.sampleQuestionsWithFairRatio(allQuestions, target, `remedial-${activeSesi.id}-${peserta.id}`);
      }

      const limitSoal = ulanganInfo?.jumlah_soal_tampil;
      const targetPg = (ulanganInfo?.jumlah_soal_pg !== undefined && ulanganInfo?.jumlah_soal_pg !== null) ? Math.max(0, Number(ulanganInfo.jumlah_soal_pg)) : null;
      const targetPgKompleks = (ulanganInfo?.jumlah_soal_pg_kompleks !== undefined && ulanganInfo?.jumlah_soal_pg_kompleks !== null) ? Math.max(0, Number(ulanganInfo.jumlah_soal_pg_kompleks)) : null;
      const targetIsian = (ulanganInfo?.jumlah_soal_isian !== undefined && ulanganInfo?.jumlah_soal_isian !== null) ? Math.max(0, Number(ulanganInfo.jumlah_soal_isian)) : null;
      const targetEssay = (ulanganInfo?.jumlah_soal_essay !== undefined && ulanganInfo?.jumlah_soal_essay !== null) ? Math.max(0, Number(ulanganInfo.jumlah_soal_essay)) : null;
      const targetKoding = (ulanganInfo?.jumlah_soal_koding !== undefined && ulanganInfo?.jumlah_soal_koding !== null) ? Math.max(0, Number(ulanganInfo.jumlah_soal_koding)) : null;
      const targetListening = (ulanganInfo?.jumlah_soal_listening !== undefined && ulanganInfo?.jumlah_soal_listening !== null)
        ? Math.max(0, Number(ulanganInfo.jumlah_soal_listening))
        : null;

      const quotas = {
        pilihan_ganda: (targetPg !== null && targetPg > 0) ? targetPg : 0,
        pg_kompleks: (targetPgKompleks !== null && targetPgKompleks > 0) ? targetPgKompleks : 0,
        isian: (targetIsian !== null && targetIsian > 0) ? targetIsian : 0,
        essay: (targetEssay !== null && targetEssay > 0) ? targetEssay : 0,
        koding_game: (targetKoding !== null && targetKoding > 0) ? targetKoding : 0
      };

      const hasSpecificQuota = Object.values(quotas).some(q => q > 0);
      const hasListeningLimit = (targetListening !== null);
      const isAcak = (ulanganInfo?.acak_soal === 1);
      const needRandom = isAcak || (limitSoal && limitSoal < allQuestions.length) || hasSpecificQuota || hasListeningLimit;

      const isPgKompleks = (q) => q.jenis === 'pilihan_ganda' && (q.tipe_pg === 'pg_kompleks' || (typeof q.kunci_pg === 'string' && (q.kunci_pg.includes(',') || q.kunci_pg.trim().length > 1)));
      const isPgBiasa = (q) => q.jenis === 'pilihan_ganda' && !isPgKompleks(q);
      const isIsian = (q) => q.jenis === 'isian';
      const isEssay = (q) => q.jenis === 'essay';
      const isKoding = (q) => q.jenis === 'koding_game';

      const getCategory = (q) => {
        if (isKoding(q)) return 'koding_game';
        if (isPgKompleks(q)) return 'pg_kompleks';
        if (isPgBiasa(q)) return 'pilihan_ganda';
        if (isIsian(q)) return 'isian';
        if (isEssay(q)) return 'essay';
        return q.jenis;
      };

      const shuffleArr = (arr) => {
        const res = [...arr];
        for (let i = res.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [res[i], res[j]] = [res[j], res[i]];
        }
        return res;
      };

      if (hasRemedialQuestionConfig) {
        // Sesi remedial sudah memilih soal berdasarkan konfigurasi link.
      } else if (hasListeningLimit) {
        // Kuota khusus soal listening: pisahkan pool listening dan non-listening
        const listeningPool = allQuestions.filter(q => Number(q.is_listening) === 1);
        const nonListeningPool = allQuestions.filter(q => Number(q.is_listening) !== 1);

        const maxListening = Math.min(targetListening, listeningPool.length);
        const readyListening = (isAcak || maxListening < listeningPool.length) ? shuffleArr(listeningPool) : [...listeningPool];
        const selectedListening = readyListening.slice(0, maxListening);

        if (hasSpecificQuota) {
          const remainingQuotas = { ...quotas };
          for (const q of selectedListening) {
            const cat = getCategory(q);
            if (remainingQuotas[cat] > 0) remainingQuotas[cat]--;
          }

          let selectedNonListening = [];
          for (const [cat, needed] of Object.entries(remainingQuotas)) {
            if (needed <= 0) continue;
            const pool = nonListeningPool.filter(q => getCategory(q) === cat);
            const ready = (isAcak || needed < pool.length) ? shuffleArr(pool) : [...pool];
            selectedNonListening.push(...ready.slice(0, Math.min(needed, pool.length)));
          }

          let combined = [...selectedListening, ...selectedNonListening];

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
          // Tanpa kuota spesifik per tipe: sisa diambil dari nonListeningPool
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
        let combined = [];
        for (const [cat, needed] of Object.entries(quotas)) {
          if (needed <= 0) continue;
          const pool = allQuestions.filter(q => getCategory(q) === cat);
          const ready = (isAcak || needed < pool.length) ? shuffleArr(pool) : [...pool];
          combined.push(...ready.slice(0, Math.min(needed, pool.length)));
        }

        // Jika ada limitSoal total yang lebih besar dari target kuota wajib, lengkapi sisa kuota dari sisa pool
        if (limitSoal && limitSoal > combined.length) {
          const chosenIds = new Set(combined.map(s => s.id));
          const unchosen = allQuestions.filter(q => !chosenIds.has(q.id));
          const remainingPool = isAcak ? shuffleArr(unchosen) : unchosen;
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
      const sesiIdToSave = activeSesi?.id || null;
      const namaSesiToSave = activeSesi?.nama_sesi || null;

      const currentAttemptKe = (pengerjaan && pengerjaan.attempt_ke) ? pengerjaan.attempt_ke : (countSubmitted + 1);

      if (!pengerjaan) {
        let studentSessionToken = requestedStudentSessionToken || createStudentSessionToken();
        if (db.prepare('SELECT id FROM pengerjaan WHERE student_session_token = ?').get(studentSessionToken)) {
          studentSessionToken = createStudentSessionToken();
        }
        const studentRecoveryToken = createStudentRecoveryToken();
        const info = db.prepare(`
          INSERT INTO pengerjaan (ulangan_id, peserta_id, status, soal_ids, started_at, last_active_at, sesi_id, nama_sesi, attempt_ke, student_session_token, student_recovery_token, student_recovery_issued_at)
          VALUES (?, ?, 'mengerjakan', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(ulanganId, peserta.id, soalIdsJson, nowIso, nowIso, sesiIdToSave, namaSesiToSave, currentAttemptKe, studentSessionToken, studentRecoveryToken, nowIso);
        pengerjaan = db.prepare('SELECT * FROM pengerjaan WHERE id = ?').get(info.lastInsertRowid);
        // Jika attempt berasal dari ruang tunggu, reservasinya sudah memenuhi
        // slot; hapus klaim sementara setelah row pengerjaan benar-benar ada.
        try {
          db.prepare('DELETE FROM ruang_tunggu_seat WHERE student_session_token = ?').run(studentSessionToken);
        } catch (_) {}
        // Segera dorong pengerjaan baru ke Turso Cloud agar instance Vercel lain dapat langsung menemukannya
        if (typeof db.sync === 'function') {
          try { db.sync(); } catch (syncErr) {}
        }
      } else {
        pengerjaan = this.ensureStudentSessionToken(pengerjaan);
        pengerjaan = this.ensureStudentRecoveryToken(pengerjaan);
        db.prepare(`
          UPDATE pengerjaan 
          SET soal_ids = ?, last_active_at = CURRENT_TIMESTAMP, 
              sesi_id = COALESCE(sesi_id, ?), 
              nama_sesi = COALESCE(nama_sesi, ?),
              attempt_ke = COALESCE(attempt_ke, ?)
          WHERE id = ?
        `).run(soalIdsJson, sesiIdToSave, namaSesiToSave, currentAttemptKe, pengerjaan.id);
        pengerjaan.soal_ids = soalIdsJson;
        if (typeof db.sync === 'function') {
          try { db.sync(); } catch (syncErr) {}
        }
      }
    }

    // Ambil draft jawaban yang tersimpan di server jika ada (misal siswa login ulang)
    const existingJawabanRows = db.prepare('SELECT soal_id, jawaban_siswa FROM jawaban WHERE pengerjaan_id = ?').all(pengerjaan.id);
    const existingJawabanMap = new Map(existingJawabanRows.map(j => [j.soal_id, j.jawaban_siswa]));

    // Berikan nomor urut tampilan yang rapi 1..N, set tipe_pg, dan sertakan jawaban_siswa jika ada
    const displaySoalList = soalList.map((s, idx) => {
      const isKompleks = s.jenis === 'pilihan_ganda' && (s.tipe_pg === 'pg_kompleks' || (typeof s.kunci_pg === 'string' && (s.kunci_pg.includes(',') || s.kunci_pg.trim().length > 1)));
      const item = {
        ...s,
        nomor: idx + 1,
        tipe_pg: isKompleks ? 'pg_kompleks' : 'pg_biasa',
        jawaban_siswa: existingJawabanMap.get(s.id) || ''
      };
      delete item.kunci_pg;
      return item;
    });

    // Hitung batas waktu deadline pengerjaan siswa
    let deadlineAt = null;
    const startedAtStr = pengerjaan.started_at
      ? (pengerjaan.started_at.includes('T') ? pengerjaan.started_at : pengerjaan.started_at.replace(' ', 'T') + 'Z')
      : new Date().toISOString();
    const startedAt = new Date(startedAtStr);

    if (pengerjaan?.remedial_deadline_at) {
      deadlineAt = parseStoredDate(pengerjaan.remedial_deadline_at);
    } else if (val.ulangan.durasi_menit) {
      const durationDeadline = new Date(startedAt.getTime() + val.ulangan.durasi_menit * 60 * 1000);
      deadlineAt = durationDeadline;
    }

    if (val.ulangan.tanggal_selesai && !isRemedialSession) {
      const closeDeadline = new Date(val.ulangan.tanggal_selesai);
      if (!deadlineAt || closeDeadline < deadlineAt) {
        deadlineAt = closeDeadline;
      }
    }

    if (activeSesi && activeSesi.waktu_selesai) {
      const sessionClose = new Date(activeSesi.waktu_selesai);
      if (!deadlineAt || sessionClose < deadlineAt) {
        deadlineAt = sessionClose;
      }
    }

    return {
      alreadySubmitted: false,
      pengerjaanId: pengerjaan.id,
      studentSessionToken: pengerjaan.student_session_token,
      studentRecoveryToken: this.ensureStudentRecoveryToken(pengerjaan).student_recovery_token,
      peserta: { id: peserta.id, nama: cleanNama, kelas: cleanKelas },
      sesi: activeSesi || null,
      ulangan: val.ulangan,
      deadline_at: deadlineAt ? deadlineAt.toISOString() : null,
      server_time: new Date().toISOString(),
      soal: displaySoalList,
      attemptKe: pengerjaan.attempt_ke || (countSubmitted + 1),
      totalAttempts: countSubmitted + 1,
      maksimalPercobaan: maxAttempts,
      kebijakanNilai: kebijakanNilai,
      nilaiTerbaik: nilaiTerbaik
    };
  },

  // Helper ambil pengerjaan dengan fallback sync replica Turso (mengatasi multi-instance cold start Vercel)
  findPengerjaanWithSync(id) {
    if (!id) return null;
    const numId = Number(id);
    const cleanId = isNaN(numId) ? id : numId;
    let row = db.prepare('SELECT * FROM pengerjaan WHERE id = ?').get(cleanId);
    if (row) return row;

    if (typeof db.sync === 'function') {
      const delays = [150, 300, 500, 800, 1200];
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          db.sync();
        } catch (e) {
          console.warn(`[findPengerjaanWithSync] Sync attempt ${attempt} warning:`, e.message);
        }
        row = db.prepare('SELECT * FROM pengerjaan WHERE id = ?').get(cleanId);
        if (row) return row;
        if (attempt < 5) {
          const waitTill = Date.now() + (delays[attempt - 1] || 300);
          while (Date.now() < waitTill) {}
        }
      }
    }
    return row || null;
  },

  // Klaim pelepasan slot secara atomik. Ini tetap aman ketika retry submit
  // masuk ke instance Vercel yang berbeda pada saat yang sama.
  claimSubmitSlotRelease(pengerjaanId) {
    if (!pengerjaanId) return false;
    const result = db.prepare(`
      UPDATE pengerjaan
      SET submit_slot_released_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'submitted'
        AND (submit_slot_released_at IS NULL OR submit_slot_released_at = '')
    `).run(pengerjaanId);
    return Number(result?.changes || 0) === 1;
  },

  // Auto-Save Draft Jawaban Siswa (Sinkronisasi berkala dari HP/Klien ke Server)
  saveDraft(pengerjaanId, rawAnswers, pasteCount = null, pasteDetails = null, studentSessionToken = null) {
    if (!pengerjaanId) throw new Error('ID pengerjaan tidak valid');
    const pengerjaan = this.findPengerjaanWithSync(pengerjaanId);
    if (!pengerjaan) {
      throw new Error('Data pengerjaan tidak ditemukan');
    }
    if (studentSessionToken && !this.verifyStudentSession(pengerjaanId, studentSessionToken)) {
      throw new Error('Akses ditolak: token sesi siswa tidak valid');
    }
    if (pengerjaan.status === 'submitted') {
      return { success: true, message: 'Ulangan sudah dikumpulkan', alreadySubmitted: true };
    }
    // Jangan biarkan autosave yang terlambat menimpa payload submit yang
    // sedang diproses. Request submit akan menghapus lock setelah commit.
    if (pengerjaan.submit_lock_token) {
      return { success: true, message: 'Pengumpulan jawaban sedang diproses', submitInProgress: true, savedCount: 0 };
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
  submitExam(pengerjaanId, rawAnswers, pasteCount = 0, isAutoSubmit = false, pasteDetails = null, studentSessionToken = null) {
    const pengerjaan = this.findPengerjaanWithSync(pengerjaanId);
    if (!pengerjaan) {
      throw new Error('Data pengerjaan tidak ditemukan');
    }
    if (studentSessionToken && !this.verifyStudentSession(pengerjaanId, studentSessionToken)) {
      throw new Error('Akses ditolak: token sesi siswa tidak valid');
    }

    if (pengerjaan.status === 'submitted') {
      return {
        success: true,
        message: 'Ulangan sudah pernah dikumpulkan sebelumnya',
        alreadySubmitted: true,
        submitted_at: pengerjaan.submitted_at
      };
    }

    // Server-side guard: remedial hanya berjalan 10 menit sejak dimulai.
    // Jika request terlambat karena jaringan, tetap proses draft terakhir sebagai
    // auto-submit agar jawaban yang sudah tersimpan tidak hilang.
    if (pengerjaan.remedial_deadline_at) {
      const remedialDeadline = parseStoredDate(pengerjaan.remedial_deadline_at);
      if (remedialDeadline && Date.now() > remedialDeadline.getTime()) isAutoSubmit = true;
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

    // Klaim atomik sebelum memproses semua jawaban. Retry yang datang saat
    // request pertama masih berjalan tidak boleh mengevaluasi attempt dua kali.
    const submitLockToken = createStudentSessionToken();
    const submitStartedAt = new Date().toISOString();
    const claim = db.prepare(`
      UPDATE pengerjaan
      SET submit_lock_token = ?, submit_started_at = ?
      WHERE id = ? AND status = 'mengerjakan'
        AND (
          submit_lock_token IS NULL OR submit_lock_token = ''
          OR submit_started_at IS NULL
          OR julianday('now') - julianday(submit_started_at) > 0.00138889
        )
    `).run(submitLockToken, submitStartedAt, pengerjaanId);

    if (!claim || Number(claim.changes || 0) !== 1) {
      const current = this.findPengerjaanWithSync(pengerjaanId);
      if (current && current.status === 'submitted') {
        return {
          success: true,
          message: 'Ulangan sudah pernah dikumpulkan sebelumnya',
          alreadySubmitted: true,
          submitted_at: current.submitted_at
        };
      }
      const inProgress = new Error('Pengumpulan jawaban sedang diproses. Silakan tunggu sebentar.');
      inProgress.code = 'SUBMIT_IN_PROGRESS';
      throw inProgress;
    }

    let totalPg = 0;
    let benarPg = 0;
    let totalKoding = 0;
    let sumKodingScorePct = 0;
    let computedSkorKoding = null;
    let hasEssayOrIsian = false;
    let computedSkorPg = null;

    // Transaksi penyimpanan jawaban agar atomik
    const insertOrUpdateJawaban = db.transaction(() => {
      const checkStmt = db.prepare('SELECT id, jawaban_siswa FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?');
      const soalInfoStmt = db.prepare('SELECT id, bobot, jenis, kunci_pg, game_data FROM soal WHERE id = ?');

      const upsertStmt = db.prepare(`
        INSERT INTO jawaban (pengerjaan_id, soal_id, jawaban_siswa, skor_maksimum, status_penilaian, paste_count)
        VALUES (?, ?, ?, ?, 'menunggu', ?)
        ON CONFLICT(pengerjaan_id, soal_id) DO UPDATE 
        SET jawaban_siswa = excluded.jawaban_siswa,
             skor_maksimum = excluded.skor_maksimum,
             status_penilaian = 'menunggu',
             paste_count = MAX(COALESCE(jawaban.paste_count, 0), excluded.paste_count)
      `);

      const upsertPgStmt = db.prepare(`
        INSERT INTO jawaban (pengerjaan_id, soal_id, jawaban_siswa, skor_maksimum, skor_rekomendasi, status_jawaban, status_penilaian, alasan_ai, paste_count)
        VALUES (?, ?, ?, ?, ?, ?, 'selesai', ?, ?)
        ON CONFLICT(pengerjaan_id, soal_id) DO UPDATE 
        SET jawaban_siswa = excluded.jawaban_siswa,
             skor_maksimum = excluded.skor_maksimum,
             skor_rekomendasi = excluded.skor_rekomendasi,
             status_jawaban = excluded.status_jawaban,
             status_penilaian = 'selesai',
             alasan_ai = excluded.alasan_ai,
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
        const sInfo = soalInfoStmt.get(soalId);

        if (sInfo && sInfo.jenis === 'pilihan_ganda') {
          totalPg++;
          const rawKunci = (sInfo.kunci_pg || 'A').toUpperCase().trim();
          const rawAns = (finalJawaban || '').toUpperCase().trim();
          const isKompleks = rawKunci.includes(',') || rawKunci.length > 1;

          if (isKompleks) {
            // Evaluasi Pilihan Ganda Kompleks (Multi-Select)
            const correctSet = new Set(rawKunci.split(/[\s,]+/).filter(Boolean));
            let studentOptions = [];
            try {
              if (rawAns.startsWith('[') && rawAns.endsWith(']')) {
                studentOptions = JSON.parse(rawAns).map(x => String(x).toUpperCase().trim());
              } else {
                studentOptions = rawAns.split(/[\s,]+/).filter(Boolean);
              }
            } catch (e) {
              studentOptions = rawAns.split(/[\s,]+/).filter(Boolean);
            }
            const studentSet = new Set(studentOptions);

            const isExact = (correctSet.size === studentSet.size) && [...correctSet].every(k => studentSet.has(k));
            let statusJwb = 'salah';
            let skorRek = 0;
            let alasan = '';

            if (isExact) {
              benarPg++;
              statusJwb = 'benar';
              skorRek = Number(bobot);
              alasan = `Seluruh pilihan jawaban tepat (${[...correctSet].sort().join(', ')}).`;
            } else {
              let correctPicked = 0;
              let wrongPicked = 0;
              studentSet.forEach(a => {
                if (correctSet.has(a)) correctPicked++;
                else wrongPicked++;
              });
              const totalCorrect = correctSet.size || 1;
              const ratio = Math.max(0, (correctPicked - wrongPicked) / totalCorrect);
              if (ratio > 0) {
                benarPg += ratio;
                statusJwb = 'parsial';
                skorRek = Math.round(ratio * Number(bobot) * 100) / 100;
                alasan = `Pilihan sebagian tepat (${correctPicked}/${totalCorrect} benar). Kunci: ${[...correctSet].sort().join(', ')}.`;
              } else {
                statusJwb = 'salah';
                skorRek = 0;
                alasan = `Pilihan salah. Kunci jawaban: ${[...correctSet].sort().join(', ')}.`;
              }
            }
            upsertPgStmt.run(pengerjaanId, soalId, finalJawaban, bobot, skorRek, statusJwb, alasan, itemPaste);
          } else {
            // Evaluasi Pilihan Ganda Tunggal
            const isBenar = rawAns === rawKunci;
            if (isBenar) benarPg++;
            const statusJwb = isBenar ? 'benar' : 'salah';
            const skorRek = isBenar ? Number(bobot) : 0;
            const alasan = isBenar ? 'Pilihan jawaban tepat sesuai kunci.' : `Pilihan salah. Kunci jawaban: ${rawKunci}`;
            upsertPgStmt.run(pengerjaanId, soalId, finalJawaban, bobot, skorRek, statusJwb, alasan, itemPaste);
          }
        } else if (sInfo && sInfo.jenis === 'koding_game') {
          totalKoding++;
          const evalResult = codingGameService.evaluateSolution(sInfo.game_data, finalJawaban);
          sumKodingScorePct += evalResult.score;
          const skorRek = Math.round(((evalResult.score / 100) * Number(bobot)) * 100) / 100;
          const statusJwb = evalResult.starsEarned >= 2 ? 'benar' : (evalResult.starsEarned === 1 ? 'parsial' : 'salah');
          let alasan = '';
          if (evalResult.mode === 'scratch_puzzle') {
            alasan = `Cocok: ${evalResult.correctCount}/${evalResult.total} pasangan balok. Bintang: ${evalResult.starsEarned}/3.`;
          } else if (evalResult.mode === 'pattern_guesser') {
            alasan = `Tebak Pola: ${evalResult.isFinished ? 'Pola berhasil dipecahkan dengan tepat!' : 'Pilihan pola belum sesuai.'} Bintang: ${evalResult.starsEarned}/3. ${evalResult.explanation || ''}`;
          } else if (evalResult.mode === 'parsons_puzzle') {
            alasan = `Susun Algoritma: ${evalResult.isFinished ? 'Seluruh alur prosedur runtut 100%!' : `Posisi tepat: ${evalResult.correctPositions}/${evalResult.totalSteps}`}. Bintang: ${evalResult.starsEarned}/3.`;
          } else {
            alasan = `Bintang: ${evalResult.starsEarned}/3. ${evalResult.isFinished ? 'Robot sampai finish!' : 'Robot belum sampai finish.'} Blok: ${evalResult.blockCount}/${evalResult.parLimit}. Skor: ${evalResult.score}%.`;
          }
          upsertPgStmt.run(pengerjaanId, soalId, finalJawaban, bobot, skorRek, statusJwb, alasan, itemPaste);
          try {
            db.prepare('UPDATE jawaban SET jawaban_koding = ? WHERE pengerjaan_id = ? AND soal_id = ?').run(finalJawaban, pengerjaanId, soalId);
          } catch (e) {}
        } else {
          hasEssayOrIsian = true;
          upsertStmt.run(pengerjaanId, soalId, finalJawaban, bobot, itemPaste);
        }
      }

      computedSkorPg = totalPg > 0 ? Math.round((benarPg / totalPg) * 100 * 10) / 10 : null;
      computedSkorKoding = totalKoding > 0 ? Math.round((sumKodingScorePct / totalKoding) * 10) / 10 : null;

      const ulInfo = db.prepare('SELECT bobot_pg, bobot_koding, skor_langsung_ai FROM ulangan WHERE id = ?').get(pengerjaan.ulangan_id);
      const skorLangsungAi = Boolean(Number(ulInfo?.skor_langsung_ai) === 1);

      // Jika seluruh soal adalah pilihan ganda / koding (tidak ada esai/isian), hitung nilai akhir seketika
      let nilaiFinal = null;
      if (!hasEssayOrIsian && (computedSkorPg !== null || computedSkorKoding !== null)) {
        const bPg = (computedSkorPg !== null) ? (Number(ulInfo?.bobot_pg) || (computedSkorKoding !== null ? 50 : 100)) : 0;
        const bKod = (computedSkorKoding !== null) ? (Number(ulInfo?.bobot_koding) || (computedSkorPg !== null ? 50 : 100)) : 0;
        const totalB = bPg + bKod;
        if (totalB > 0) {
          const weightedSum = ((computedSkorPg || 0) * bPg) + ((computedSkorKoding || 0) * bKod);
          nilaiFinal = Math.round((weightedSum / totalB) * 10) / 10;
        } else {
          nilaiFinal = computedSkorPg ?? computedSkorKoding ?? 0;
        }
      }

      // Update status pengerjaan ke submitted & catat skor_pg, skor_koding, nilai_final, paste_count
      const nowIso = new Date().toISOString();
      const pasteDetailsStr = pasteDetails && typeof pasteDetails === 'object' ? JSON.stringify(pasteDetails) : null;
      const autoReleaseIso = (!hasEssayOrIsian && skorLangsungAi) ? nowIso : null;

      db.prepare(`
        UPDATE pengerjaan 
        SET status = 'submitted', submitted_at = ?, paste_count = MAX(COALESCE(paste_count, 0), ?),
            auto_submitted = ?, paste_details = COALESCE(?, paste_details),
            submit_lock_token = NULL,
            submit_started_at = NULL,
            skor_pg = ?,
            skor_koding = ?,
            nilai_ai = COALESCE(?, nilai_ai),
            nilai_final = COALESCE(?, nilai_final),
            released_at = COALESCE(?, released_at)
        WHERE id = ?
      `).run(nowIso, Number(pasteCount) || 0, isAutoSubmit ? 1 : 0, pasteDetailsStr, computedSkorPg, computedSkorKoding, nilaiFinal, nilaiFinal, autoReleaseIso, pengerjaanId);
    });

    try {
      insertOrUpdateJawaban();
    } catch (err) {
      try {
        db.prepare(`
          UPDATE pengerjaan
          SET submit_lock_token = NULL, submit_started_at = NULL
          WHERE id = ? AND submit_lock_token = ?
        `).run(pengerjaanId, submitLockToken);
      } catch (releaseErr) {}
      throw err;
    }

    // Jika fitur Skor Langsung AI aktif dan ada soal Essay/Isian, masukkan ke antrean AI dinamis anti-limit
    const ulRowAfter = db.prepare('SELECT skor_langsung_ai FROM ulangan WHERE id = ?').get(pengerjaan.ulangan_id);
    const isSkorLangsungActive = Boolean(Number(ulRowAfter?.skor_langsung_ai) === 1);
    if (isSkorLangsungActive && hasEssayOrIsian) {
      try {
        const queueService = require('./queueService');
        queueService.enqueuePengerjaan(pengerjaanId);
        const isTestEnv = process.env.NODE_ENV === 'test' || process.argv.some(arg => arg.includes('test'));
        if (!isTestEnv) {
          queueService.startReview(pengerjaan.ulangan_id).catch(() => {});
        }
      } catch (qErr) {
        console.warn('⚠️ Auto-enqueue skor_langsung_ai notice:', qErr.message);
      }
    }

    // Penanganan Pengumpulan Jawaban Sesi Remedial Langsung
    let remedialRecalc = null;
    if (pengerjaan.remedial_ke && pengerjaan.remedial_ke > 0) {
      // 1. Evaluasi otomatis jika ada butir isian/essay pada sesi remedial
      const pendingAnswers = db.prepare(`
        SELECT j.id, j.jawaban_siswa, s.kunci_jawaban, s.rubrik, s.bobot, s.jenis, s.pertanyaan
        FROM jawaban j
        JOIN soal s ON j.soal_id = s.id
        WHERE j.pengerjaan_id = ? AND j.status_penilaian = 'menunggu'
      `).all(pengerjaanId);

      const remedialExamConfig = db.prepare('SELECT skor_langsung_ai FROM ulangan WHERE id = ?').get(pengerjaan.ulangan_id);
      const remedialUsesAiQueue = Number(remedialExamConfig?.skor_langsung_ai) === 1 && pendingAnswers.length > 0;

      // Saat AI aktif, biarkan jawaban tetap berstatus menunggu agar worker AI
      // menilainya. Fallback langsung di sini akan mengunci skor 0 sebelum
      // antrean sempat memproses remedial.
      if (pendingAnswers.length > 0 && !remedialUsesAiQueue) {
        try {
          const geminiService = require('./geminiService');
          for (const pa of pendingAnswers) {
            const evalRes = geminiService.fallbackOfflineEvaluation({
              pertanyaan: pa.pertanyaan,
              kunci_jawaban: pa.kunci_jawaban || '',
              rubrik: pa.rubrik || '',
              jawaban_siswa: pa.jawaban_siswa || '',
              bobot: pa.bobot,
              skor_maksimum: pa.bobot,
              jenis: pa.jenis
            });
            db.prepare(`
              UPDATE jawaban 
              SET skor_rekomendasi = ?, status_jawaban = ?, alasan_ai = ?, status_penilaian = 'selesai'
              WHERE id = ?
            `).run(evalRes.skor_rekomendasi, evalRes.status_jawaban, evalRes.alasan_ai || 'Penilaian otomatis remedial.', pa.id);
          }
        } catch (evalErr) {
          console.warn('⚠️ Auto-evaluation remedial notice:', evalErr.message);
        }
      }

      // 2. Pulihkan daftar soal lengkap dan hitung ulang. Jika masih ada
      // jawaban yang menunggu AI, worker yang akan merilis nilai setelah semua
      // butir selesai sehingga skor parsial tidak pernah dipublikasikan.
      if (!remedialUsesAiQueue) {
        try {
          db.prepare('UPDATE pengerjaan SET soal_ids = COALESCE(original_soal_ids, soal_ids), is_in_remedial = 0 WHERE id = ?').run(pengerjaanId);
          const reviewService = require('./reviewService');
          remedialRecalc = reviewService.recalculatePengerjaanTotal(pengerjaanId);
          if (remedialRecalc && remedialRecalc.nilai_final !== null) {
            db.prepare('UPDATE pengerjaan SET nilai_final = ?, nilai_ai = ?, skor_pg = COALESCE(?, skor_pg), skor_koding = COALESCE(?, skor_koding), released_at = CURRENT_TIMESTAMP, is_in_remedial = 0 WHERE id = ?').run(remedialRecalc.nilai_final, remedialRecalc.nilai_ai, remedialRecalc.skor_pg, remedialRecalc.skor_koding, pengerjaanId);
          }
        } catch (errRecalc) {
          console.warn('⚠️ Recalculate remedial notice:', errRecalc.message);
        }
      }
    }

    // Hitung nilai terbaik peserta berdasarkan kebijakan_nilai ulangan
    const ulRowAfterSubmit = db.prepare('SELECT kebijakan_nilai, maksimal_percobaan FROM ulangan WHERE id = ?').get(pengerjaan.ulangan_id);
    const policy = ulRowAfterSubmit?.kebijakan_nilai || 'tertinggi';
    const allSubmittedAttempts = db.prepare(`
      SELECT id, attempt_ke, nilai_final, nilai_ai 
      FROM pengerjaan 
      WHERE ulangan_id = ? AND peserta_id = ? AND status = 'submitted'
      ORDER BY attempt_ke DESC, id DESC
    `).all(pengerjaan.ulangan_id, pengerjaan.peserta_id);

    let bestScore = null;
    if (policy === 'terakhir') {
      const latestRow = allSubmittedAttempts[0];
      bestScore = latestRow ? (latestRow.nilai_final ?? latestRow.nilai_ai) : null;
    } else {
      const scores = allSubmittedAttempts.map(a => Number(a.nilai_final ?? a.nilai_ai ?? 0));
      bestScore = scores.length > 0 ? Math.max(...scores) : null;
    }

    if (bestScore !== null) {
      db.prepare('UPDATE pengerjaan SET nilai_terbaik = ? WHERE id = ?').run(bestScore, pengerjaanId);
      db.prepare('UPDATE pengerjaan SET nilai_terbaik = ? WHERE ulangan_id = ? AND peserta_id = ?').run(bestScore, pengerjaan.ulangan_id, pengerjaan.peserta_id);
    }

    // Segera dorong jawaban dan status submitted ke Turso Cloud secara non-blocking di latar belakang
    if (typeof db.syncCloud === 'function') {
      db.syncCloud(true);
    }

    const updated = db.prepare('SELECT submitted_at, released_at, nilai_final, attempt_ke, nilai_terbaik FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    const maxAttempts = (ulRowAfterSubmit?.maksimal_percobaan !== undefined && ulRowAfterSubmit?.maksimal_percobaan !== null) ? Number(ulRowAfterSubmit.maksimal_percobaan) : 1;
    const finalSkorPg = (pengerjaan.remedial_ke && pengerjaan.remedial_ke > 0 && remedialRecalc?.skor_pg !== undefined) 
      ? remedialRecalc.skor_pg 
      : computedSkorPg;

    return {
      success: true,
      message: 'Jawaban berhasil dikumpulkan',
      submitted_at: updated ? updated.submitted_at : new Date().toISOString(),
      skor_pg: finalSkorPg,
      total_pg: totalPg,
      benar_pg: benarPg,
      skor_koding: computedSkorKoding,
      total_koding: totalKoding,
      has_essay: hasEssayOrIsian,
      skor_langsung_ai: isSkorLangsungActive,
      is_released: Boolean(updated?.released_at),
      auto_released: Boolean(updated?.released_at),
      nilai_final: updated?.nilai_final ?? null,
      attempt_ke: updated?.attempt_ke || allSubmittedAttempts.length || 1,
      total_attempts: allSubmittedAttempts.length,
      maksimal_percobaan: maxAttempts,
      kebijakan_nilai: policy,
      nilai_terbaik: updated?.nilai_terbaik ?? bestScore ?? updated?.nilai_final ?? null,
      can_retake: (maxAttempts === 0 || allSubmittedAttempts.length < maxAttempts)
    };
  },

  // Sesi Remedial Langsung Mandiri (Hanya butir soal yang salah / belum sempurna)
  startDirectRemedial(pengerjaanId, verification = {}, studentSessionToken = null) {
    if (!pengerjaanId) throw new Error('ID pengerjaan tidak valid');
    const pengerjaan = this.findPengerjaanWithSync(pengerjaanId);
    if (!pengerjaan) throw new Error('Data pengerjaan tidak ditemukan');
    if (studentSessionToken && !this.verifyStudentSession(pengerjaanId, studentSessionToken)) {
      throw new Error('Akses ditolak: token sesi siswa tidak valid');
    }

    const peserta = db.prepare('SELECT id, nama, kelas FROM peserta WHERE id = ?').get(pengerjaan.peserta_id);
    if (!peserta) throw new Error('Data peserta tidak ditemukan');

    // Verifikasi identitas jika dikirimkan oleh klien (anti-terlempar ke orang lain di komputer yang sama)
    if (verification && verification.nama && peserta.nama) {
      const vNama = verification.nama.trim().toLowerCase();
      const pNama = peserta.nama.trim().toLowerCase();
      if (vNama !== pNama) {
        throw new Error(`Akses ditolak: Pengerjaan ini milik "${peserta.nama}" (${peserta.kelas}), bukan "${verification.nama}". Silakan mulai ujian dengan akun Anda sendiri.`);
      }
    }

    const ulangan = db.prepare('SELECT * FROM ulangan WHERE id = ?').get(pengerjaan.ulangan_id);
    if (!ulangan) throw new Error('Data ulangan tidak ditemukan');

    if (Number(ulangan.remedial_langsung || 0) !== 1) {
      throw new Error('Fitur remedial langsung tidak diaktifkan untuk ulangan ini.');
    }

    const isReleased = Boolean(pengerjaan.released_at);
    if (!isReleased) {
      throw new Error('Nilai ujian belum dirilis oleh guru/AI. Remedial baru dapat dimulai setelah nilai resmi dirilis.');
    }

    const kkm = Number(ulangan.kkm) || 75;
    const currentScore = pengerjaan.nilai_final !== null ? Number(pengerjaan.nilai_final) : (pengerjaan.nilai_ai !== null ? Number(pengerjaan.nilai_ai) : null);
    if (currentScore !== null && currentScore >= kkm) {
      throw new Error('Nilai Anda sudah mencapai atau melampaui KKM, tidak memerlukan remedial.');
    }

    // Cek batas remedial (jika sudah mencapai batas, jangan ada lagi kesempatan remedial)
    const maxAttempts = (ulangan.maksimal_percobaan !== undefined && ulangan.maksimal_percobaan !== null) ? Number(ulangan.maksimal_percobaan) : 1;
    const remedialKe = Number(pengerjaan.remedial_ke || 0);
    const maxRemedialLimit = maxAttempts === 0 ? Infinity : Math.max(1, maxAttempts > 1 ? maxAttempts - 1 : 1);
    if (maxAttempts !== 0 && remedialKe >= maxRemedialLimit) {
      throw new Error(`Batas kesempatan remedial (${maxRemedialLimit}x) untuk ulangan ini telah tercapai.`);
    }

    // Ambil basis ID seluruh soal dari pengerjaan awal
    let baseSoalIds = [];
    if (pengerjaan.original_soal_ids) {
      try {
        baseSoalIds = JSON.parse(pengerjaan.original_soal_ids);
      } catch (e) {
        baseSoalIds = [];
      }
    }
    if (!Array.isArray(baseSoalIds) || baseSoalIds.length === 0) {
      if (pengerjaan.soal_ids) {
        try {
          baseSoalIds = JSON.parse(pengerjaan.soal_ids);
        } catch (e) {
          baseSoalIds = [];
        }
      }
    }
    if (!Array.isArray(baseSoalIds) || baseSoalIds.length === 0) {
      const allSoal = db.prepare('SELECT id FROM soal WHERE ulangan_id = ? ORDER BY urutan ASC, nomor ASC').all(pengerjaan.ulangan_id);
      baseSoalIds = allSoal.map(s => s.id);
    }

    // Ambil jawaban saat ini untuk menentukan soal yang salah / belum sempurna
    const jawabanRows = db.prepare(`
      SELECT j.id as jawaban_id, j.soal_id, j.skor_rekomendasi, j.skor_maksimum, j.status_jawaban,
             rg.skor_final, s.bobot, s.jenis
      FROM jawaban j
      JOIN soal s ON j.soal_id = s.id
      LEFT JOIN review_guru rg ON j.id = rg.jawaban_id
      WHERE j.pengerjaan_id = ?
    `).all(pengerjaan.id);

    const jawabanMap = new Map(jawabanRows.map(j => [j.soal_id, j]));

    const wrongSoalIds = [];
    for (const sId of baseSoalIds) {
      const j = jawabanMap.get(sId);
      if (!j) {
        // Belum ada jawaban -> termasuk yang harus diperbaiki
        wrongSoalIds.push(sId);
      } else {
        const itemScore = (j.skor_final !== null && j.skor_final !== undefined) 
          ? Number(j.skor_final) 
          : (j.skor_rekomendasi !== null && j.skor_rekomendasi !== undefined ? Number(j.skor_rekomendasi) : 0);
        const maxScore = Number(j.skor_maksimum || j.bobot || 1);
        // Jika skor belum sempurna (di bawah skor maksimum butir soal)
        if (itemScore < maxScore) {
          wrongSoalIds.push(sId);
        }
      }
    }

    if (wrongSoalIds.length === 0) {
      throw new Error('Tidak ada butir soal yang memerlukan perbaikan.');
    }

    // Simpan pengerjaan dalam mode remedial
    const originalSoalIdsJson = pengerjaan.original_soal_ids || JSON.stringify(baseSoalIds);
    const remedialSoalIdsJson = JSON.stringify(wrongSoalIds);
    const newRemedialKe = Number(pengerjaan.remedial_ke || 0) + 1;
    const nowIso = new Date().toISOString();
    const remedialDeadlineIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // Backup nilai & status awal sebelum remedial untuk proteksi jika remedial tidak terkirim / terputus
    const prevNilaiFinal = (pengerjaan.nilai_final !== null && pengerjaan.nilai_final !== undefined)
      ? Number(pengerjaan.nilai_final)
      : ((pengerjaan.nilai_ai !== null && pengerjaan.nilai_ai !== undefined) ? Number(pengerjaan.nilai_ai) : null);
    const prevNilaiAi = (pengerjaan.nilai_ai !== null && pengerjaan.nilai_ai !== undefined) ? Number(pengerjaan.nilai_ai) : null;
    const prevSubmittedAt = pengerjaan.submitted_at || nowIso;
    const prevReleasedAt = pengerjaan.released_at;

    db.transaction(() => {
      db.prepare(`
        UPDATE pengerjaan
        SET status = 'mengerjakan',
            soal_ids = ?,
            original_soal_ids = COALESCE(original_soal_ids, ?),
            remedial_ke = ?,
            pre_remedial_nilai_final = COALESCE(pre_remedial_nilai_final, ?),
            pre_remedial_nilai_ai = COALESCE(pre_remedial_nilai_ai, ?),
            pre_remedial_submitted_at = COALESCE(pre_remedial_submitted_at, ?),
            pre_remedial_released_at = COALESCE(pre_remedial_released_at, ?),
            remedial_started_at = ?,
            remedial_deadline_at = ?,
            is_in_remedial = 1,
            submitted_at = NULL,
            released_at = NULL,
            submit_slot_released_at = NULL,
            last_active_at = ?
        WHERE id = ?
      `).run(remedialSoalIdsJson, originalSoalIdsJson, newRemedialKe, prevNilaiFinal, prevNilaiAi, prevSubmittedAt, prevReleasedAt, nowIso, remedialDeadlineIso, nowIso, pengerjaan.id);

      // Backup & reset jawaban butir yang salah agar bersih untuk dikerjakan ulang,
      // sekaligus mencadangkan jawaban asli jika remedial dibatalkan/ditinggalkan
      const resetJawabanStmt = db.prepare(`
        UPDATE jawaban
        SET pre_remedial_jawaban = COALESCE(pre_remedial_jawaban, jawaban_siswa),
            pre_remedial_skor = COALESCE(pre_remedial_skor, skor_rekomendasi),
            pre_remedial_status_jawaban = COALESCE(pre_remedial_status_jawaban, status_jawaban),
            pre_remedial_alasan_ai = COALESCE(pre_remedial_alasan_ai, alasan_ai),
            jawaban_siswa = '',
            status_penilaian = 'menunggu',
            skor_rekomendasi = NULL,
            status_jawaban = NULL,
            alasan_ai = NULL
        WHERE pengerjaan_id = ? AND soal_id = ?
      `);

      const deleteReviewStmt = db.prepare(`
        DELETE FROM review_guru
        WHERE jawaban_id IN (
          SELECT id FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?
        )
      `);

      for (const wId of wrongSoalIds) {
        resetJawabanStmt.run(pengerjaan.id, wId);
        deleteReviewStmt.run(pengerjaan.id, wId);
      }
    })();

    if (typeof db.syncCloud === 'function') {
      db.syncCloud(true);
    }

    // Ambil data butir soal yang salah (DIRAHASIAKAN dari kunci jawaban dan status salah sebelumnya)
    const placeholders = wrongSoalIds.map(() => '?').join(',');
    const rawSoalList = db.prepare(`
      SELECT id, nomor, jenis, pertanyaan, gambar_url, bobot, tingkat_kelas, urutan, audio_url, audio_script,
             is_listening, bahasa, tampilkan_teks_listening, opsi_a, opsi_b, opsi_c, opsi_d, opsi_e, game_data, kunci_pg
      FROM soal
      WHERE id IN (${placeholders})
    `).all(...wrongSoalIds);

    // Pertahankan urutan soal sesuai urutan pengerjaan asli
    rawSoalList.sort((a, b) => {
      const idxA = baseSoalIds.indexOf(a.id);
      const idxB = baseSoalIds.indexOf(b.id);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      return (a.urutan - b.urutan) || (a.nomor - b.nomor);
    });

    const displaySoalList = rawSoalList.map((s, idx) => {
      const isKompleks = s.jenis === 'pilihan_ganda' && (s.tipe_pg === 'pg_kompleks' || (typeof s.kunci_pg === 'string' && (s.kunci_pg.includes(',') || s.kunci_pg.trim().length > 1)));
      const item = {
        ...s,
        nomor: idx + 1,
        tipe_pg: isKompleks ? 'pg_kompleks' : 'pg_biasa',
        jawaban_siswa: ''
      };
      delete item.kunci_pg;
      delete item.kunci_jawaban;
      delete item.rubrik;
      return item;
    });

    return {
      success: true,
      isRemedial: true,
      remedial_ke: newRemedialKe,
      pengerjaanId: pengerjaan.id,
      studentSessionToken: pengerjaan.student_session_token,
      studentRecoveryToken: this.ensureStudentRecoveryToken(pengerjaan).student_recovery_token,
      peserta: {
        id: peserta.id,
        nama: peserta.nama,
        kelas: peserta.kelas
      },
      ulangan: {
        id: ulangan.id,
        judul: ulangan.judul,
        mata_pelajaran: ulangan.mata_pelajaran,
        tingkat_kelas: ulangan.tingkat_kelas,
        deskripsi: ulangan.deskripsi,
        durasi_menit: ulangan.durasi_menit,
        kkm: ulangan.kkm,
        tipe_ujian: ulangan.tipe_ujian,
        remedial_langsung: ulangan.remedial_langsung
      },
      deadline_at: remedialDeadlineIso,
      server_time: new Date().toISOString(),
      soal: displaySoalList
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
          p.soal_ids,
          p.original_soal_ids,
          p.remedial_ke,
          p.is_in_remedial,
          p.remedial_started_at,
          p.remedial_deadline_at,
          p.pre_remedial_nilai_final,
          p.pre_remedial_nilai_ai,
          p.pre_remedial_submitted_at,
          p.pre_remedial_released_at,
          p.nilai_ai,
          p.nilai_final,
          u.durasi_menit,
          u.tanggal_selesai,
          pes.nama as nama_siswa,
          pes.kelas as kelas_siswa,
          COUNT(j.id) as count_jawaban,
          SUM(CASE WHEN j.jawaban_siswa IS NOT NULL AND TRIM(j.jawaban_siswa) != '' THEN 1 ELSE 0 END) as total_terisi,
          CAST(ROUND((julianday('now') - julianday(COALESCE(p.disconnected_at, p.last_active_at, p.remedial_started_at, p.started_at))) * 86400) AS INTEGER) as detik_inaktif,
          CAST(ROUND((julianday('now') - julianday(COALESCE(p.remedial_started_at, p.started_at))) * 1440) AS INTEGER) as menit_berjalan
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
      const restoredRemedialSessions = [];

      for (const row of candidates) {
        const totalTerisi = Number(row.total_terisi || 0);
        const detikInaktif = Math.max(0, Number(row.detik_inaktif || 0));
        const menitBerjalan = Math.max(0, Number(row.menit_berjalan || 0));
        const durasiMenit = Number(row.durasi_menit || 0);

        // Hitung kuota total soal sah untuk pengerjaan ini
        let totalJawaban = 0;
        if (row.soal_ids) {
          try {
            const parsed = JSON.parse(row.soal_ids);
            if (Array.isArray(parsed) && parsed.length > 0) totalJawaban = parsed.length;
          } catch (e) {}
        }
        if (!totalJawaban) {
          const cRow = db.prepare('SELECT COUNT(*) as cnt FROM soal WHERE ulangan_id = ?').get(row.ulangan_id);
          totalJawaban = cRow ? Number(cRow.cnt || 0) : 0;
        }

        const isRemedialSession = Boolean(Number(row.is_in_remedial) === 1 || Number(row.remedial_ke) > 0 || row.pre_remedial_submitted_at);

        // Sesi DC > 1 jam: inaktif terus-menerus tanpa jeda >= 3600 detik (1 jam) dan sesi sudah berjalan minimal 60 menit
        const isDcOver1Hour = (detikInaktif >= 3600 && menitBerjalan >= 60);
        // Melewati durasi pengerjaan ulangan
        // Remedial memiliki jatah mandiri 10 menit; durasi ulangan utama
        // tidak boleh memotong sesi remedial lebih cepat.
        const isPastDuration = (!isRemedialSession && durasiMenit > 0 && menitBerjalan > durasiMenit);

        const remedialDeadline = parseStoredDate(row.remedial_deadline_at);
        const isPastRemedialDeadline = Boolean(isRemedialSession && remedialDeadline && Date.now() > remedialDeadline.getTime());

        // Melewati batas tanggal selesai ulangan jika ada
        let isPastEndDate = false;
        if (row.tanggal_selesai) {
          const endDate = new Date(row.tanggal_selesai);
          if (!isNaN(endDate.getTime()) && Date.now() > endDate.getTime()) {
            isPastEndDate = true;
          }
        }

        // Proteksi: Jangan sentuh sesi siswa yang masih dalam durasi pengerjaan sah
        if (durasiMenit > 0 && menitBerjalan < durasiMenit && !isDcOver1Hour && !isPastEndDate) {
          continue;
        }

        const isTimeExpired = isDcOver1Hour || isPastDuration || isPastRemedialDeadline || isPastEndDate;

        if (isTimeExpired) {
          const nowIso = new Date().toISOString();

          if (isRemedialSession) {
            // ========================================================
            // KASUS REMEDIAL: DATA SISWA & NILAI SEBELUMNYA TIDAK BOLEH HILANG!
            // ========================================================
            let remedialTerisi = 0;
            let activeSoalIds = [];
            try {
              if (row.soal_ids) activeSoalIds = JSON.parse(row.soal_ids);
            } catch (e) {}

            if (Array.isArray(activeSoalIds) && activeSoalIds.length > 0) {
              const placeholders = activeSoalIds.map(() => '?').join(',');
              const rRow = db.prepare(`
                SELECT COUNT(*) as cnt
                FROM jawaban
                WHERE pengerjaan_id = ?
                  AND soal_id IN (${placeholders})
                  AND jawaban_siswa IS NOT NULL
                  AND TRIM(jawaban_siswa) != ''
              `).get(row.pengerjaan_id, ...activeSoalIds);
              remedialTerisi = rRow ? Number(rRow.cnt || 0) : 0;
            }

            if (remedialTerisi > 0) {
              // Jika siswa sempat mengisi butir jawaban remedial, kumpulkan & hitung nilainya
              try {
                this.submitExam(row.pengerjaan_id, [], 0, true);
                autoSubmittedSessions.push({
                  pengerjaan_id: row.pengerjaan_id,
                  nama: row.nama_siswa,
                  kelas: row.kelas_siswa,
                  alasan: 'Remedial selesai/kedaluwarsa dengan jawaban terisi (auto-submit)',
                  terisi: remedialTerisi,
                  total_jawaban: activeSoalIds.length || totalJawaban
                });
                console.log(`[CLEANUP REMEDIAL SUBMIT] Mengumpulkan otomatis remedial pengerjaan ID ${row.pengerjaan_id} (${row.nama_siswa}) karena waktu habis.`);
              } catch (eSub) {
                console.warn('Gagal auto-submit remedial expired:', eSub.message);
              }
            } else {
              // Jika siswa tidak mengirimkan remedial sama sekali (atau DC/tutup browser),
              // KEMBALIKAN (RESTORE) status pengerjaan dan nilai ke nilai awal sebelum remedial!
              db.transaction(() => {
                // 1. Pulihkan jawaban butir yang sempat di-backup
                db.prepare(`
                  UPDATE jawaban
                  SET jawaban_siswa = COALESCE(pre_remedial_jawaban, jawaban_siswa),
                      skor_rekomendasi = COALESCE(pre_remedial_skor, skor_rekomendasi),
                      status_jawaban = COALESCE(pre_remedial_status_jawaban, status_jawaban),
                      alasan_ai = COALESCE(pre_remedial_alasan_ai, alasan_ai),
                      status_penilaian = 'selesai'
                  WHERE pengerjaan_id = ? AND pre_remedial_jawaban IS NOT NULL
                `).run(row.pengerjaan_id);

                // 2. Pulihkan pengerjaan ke status submitted dengan nilai awal
                const restoredNilaiFinal = row.pre_remedial_nilai_final !== null ? row.pre_remedial_nilai_final : (row.nilai_final ?? row.nilai_ai);
                const restoredNilaiAi = row.pre_remedial_nilai_ai !== null ? row.pre_remedial_nilai_ai : row.nilai_ai;
                const restoredSubmittedAt = row.pre_remedial_submitted_at || row.started_at || nowIso;
                const restoredReleasedAt = row.pre_remedial_released_at || nowIso;

                db.prepare(`
                  UPDATE pengerjaan
                  SET status = 'submitted',
                      soal_ids = COALESCE(original_soal_ids, soal_ids),
                      submitted_at = ?,
                      released_at = ?,
                      nilai_final = ?,
                      nilai_ai = ?,
                      is_in_remedial = 0,
                      auto_submitted = 1
                  WHERE id = ?
                `).run(restoredSubmittedAt, restoredReleasedAt, restoredNilaiFinal, restoredNilaiAi, row.pengerjaan_id);
              })();

              restoredRemedialSessions.push({
                pengerjaan_id: row.pengerjaan_id,
                nama: row.nama_siswa,
                kelas: row.kelas_siswa,
                alasan: 'Remedial tidak dikumpulkan (nilai awal dipulihkan aman di database)',
                terisi: 0,
                total_jawaban: activeSoalIds.length || totalJawaban
              });
              console.log(`[CLEANUP REMEDIAL RESTORE] Nilai awal pengerjaan ID ${row.pengerjaan_id} (${row.nama_siswa}) berhasil dipulihkan aman karena remedial tidak diselesaikan.`);
            }
          } else {
            // ========================================================
            // KASUS SESI UTAMA (BUKAN REMEDIAL):
            // ========================================================
            if (totalTerisi > 0) {
              // Jika siswa sudah menjawab sebagian atau seluruh soal -> AUTO-SUBMIT (JANGAN PERNAH HAPUS!)
              db.prepare(`
                UPDATE pengerjaan
                SET status = 'submitted', submitted_at = ?, auto_submitted = 1
                WHERE id = ?
              `).run(nowIso, row.pengerjaan_id);

              // Coba kalkulasi nilai awal jika pilihan ganda/koding sudah terisi
              try {
                const reviewService = require('./reviewService');
                reviewService.recalculatePengerjaanTotal(row.pengerjaan_id);
              } catch (eRecalc) {}

              autoSubmittedSessions.push({
                pengerjaan_id: row.pengerjaan_id,
                nama: row.nama_siswa,
                kelas: row.kelas_siswa,
                alasan: isDcOver1Hour 
                  ? `Siswa DC > 1 jam (${totalTerisi}/${totalJawaban} soal terisi - auto submit aman)` 
                  : `Waktu pengerjaan habis (${totalTerisi}/${totalJawaban} soal terisi - auto submit aman)`,
                terisi: totalTerisi,
                total_jawaban: totalJawaban
              });
              console.log(`[CLEANUP AUTO-SUBMIT] Mengirimkan otomatis pengerjaan ID ${row.pengerjaan_id} (${row.nama_siswa} - ${row.kelas_siswa}, jawaban ${totalTerisi}/${totalJawaban}) karena ${isDcOver1Hour ? 'DC > 1 jam' : 'durasi habis'}. Data aman.`);
            } else if (isDcOver1Hour && totalTerisi === 0 && !isRemedialSession) {
              // HANYA hapus sesi jika BENAR-BENAR KOSONG (0 jawaban terisi) DAN DC > 1 jam terus-menerus
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
                alasan: 'Sesi kosong (0 soal terisi) dan DC > 1 jam (reset)',
                terisi: 0,
                total_jawaban: totalJawaban
              });
              console.log(`[CLEANUP RESET] Menghapus pengerjaan kosong ID ${row.pengerjaan_id} (${row.nama_siswa}) karena tidak ada jawaban terisi dan DC > 1 jam.`);
            } else if ((isPastDuration || isPastEndDate) && totalTerisi === 0) {
              // Jika waktu durasi ulangan habis dan siswa tidak mengisi jawaban sama sekali (namun bukan DC > 1 jam),
              // JANGAN HAPUS SESI! Tandai submitted nilai 0 agar rekaman kehadiran siswa tetap aman dan pengerjaan tidak hilang.
              db.prepare(`
                UPDATE pengerjaan
                SET status = 'submitted', submitted_at = ?, auto_submitted = 1, nilai_final = 0, nilai_ai = 0
                WHERE id = ?
              `).run(nowIso, row.pengerjaan_id);

              autoSubmittedSessions.push({
                pengerjaan_id: row.pengerjaan_id,
                nama: row.nama_siswa,
                kelas: row.kelas_siswa,
                alasan: 'Durasi ujian habis (0 jawaban terisi - auto submit nilai 0)',
                terisi: 0,
                total_jawaban: totalJawaban
              });
              console.log(`[CLEANUP EXPIRED 0] Auto-submit nilai 0 untuk ID ${row.pengerjaan_id} (${row.nama_siswa}) karena durasi habis. Data sesi tetap tersimpan.`);
            }
          }
        }
      }

      return {
        success: true,
        deleted: deletedSessions,
        autoSubmitted: autoSubmittedSessions,
        restoredRemedial: restoredRemedialSessions
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
    if (pengerjaan.is_in_remedial || (pengerjaan.remedial_ke && pengerjaan.remedial_ke > 0)) {
      db.prepare(`
        UPDATE pengerjaan
        SET status = 'submitted', submitted_at = ?, auto_submitted = 1,
            soal_ids = COALESCE(original_soal_ids, soal_ids),
            is_in_remedial = 0
        WHERE id = ?
      `).run(nowIso, pengerjaanId);
      try {
        const reviewService = require('./reviewService');
        reviewService.recalculatePengerjaanTotal(pengerjaanId);
      } catch (eRecalc) {}
    } else {
      db.prepare(`
        UPDATE pengerjaan
        SET status = 'submitted', submitted_at = ?, auto_submitted = 1
        WHERE id = ?
      `).run(nowIso, pengerjaanId);
    }

    // Hitung skor awal dan auto-enqueue ke antrean AI jika skor_langsung_ai aktif
    try {
      const reviewService = require('./reviewService');
      reviewService.recalculatePengerjaanTotal(pengerjaanId);

      const ulRow = db.prepare('SELECT skor_langsung_ai FROM ulangan WHERE id = ?').get(pengerjaan.ulangan_id);
      if (Number(ulRow?.skor_langsung_ai) === 1) {
        const queueService = require('./queueService');
        queueService.enqueuePengerjaan(pengerjaanId);
      }
    } catch (qErr) {
      console.warn('⚠️ Auto-enqueue force submit error:', qErr.message);
    }

    return {
      success: true,
      message: 'Pengerjaan siswa berhasil dikumpulkan secara resmi oleh guru',
      submitted_at: nowIso
    };
  },

  // Cek status pengerjaan untuk siswa
  getPengerjaanStatus(pengerjaanId, studentSessionToken = null) {
    if (studentSessionToken && !this.verifyStudentSession(pengerjaanId, studentSessionToken)) return null;
    const query = `
      SELECT p.*, u.judul, u.mata_pelajaran, u.status as status_ulangan, u.kkm, u.kode_ujian,
             u.instruksi_remedial, u.link_remedial, u.skor_langsung_ai, u.remedial_langsung,
             u.maksimal_percobaan, u.kebijakan_nilai, u.link_kisi_kisi, u.konten_kisi_kisi, u.tampilkan_kisi_kisi,
             pes.nama, pes.kelas,
             g.nama as nama_guru, g.email as email_guru, g.no_wa as no_wa_guru
      FROM pengerjaan p
      JOIN ulangan u ON p.ulangan_id = u.id
      JOIN guru g ON u.guru_id = g.id
      JOIN peserta pes ON p.peserta_id = pes.id
      WHERE p.id = ?
    `;
    const numId = Number(pengerjaanId);
    const cleanId = isNaN(numId) ? pengerjaanId : numId;
    let pengerjaan = db.prepare(query).get(cleanId);
    if (!pengerjaan && typeof db.sync === 'function') {
      const delays = [150, 300, 500, 800, 1200];
      for (let attempt = 1; attempt <= 5; attempt++) {
        try { db.sync(); } catch (e) {}
        pengerjaan = db.prepare(query).get(cleanId);
        if (pengerjaan) break;
        if (attempt < 5) {
          const waitTill = Date.now() + (delays[attempt - 1] || 300);
          while (Date.now() < waitTill) {}
        }
      }
    }

    if (!pengerjaan) return null;

    const skorLangsungAi = Boolean(Number(pengerjaan.skor_langsung_ai) === 1);
    let antreanInfo = null;

    // Jika nilai belum dirilis dan pengerjaan berstatus submitted, cek status penilaian antrean AI
    const isSubmittedAndUnreleased = (pengerjaan.status === 'submitted' && !pengerjaan.released_at);

    if (isSubmittedAndUnreleased) {
      const jwbStats = db.prepare(`
        SELECT 
          COUNT(id) as total_soal,
          SUM(CASE WHEN status_penilaian = 'selesai' THEN 1 ELSE 0 END) as selesai_soal,
          SUM(CASE WHEN status_penilaian != 'selesai' THEN 1 ELSE 0 END) as belum_selesai
        FROM jawaban
        WHERE pengerjaan_id = ?
      `).get(pengerjaan.id);

      const totalSoal = Number(jwbStats?.total_soal || 0);
      const selesaiSoal = Number(jwbStats?.selesai_soal || 0);
      const belumSelesai = Number(jwbStats?.belum_selesai || 0);

      if (totalSoal > 0 && belumSelesai === 0) {
        try {
          const reviewService = require('./reviewService');
          reviewService.recalculatePengerjaanTotal(pengerjaan.id);
          pengerjaan = db.prepare(query).get(cleanId) || pengerjaan;
        } catch (eRecalc) {}
      } else if (totalSoal > 0 && (skorLangsungAi || belumSelesai > 0)) {
        // Hitung posisi antrean siswa pada antrean penilaian AI untuk ulangan ini
        let posisiAntrean = 1;
        let totalAntreanSiswa = 1;
        let siswaDiDepan = 0;
        let jawabanDiDepan = 0;

        try {
          // Ambil daftar seluruh siswa yang masih memiliki jawaban yang belum selesai dinilai (FIFO per siswa terisolasi)
          const queueStudents = db.prepare(`
            SELECT p.id, MIN(COALESCE(p.submitted_at, p.started_at)) as queue_time
            FROM pengerjaan p
            JOIN jawaban j ON j.pengerjaan_id = p.id
            WHERE p.ulangan_id = ?
              AND p.status = 'submitted'
              AND j.status_penilaian != 'selesai'
            GROUP BY p.id
            ORDER BY MIN(COALESCE(p.submitted_at, p.started_at)) ASC, p.id ASC
          `).all(pengerjaan.ulangan_id);

          totalAntreanSiswa = Math.max(1, queueStudents.length);
          const myIdx = queueStudents.findIndex(s => s.id === pengerjaan.id);

          if (myIdx !== -1) {
            posisiAntrean = myIdx + 1;
            siswaDiDepan = myIdx;

            // Hitung jumlah butir soal siswa di depan yang masih menunggu evaluasi
            if (siswaDiDepan > 0) {
              const aheadIds = queueStudents.slice(0, myIdx).map(s => s.id);
              const placeholders = aheadIds.map(() => '?').join(',');
              const aheadRow = db.prepare(`
                SELECT COUNT(id) as total_ahead
                FROM jawaban
                WHERE pengerjaan_id IN (${placeholders}) AND status_penilaian != 'selesai'
              `).get(...aheadIds);
              jawabanDiDepan = Number(aheadRow?.total_ahead || (siswaDiDepan * 2));
            }
          }
        } catch (ePos) {
          console.warn('⚠️ Warning hitung posisi antrean:', ePos.message);
        }

        // Estimasi waktu tunggu (detik): setiap butir soal butuh ~5-7 detik (inferensi AI + pacing delay)
        const estimasiDetik = Math.max(5, (jawabanDiDepan * 6) + (belumSelesai * 4));
        let estimasiTeks = '';
        if (posisiAntrean === 1) {
          estimasiTeks = belumSelesai > 0
            ? `Giliran Anda sekarang! AI sedang menilai ${belumSelesai} jawaban Anda...`
            : 'Evaluasi selesai! Menghitung nilai akhir...';
        } else if (estimasiDetik <= 45) {
          estimasiTeks = `Sekitar ~${estimasiDetik} detik lagi`;
        } else if (estimasiDetik <= 90) {
          estimasiTeks = 'Sekitar ~1 - 1.5 menit lagi';
        } else if (estimasiDetik <= 150) {
          estimasiTeks = 'Sekitar ~2 - 2.5 menit lagi';
        } else {
          estimasiTeks = `Sekitar ~${Math.ceil(estimasiDetik / 60)} menit lagi`;
        }

        antreanInfo = {
          totalSoal,
          selesaiSoal,
          menungguSoal: belumSelesai,
          posisiAntrean,
          totalAntreanSiswa,
          siswaDiDepan,
          jawabanDiDepan,
          estimasiDetik,
          estimasiTeks,
          isGiliranSaya: Boolean(posisiAntrean === 1)
        };
      }
    }

    // Jika pengerjaan sudah submitted dan nilai_final/nilai_ai masih null, coba hitung nilai jika ada jawaban
    if (pengerjaan.status === 'submitted' && pengerjaan.nilai_final === null && pengerjaan.nilai_ai === null) {
      try {
        const reviewService = require('./reviewService');
        reviewService.recalculatePengerjaanTotal(pengerjaan.id);
        pengerjaan = db.prepare(query).get(cleanId) || pengerjaan;
      } catch (eRecalc) {}
    }

    const isReleased = Boolean(pengerjaan.released_at);
    const examKkm = pengerjaan.kkm || 75;
    let finalScore = isReleased ? (pengerjaan.nilai_final !== null ? pengerjaan.nilai_final : pengerjaan.nilai_ai) : null;
    if (isReleased && (pengerjaan.kebijakan_nilai || 'tertinggi') === 'tertinggi') {
      const bestReleased = db.prepare(`
        SELECT MAX(COALESCE(nilai_final, nilai_ai, 0)) AS score
        FROM pengerjaan
        WHERE ulangan_id = ? AND peserta_id = ? AND status = 'submitted' AND released_at IS NOT NULL
      `).get(pengerjaan.ulangan_id, pengerjaan.peserta_id);
      if (bestReleased && bestReleased.score !== null && bestReleased.score !== undefined) {
        finalScore = Number(bestReleased.score);
      }
    }
    const isRemedialLangsungActive = Boolean(Number(pengerjaan.remedial_langsung || 0) === 1);

    // Hitung status nilai saat ini untuk evaluasi hak remedial langsung
    const currentScore = pengerjaan.nilai_final !== null ? Number(pengerjaan.nilai_final) : (pengerjaan.nilai_ai !== null ? Number(pengerjaan.nilai_ai) : null);
    const maxAttempts = (pengerjaan.maksimal_percobaan !== undefined && pengerjaan.maksimal_percobaan !== null) ? Number(pengerjaan.maksimal_percobaan) : 1;
    const remedialKe = Number(pengerjaan.remedial_ke || 0);
    // Batas remedial: jika maksimal_percobaan = 0, tanpa batas.
    // Jika maksimal_percobaan = 1 (default 1x), kesempatan remedial adalah 1x (remedialKe < 1).
    // Jika maksimal_percobaan > 1, total kesempatan remedial adalah maksimal_percobaan - 1 (atau maksimal_percobaan).
    const maxRemedialLimit = maxAttempts === 0 ? Infinity : Math.max(1, maxAttempts > 1 ? maxAttempts - 1 : 1);
    const isRemedialLimitReached = (maxAttempts !== 0) && (remedialKe >= maxRemedialLimit);

    // PENTING: Remedial HANYA aktif jika nilai sudah dirilis oleh guru/AI (isReleased === true) dan belum mencapai batas remedial
    const isUnderKkm = (finalScore !== null) ? (finalScore < examKkm) : false;
    const isRemedial = Boolean(isReleased && isUnderKkm);
    const canDirectRemedial = Boolean(isReleased && isRemedialLangsungActive && isUnderKkm && !isRemedialLimitReached);

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
      if (isRemedial && isRemedialLangsungActive && canDirectRemedial) {
        // "tapi ingat ini jangan diberitahukan mana yang salah dan benar"
        // Rahasiakan perincian kunci dan benar/salah per butir soal agar siswa mandiri saat remedial langsung
        jawabanList = [];
      } else {
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
      }

      // Ambil satu hasil resmi per peserta. Tanpa deduplikasi, percobaan awal
      // dan remedial/ujian ulang muncul sebagai dua baris sehingga ranking
      // kelas bergeser dan nilai siswa terlihat tidak akurat.
      const studentClass = (pengerjaan.kelas || '').trim();
      const rankingPolicy = pengerjaan.kebijakan_nilai || 'tertinggi';
      const attemptOrder = rankingPolicy === 'terakhir'
        ? 'submitted_at DESC, pengerjaan_id DESC'
        : 'score DESC, submitted_at DESC, pengerjaan_id DESC';
      const rawRekap = db.prepare(`
        WITH released_attempts AS (
          SELECT
            pes.id AS peserta_id,
            pes.nama AS nama_siswa,
            pes.kelas AS kelas_siswa,
            p2.id AS pengerjaan_id,
            p2.nilai_final,
            p2.nilai_ai,
            p2.auto_submitted,
            p2.submitted_at,
            COALESCE(p2.nilai_final, p2.nilai_ai, 0) AS score
          FROM pengerjaan p2
          JOIN peserta pes ON p2.peserta_id = pes.id
          WHERE p2.ulangan_id = ?
            AND p2.status = 'submitted'
            AND p2.released_at IS NOT NULL
            AND (? = '' OR LOWER(TRIM(pes.kelas)) = LOWER(TRIM(?)))
        ), selected_attempts AS (
          SELECT released_attempts.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY peserta_id
                   ORDER BY ${attemptOrder}
                 ) AS attempt_rank
          FROM released_attempts
        )
        SELECT peserta_id, nama_siswa, kelas_siswa, pengerjaan_id,
               nilai_final, nilai_ai, auto_submitted, submitted_at, score
        FROM selected_attempts
        WHERE attempt_rank = 1
        ORDER BY score DESC, nama_siswa ASC, peserta_id ASC
      `).all(pengerjaan.ulangan_id, studentClass, studentClass);

      rekapNilaiKelas = rawRekap.map((r, idx) => {
        const score = Number(r.score ?? (r.nilai_final !== null ? r.nilai_final : (r.nilai_ai !== null ? r.nilai_ai : 0)));
        return {
          ranking: idx + 1,
          pesertaId: r.peserta_id,
          nama: r.nama_siswa,
          kelas: r.kelas_siswa,
          nilai: score,
          isCurrentStudent: Number(r.peserta_id) === Number(pengerjaan.peserta_id),
          isTuntas: score >= examKkm,
          autoSubmitted: Boolean(r.auto_submitted)
        };
      });
    }

    const policy = pengerjaan.kebijakan_nilai || 'tertinggi';

    const allSubmittedAttempts = db.prepare(`
      SELECT id, attempt_ke, nilai_final, nilai_ai 
      FROM pengerjaan 
      WHERE ulangan_id = ? AND peserta_id = ? AND status = 'submitted'
      ORDER BY attempt_ke DESC, id DESC
    `).all(pengerjaan.ulangan_id, pengerjaan.peserta_id);

    const countSubmitted = allSubmittedAttempts.length;
    let bestScore = pengerjaan.nilai_terbaik;
    if (bestScore === null || bestScore === undefined) {
      if (policy === 'terakhir') {
        const latestRow = allSubmittedAttempts[0];
        bestScore = latestRow ? (latestRow.nilai_final ?? latestRow.nilai_ai) : finalScore;
      } else {
        const scores = allSubmittedAttempts.map(a => Number(a.nilai_final ?? a.nilai_ai ?? 0));
        bestScore = scores.length > 0 ? Math.max(...scores) : finalScore;
      }
    }

    const canRetake = (maxAttempts === 0 || (countSubmitted < maxAttempts && !isRemedialLimitReached));
    const sisaPercobaan = maxAttempts === 0 ? 'Tanpa Batas' : Math.max(0, maxAttempts - countSubmitted);

    return {
      pengerjaanId: pengerjaan.id,
      ulanganId: pengerjaan.ulangan_id,
      nama: pengerjaan.nama,
      kelas: pengerjaan.kelas,
      judul: pengerjaan.judul,
      mataPelajaran: pengerjaan.mata_pelajaran,
      kodeUjian: pengerjaan.kode_ujian,
      status: pengerjaan.status,
      submittedAt: pengerjaan.submitted_at,
      isReleased,
      releasedAt: pengerjaan.released_at,
      skorLangsungAi,
      antreanInfo,
      kkm: examKkm,
      nilaiFinal: finalScore,
      attempt_ke: pengerjaan.attempt_ke || countSubmitted || 1,
      total_attempts: countSubmitted || 1,
      maksimal_percobaan: maxAttempts,
      sisa_percobaan: sisaPercobaan,
      can_retake: canRetake,
      kebijakan_nilai: policy,
      nilai_terbaik: bestScore,
      isRemedial,
      is_in_remedial: Boolean(Number(pengerjaan.is_in_remedial) === 1 || (pengerjaan.status === 'mengerjakan' && remedialKe > 0)),
      pre_remedial_nilai: pengerjaan.pre_remedial_nilai_final !== null ? pengerjaan.pre_remedial_nilai_final : pengerjaan.pre_remedial_nilai_ai,
      remedial_langsung: isRemedialLangsungActive ? 1 : 0,
      canDirectRemedial,
      remedial_ke: remedialKe,
      max_remedial: maxRemedialLimit === Infinity ? 0 : maxRemedialLimit,
      is_remedial_limit_reached: isRemedialLimitReached,
      currentScore: currentScore,
      instruksi_remedial: pengerjaan.instruksi_remedial || null,
      link_remedial: pengerjaan.link_remedial || null,
      link_kisi_kisi: pengerjaan.link_kisi_kisi || null,
      konten_kisi_kisi: pengerjaan.konten_kisi_kisi || null,
      tampilkan_kisi_kisi: (pengerjaan.tampilkan_kisi_kisi !== undefined && pengerjaan.tampilkan_kisi_kisi !== null) ? Number(pengerjaan.tampilkan_kisi_kisi) : 0,
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
  getStudentExamHistory(pengerjaanId, studentSessionToken = null) {
    // Selalu ambil peserta dari attempt yang sudah diverifikasi. Nama + kelas
    // adalah label tampilan dan tidak cukup untuk membedakan dua peserta.
    const verifiedAttempt = studentSessionToken
      ? this.verifyStudentSession(pengerjaanId, studentSessionToken)
      : this.findPengerjaanWithSync(pengerjaanId);
    if (studentSessionToken && !verifiedAttempt) return null;
    const current = db.prepare(`
      SELECT pes.id as peserta_id, pes.nama, pes.kelas
      FROM pengerjaan p 
      JOIN peserta pes ON p.peserta_id = pes.id 
      WHERE p.id = ?
    `).get(pengerjaanId);

    if (!current) return [];

    const history = db.prepare(`
      WITH current_identity AS (
        SELECT
          current_pengerjaan.peserta_id AS current_peserta_id,
          current_pengerjaan.ulangan_id AS current_ulangan_id,
          LOWER(TRIM(pes.nama)) AS nama_key,
          LOWER(TRIM(pes.kelas)) AS kelas_key
        FROM pengerjaan current_pengerjaan
        JOIN peserta pes ON current_pengerjaan.peserta_id = pes.id
        WHERE current_pengerjaan.id = ?
      )
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
      WHERE p.status = 'submitted'
        AND (
          p.peserta_id = (SELECT current_peserta_id FROM current_identity)
          OR (
            p.ulangan_id != (SELECT current_ulangan_id FROM current_identity)
            AND LOWER(TRIM(pes.nama)) = (SELECT nama_key FROM current_identity)
            AND LOWER(TRIM(pes.kelas)) = (SELECT kelas_key FROM current_identity)
          )
        )
      ORDER BY COALESCE(p.submitted_at, p.started_at) DESC, p.id DESC
    `).all(pengerjaanId);

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
  getActiveSession(pengerjaanId, studentSessionToken = null) {
    if (!pengerjaanId) return null;

    if (studentSessionToken && !this.verifyStudentSession(pengerjaanId, studentSessionToken)) return null;

    const numId = Number(pengerjaanId);
    const cleanId = isNaN(numId) ? pengerjaanId : numId;
    const sessionQuery = `
      SELECT p.*, u.id as ulangan_id, u.judul, u.mata_pelajaran, u.tingkat_kelas, u.deskripsi,
             u.kode_ujian, u.durasi_menit, u.tanggal_mulai, u.tanggal_selesai, u.kkm, u.zona_waktu,
             u.tampilkan_simbol, u.link_kisi_kisi, u.konten_kisi_kisi, u.tampilkan_kisi_kisi, u.jumlah_soal_listening, u.tampilkan_teks_listening, pes.id as peserta_id, pes.nama as nama_peserta, pes.kelas as kelas_peserta
      FROM pengerjaan p
      JOIN ulangan u ON p.ulangan_id = u.id
      JOIN peserta pes ON p.peserta_id = pes.id
      WHERE p.id = ?
    `;
    let pengerjaan = db.prepare(sessionQuery).get(cleanId);
    if (!pengerjaan && typeof db.sync === 'function') {
      const delays = [150, 300, 500, 800, 1200];
      for (let attempt = 1; attempt <= 5; attempt++) {
        try { db.sync(); } catch (e) {}
        pengerjaan = db.prepare(sessionQuery).get(cleanId);
        if (pengerjaan) break;
        if (attempt < 5) {
          const waitTill = Date.now() + (delays[attempt - 1] || 300);
          while (Date.now() < waitTill) {}
        }
      }
    }

    if (!pengerjaan) return null;

    if (pengerjaan.status === 'submitted') {
      const securedSubmitted = this.ensureStudentRecoveryToken(pengerjaan);
      return {
        alreadySubmitted: true,
        pengerjaanId: pengerjaan.id,
        studentSessionToken: securedSubmitted.student_session_token,
        studentRecoveryToken: securedSubmitted.student_recovery_token,
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

    if (pengerjaan.remedial_deadline_at) {
      deadlineAt = parseStoredDate(pengerjaan.remedial_deadline_at);
    } else if (pengerjaan.durasi_menit) {
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
        SELECT id, nomor, jenis, pertanyaan, gambar_url, bobot, tingkat_kelas, urutan, audio_url, audio_script, is_listening, bahasa, tampilkan_teks_listening, opsi_a, opsi_b, opsi_c, opsi_d, opsi_e, game_data, kunci_pg
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
        SELECT id, nomor, jenis, pertanyaan, gambar_url, bobot, tingkat_kelas, urutan, audio_url, audio_script, is_listening, bahasa, tampilkan_teks_listening, opsi_a, opsi_b, opsi_c, opsi_d, opsi_e, game_data, kunci_pg
        FROM soal
        WHERE ulangan_id = ?
        ORDER BY urutan ASC, nomor ASC
      `).all(pengerjaan.ulangan_id).map((s, idx) => ({ ...s, nomor: idx + 1 }));
    }

    // Pasangkan teks draft jawaban tersimpan ke butir soal, tentukan tipe_pg (kompleks vs biasa), dan hapus kunci_pg
    const displaySoalWithAnswers = displaySoalList.map((s, idx) => {
      const isKompleks = s.jenis === 'pilihan_ganda' && (s.tipe_pg === 'pg_kompleks' || (typeof s.kunci_pg === 'string' && (s.kunci_pg.includes(',') || s.kunci_pg.trim().length > 1)));
      const item = {
        ...s,
        nomor: idx + 1,
        tipe_pg: isKompleks ? 'pg_kompleks' : 'pg_biasa',
        jawaban_siswa: existingJawabanMap.get(s.id) || ''
      };
      delete item.kunci_pg;
      return item;
    });

    const stats = db.prepare('SELECT COUNT(*) as total_soal, COALESCE(SUM(bobot), 0) as total_bobot FROM soal WHERE ulangan_id = ?').get(pengerjaan.ulangan_id);

    const hasRecKisiLink = Boolean(pengerjaan.link_kisi_kisi && String(pengerjaan.link_kisi_kisi).trim());
    const hasRecKisiKonten = Boolean(pengerjaan.konten_kisi_kisi && String(pengerjaan.konten_kisi_kisi).trim());
    const isRecKisiShown = Boolean(pengerjaan.tampilkan_kisi_kisi && (hasRecKisiLink || hasRecKisiKonten));

    return {
      alreadySubmitted: false,
      timeExpired: isTimeExpired,
      pengerjaanId: pengerjaan.id,
      studentSessionToken: pengerjaan.student_session_token,
      studentRecoveryToken: this.ensureStudentRecoveryToken(pengerjaan).student_recovery_token,
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
        link_kisi_kisi: (isRecKisiShown && hasRecKisiLink) ? pengerjaan.link_kisi_kisi : null,
        konten_kisi_kisi: (isRecKisiShown && hasRecKisiKonten) ? pengerjaan.konten_kisi_kisi : null,
        tampilkan_kisi_kisi: isRecKisiShown ? 1 : 0,
        jumlah_soal_listening: pengerjaan.jumlah_soal_listening,
        tampilkan_teks_listening: Number(pengerjaan.tampilkan_teks_listening || 0)
      },
      deadline_at: deadlineAt ? deadlineAt.toISOString() : null,
      server_time: new Date().toISOString(),
      isRemedial: Boolean(Number(pengerjaan.is_in_remedial) === 1 || Number(pengerjaan.remedial_ke) > 0),
      remedial_ke: Number(pengerjaan.remedial_ke || 0),
      soal: displaySoalWithAnswers
    };
  },

  // Rekam detak jantung / presence siswa saat mengerjakan (mendeteksi aktif vs terputus/dc)
  recordPing(pengerjaanId, status = 'active', studentSessionToken = null) {
    if (!pengerjaanId) return { success: false, message: 'pengerjaan_id wajib diisi' };
    if (studentSessionToken && !this.verifyStudentSession(pengerjaanId, studentSessionToken)) {
      return { success: false, message: 'Akses ditolak: token sesi siswa tidak valid' };
    }
    const pengerjaan = db.prepare('SELECT id, status FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    if (!pengerjaan || pengerjaan.status !== 'mengerjakan') {
      return { success: false, message: 'Pengerjaan tidak ditemukan atau sudah dikumpulkan' };
    }

    if (status === 'offline') {
      // Disconnect eksplisit (misal user tutup tab / browser pagehide)
      db.prepare(`UPDATE pengerjaan SET last_active_at = '2000-01-01 00:00:00', disconnected_at = CURRENT_TIMESTAMP WHERE id = ?`).run(pengerjaanId);
      return { success: true, status: 'offline' };
    }

    db.prepare('UPDATE pengerjaan SET last_active_at = CURRENT_TIMESTAMP, disconnected_at = NULL WHERE id = ?').run(pengerjaanId);
    return { success: true, status: 'active' };
  },

  // Sensor nama siswa untuk privasi (contoh: 'Ahmad Fadhil' -> 'Ah*** Fad***')
  maskStudentName(name) {
    return maskStudentName(name);
  },

  // Ambil log tanda terima jawaban siswa yang sudah terkirim (tanpa menampilkan nilai)
  getSubmissionLogByExamCode(kodeUjian, page = 1, limit = 10) {
    if (!kodeUjian || !kodeUjian.trim()) {
      return { success: false, message: 'Kode ujian wajib diisi' };
    }
    const cleanKode = kodeUjian.trim();
    let sesi = null;
    try {
      sesi = db.prepare('SELECT id, ulangan_id, nama_sesi, kode_sesi FROM ulangan_sesi WHERE UPPER(kode_sesi) = ?').get(cleanKode.toUpperCase());
    } catch (e) {}

    let ulangan = null;
    if (sesi) {
      ulangan = db.prepare('SELECT id, judul, zona_waktu FROM ulangan WHERE id = ?').get(sesi.ulangan_id);
    } else {
      ulangan = db.prepare('SELECT id, judul, zona_waktu FROM ulangan WHERE LOWER(kode_ujian) = LOWER(?)').get(cleanKode);
    }

    if (!ulangan) {
      return { success: false, message: 'Ulangan tidak ditemukan' };
    }

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
    const offset = (p - 1) * l;

    let whereSql = `WHERE p.ulangan_id = ? AND p.status = 'submitted'`;
    const countParams = [ulangan.id];
    const rowParams = [ulangan.id];
    if (sesi) {
      whereSql += ` AND p.sesi_id = ?`;
      countParams.push(sesi.id);
      rowParams.push(sesi.id);
    }
    rowParams.push(l, offset);

    const totalRow = db.prepare(`
      SELECT COUNT(*) as total
      FROM pengerjaan p
      ${whereSql}
    `).get(...countParams);
    const total = totalRow ? totalRow.total : 0;

    const rows = db.prepare(`
      SELECT 
        p.id as pengerjaan_id,
        pes.nama as nama_siswa,
        pes.kelas as kelas_siswa,
        p.submitted_at
      FROM pengerjaan p
      JOIN peserta pes ON p.peserta_id = pes.id
      ${whereSql}
      ORDER BY p.submitted_at DESC
      LIMIT ? OFFSET ?
    `).all(...rowParams);

    const tzMap = {
      'WIB': 'Asia/Jakarta',
      'WITA': 'Asia/Makassar',
      'WIT': 'Asia/Jayapura'
    };
    const timeZone = tzMap[ulangan.zona_waktu] || 'Asia/Makassar';

    const items = rows.map((r, idx) => {
      let waktuFormatted = '-';
      if (r.submitted_at) {
        try {
          const raw = r.submitted_at;
          const dt = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
          waktuFormatted = new Intl.DateTimeFormat('id-ID', {
            timeZone,
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          }).format(dt) + ` ${ulangan.zona_waktu || 'WITA'}`;
        } catch (e) {
          waktuFormatted = r.submitted_at;
        }
      }
      return {
        no: offset + idx + 1,
        nama: r.nama_siswa,
        nama_sensor: maskStudentName(r.nama_siswa),
        kelas: r.kelas_siswa,
        waktu: waktuFormatted,
        status: 'Diterima'
      };
    });

    return {
      success: true,
      data: {
        total,
        page: p,
        totalPages: Math.max(1, Math.ceil(total / l)),
        limit: l,
        items,
        nama_sesi: sesi ? sesi.nama_sesi : null,
        judul_ulangan: ulangan.judul,
        zona_waktu: ulangan.zona_waktu || 'WITA'
      }
    };
  },

  // Ambil daftar siswa yang sedang mengerjakan ujian (aktif vs DC dengan hitungan mundur sisa toleransi)
  getActiveStudentsByExamCode(kodeUjian, page = 1, limit = 10) {
    if (!kodeUjian || !kodeUjian.trim()) {
      return { success: false, message: 'Kode ujian wajib diisi' };
    }
    const cleanKode = kodeUjian.trim();
    let sesi = null;
    try {
      sesi = db.prepare('SELECT id, ulangan_id, nama_sesi, kode_sesi FROM ulangan_sesi WHERE UPPER(kode_sesi) = ?').get(cleanKode.toUpperCase());
    } catch (e) {}

    let ulangan = null;
    if (sesi) {
      ulangan = db.prepare('SELECT id, judul, durasi_menit, zona_waktu FROM ulangan WHERE id = ?').get(sesi.ulangan_id);
    } else {
      ulangan = db.prepare('SELECT id, judul, durasi_menit, zona_waktu FROM ulangan WHERE LOWER(kode_ujian) = LOWER(?)').get(cleanKode);
    }

    if (!ulangan) {
      return { success: false, message: 'Ulangan tidak ditemukan' };
    }

    // Jalankan pembersihan sesi kedaluwarsa terlebih dahulu agar auto-submit untuk jawaban lengkap atau reset tereksekusi
    this.cleanAbandonedSessions(ulangan.id);

    const countSoalUlangan = db.prepare('SELECT COUNT(*) as cnt FROM soal WHERE ulangan_id = ?').get(ulangan.id)?.cnt || 0;

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
    const offset = (p - 1) * l;

    let whereSql = `WHERE p.ulangan_id = ? AND p.status = 'mengerjakan'`;
    const params = [ulangan.id];
    if (sesi) {
      whereSql += ` AND p.sesi_id = ?`;
      params.push(sesi.id);
    }

    const allRows = db.prepare(`
      SELECT 
        p.id as pengerjaan_id,
        pes.nama as nama_siswa,
        pes.kelas as kelas_siswa,
        p.started_at,
        p.last_active_at,
        p.soal_ids,
        COUNT(j.id) as count_jawaban,
        SUM(CASE WHEN j.jawaban_siswa IS NOT NULL AND TRIM(j.jawaban_siswa) != '' THEN 1 ELSE 0 END) as total_terisi,
        CAST(ROUND((julianday('now') - julianday(COALESCE(p.last_active_at, p.started_at))) * 86400) AS INTEGER) as detik_inaktif,
        CAST(ROUND((julianday('now') - julianday(p.started_at)) * 86400) AS INTEGER) as detik_berjalan
      FROM pengerjaan p
      JOIN peserta pes ON p.peserta_id = pes.id
      LEFT JOIN jawaban j ON p.id = j.pengerjaan_id
      ${whereSql}
      GROUP BY p.id
    `).all(...params);

    const durasiMenit = Number(ulangan.durasi_menit || 0);

    const processedList = allRows.map(r => {
      const detikInaktif = Math.max(0, Number(r.detik_inaktif || 0));
      const detikBerjalan = Math.max(0, Number(r.detik_berjalan || 0));
      const isAktif = (detikInaktif <= 45);

      let totalJawaban = 0;
      if (r.soal_ids) {
        try {
          const parsed = JSON.parse(r.soal_ids);
          if (Array.isArray(parsed) && parsed.length > 0) totalJawaban = parsed.length;
        } catch (e) {}
      }
      if (!totalJawaban) totalJawaban = countSoalUlangan;

      const totalTerisi = Number(r.total_terisi || 0);
      const draftLengkap = (totalJawaban > 0 && totalTerisi >= totalJawaban);

      let status = 'dc';
      let statusLabel = 'Terputus (DC)';
      if (isAktif) {
        status = 'aktif';
        statusLabel = 'Aktif';
      } else if (draftLengkap) {
        // Jawaban sudah lengkap, walau DC tidak dihitung sebagai DC yang terancam reset/hangus
        status = 'lengkap';
        statusLabel = '🟢 Jawaban Lengkap';
      }

      // Hitung toleransi DC:
      // Maksimal toleransi DC = 3600 detik (1 jam) sejak inaktif terus-menerus tanpa jeda
      // Sisa waktu ulangan (jika ada durasi): (durasiMenit * 60) - detikBerjalan
      const maxDcTolerance = 3600;
      const sisaDcDetik = Math.max(0, maxDcTolerance - detikInaktif);
      
      let sisaToleransiDetik = sisaDcDetik;
      if (durasiMenit > 0) {
        const sisaWaktuUlangan = Math.max(0, (durasiMenit * 60) - detikBerjalan);
        sisaToleransiDetik = Math.min(sisaDcDetik, sisaWaktuUlangan);
      }

      return {
        pengerjaan_id: r.pengerjaan_id,
        nama: r.nama_siswa,
        nama_sensor: maskStudentName(r.nama_siswa),
        kelas: r.kelas_siswa,
        started_at: r.started_at,
        last_active_at: r.last_active_at,
        is_aktif: isAktif,
        draft_lengkap: draftLengkap,
        total_terisi: totalTerisi,
        total_jawaban: totalJawaban,
        status,
        status_label: statusLabel,
        detik_inaktif: detikInaktif,
        sisa_toleransi_detik: isAktif ? null : sisaToleransiDetik
      };
    });

    const total = processedList.length;
    const totalAktif = processedList.filter(item => item.is_aktif).length;
    const totalLengkap = processedList.filter(item => !item.is_aktif && item.draft_lengkap).length;
    // Siswa dengan jawaban lengkap tidak dihitung sebagai DC yang terancam hangus
    const totalDc = processedList.filter(item => !item.is_aktif && !item.draft_lengkap).length;

    // Sorting: 1. Aktif, 2. Lengkap (Aman), 3. DC (Belum Lengkap)
    processedList.sort((a, b) => {
      const rank = (item) => {
        if (item.is_aktif) return 1;
        if (item.draft_lengkap) return 2;
        return 3;
      };
      const rA = rank(a);
      const rB = rank(b);
      if (rA !== rB) return rA - rB;

      return new Date(b.last_active_at || b.started_at || 0) - new Date(a.last_active_at || a.started_at || 0);
    });

    const paged = processedList.slice(offset, offset + l);
    const items = paged.map((r, idx) => ({
      no: offset + idx + 1,
      pengerjaan_id: r.pengerjaan_id,
      nama: r.nama,
      nama_sensor: r.nama_sensor,
      kelas: r.kelas,
      status: r.status,
      status_label: r.status_label,
      draft_lengkap: r.draft_lengkap,
      total_terisi: r.total_terisi,
      total_jawaban: r.total_jawaban,
      detik_inaktif: r.detik_inaktif,
      sisa_toleransi_detik: r.sisa_toleransi_detik
    }));

    return {
      success: true,
      data: {
        total,
        total_aktif: totalAktif,
        total_lengkap: totalLengkap,
        total_dc: totalDc,
        page: p,
        totalPages: Math.max(1, Math.ceil(total / l)),
        limit: l,
        items,
        judul_ulangan: ulangan.judul,
        zona_waktu: ulangan.zona_waktu || 'WITA'
      }
    };
  }
};

module.exports = studentService;
