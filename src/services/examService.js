const crypto = require('crypto');
const db = require('../config/database');
const classService = require('./classService');

const examService = {
  // Generate kode unik 6 karakter huruf kapital & angka
  generateExamCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  },

  // Helper konversi tanggal dan zona waktu Indonesia (WIB, WITA, WIT)
  parseIndonesianDateTime(dateStr, zonaWaktu = 'WIB') {
    if (!dateStr) return null;
    const cleanStr = String(dateStr).trim();
    if (!cleanStr) return null;

    // Jika sudah memiliki offset waktu (Z atau +HH:mm / -HH:mm), parse langsung
    if (cleanStr.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(cleanStr)) {
      const d = new Date(cleanStr);
      return isNaN(d.getTime()) ? null : d.toISOString();
    }

    const offsetMap = {
      WIB: '+07:00',
      WITA: '+08:00',
      WIT: '+09:00'
    };
    const zw = (zonaWaktu && offsetMap[String(zonaWaktu).toUpperCase()]) ? String(zonaWaktu).toUpperCase() : 'WIB';
    const offset = offsetMap[zw] || '+07:00';

    let normalized = cleanStr;
    if (normalized.length === 16) {
      normalized += ':00';
    }
    normalized += offset;
    const d = new Date(normalized);
    return isNaN(d.getTime()) ? null : d.toISOString();
  },

  formatIndonesianDateTime(isoDateStr, zonaWaktu = 'WIB', isShort = false) {
    if (!isoDateStr) return '-';
    const tzMap = {
      WIB: 'Asia/Jakarta',
      WITA: 'Asia/Makassar',
      WIT: 'Asia/Jayapura'
    };
    const zw = (zonaWaktu && tzMap[String(zonaWaktu).toUpperCase()]) ? String(zonaWaktu).toUpperCase() : 'WIB';
    const timeZone = tzMap[zw] || 'Asia/Jakarta';
    const d = new Date(isoDateStr);
    if (isNaN(d.getTime())) return '-';

    const formatted = d.toLocaleString('id-ID', {
      timeZone,
      dateStyle: isShort ? 'short' : 'full',
      timeStyle: 'short'
    });
    return `${formatted} ${zw}`;
  },

  // FR-02 & FR-03: Buat Ulangan Baru
  createUlangan(guruId, data) {
    const { judul, mata_pelajaran, deskripsi, kelas_ids, jumlah_soal_tampil, jumlah_soal_isian, jumlah_soal_essay, acak_soal, tanggal_mulai, tanggal_selesai, durasi_menit } = data;
    let tingkat_kelas = data.tingkat_kelas;

    if (!judul || !mata_pelajaran) {
      throw new Error('Judul dan mata pelajaran wajib diisi');
    }

    // Jika tingkat_kelas belum diisi tapi kelas_ids ada, ambil nama kelasnya
    if (!tingkat_kelas && Array.isArray(kelas_ids) && kelas_ids.length > 0) {
      const kNames = db.prepare(`SELECT nama_kelas FROM kelas WHERE id IN (${kelas_ids.map(() => '?').join(',')})`).all(...kelas_ids);
      tingkat_kelas = kNames.map(k => k.nama_kelas).join(', ');
    }

    if (!tingkat_kelas) {
      tingkat_kelas = 'Umum';
    }

    let kode_ujian;
    let isUnique = false;
    while (!isUnique) {
      kode_ujian = this.generateExamCode();
      const existing = db.prepare('SELECT id FROM ulangan WHERE kode_ujian = ?').get(kode_ujian);
      if (!existing) isUnique = true;
    }

    const cleanZonaWaktu = (data.zona_waktu && ['WIB', 'WITA', 'WIT'].includes(String(data.zona_waktu).toUpperCase()))
      ? String(data.zona_waktu).toUpperCase()
      : 'WIB';
    const cleanIsian = (jumlah_soal_isian !== undefined && jumlah_soal_isian !== null && jumlah_soal_isian !== '') ? Math.max(0, Number(jumlah_soal_isian)) : null;
    const cleanEssay = (jumlah_soal_essay !== undefined && jumlah_soal_essay !== null && jumlah_soal_essay !== '') ? Math.max(0, Number(jumlah_soal_essay)) : null;
    const cleanListening = (data.jumlah_soal_listening !== undefined && data.jumlah_soal_listening !== null && data.jumlah_soal_listening !== '') ? Math.max(0, Number(data.jumlah_soal_listening)) : null;
    let limitSoal = (jumlah_soal_tampil !== undefined && jumlah_soal_tampil !== null && jumlah_soal_tampil !== '') ? Math.max(1, Number(jumlah_soal_tampil)) : null;
    if (!limitSoal && ((cleanIsian && cleanIsian > 0) || (cleanEssay && cleanEssay > 0))) {
      limitSoal = (cleanIsian || 0) + (cleanEssay || 0);
    }
    if (limitSoal && ((cleanIsian || 0) + (cleanEssay || 0) > limitSoal)) {
      throw new Error(`Total kuota wajib (${(cleanIsian || 0) + (cleanEssay || 0)} soal) tidak boleh melebihi batas jumlah soal siswa (${limitSoal} soal)`);
    }
    if (limitSoal && cleanListening !== null && cleanListening > limitSoal) {
      throw new Error(`Batas soal listening (${cleanListening} soal) tidak boleh melebihi batas jumlah soal siswa (${limitSoal} soal)`);
    }
    const isAcak = (acak_soal !== undefined && acak_soal !== null) ? (acak_soal ? 1 : 0) : ((limitSoal || cleanIsian || cleanEssay || cleanListening !== null) ? 1 : 0);
    const cleanTanggalMulai = tanggal_mulai ? this.parseIndonesianDateTime(tanggal_mulai, cleanZonaWaktu) : null;
    const cleanTanggalSelesai = tanggal_selesai ? this.parseIndonesianDateTime(tanggal_selesai, cleanZonaWaktu) : null;
    const cleanDurasi = (durasi_menit !== undefined && durasi_menit !== null && durasi_menit !== '') ? Math.max(1, Number(durasi_menit)) : null;
    const cleanKkm = (data.kkm !== undefined && data.kkm !== null && data.kkm !== '') ? Math.max(0, Math.min(100, Number(data.kkm))) : 75;
    const cleanInstruksiRemedial = data.instruksi_remedial ? String(data.instruksi_remedial).trim() : null;
    const cleanLinkRemedial = data.link_remedial ? String(data.link_remedial).trim() : null;
    const izinkanSingkatan = data.izinkan_singkatan ? 1 : 0;
    const izinkanInformal = data.izinkan_informal ? 1 : 0;
    const toleransiTypo = (data.toleransi_typo !== undefined && data.toleransi_typo !== null) ? (data.toleransi_typo ? 1 : 0) : 1;
    const cleanInstruksiKhusus = data.instruksi_penilaian_khusus ? String(data.instruksi_penilaian_khusus).trim() : null;
    const tampilkanSimbol = (data.tampilkan_simbol !== undefined && data.tampilkan_simbol !== null) ? (data.tampilkan_simbol ? 1 : 0) : 1;
    const cleanLinkKisiKisi = data.link_kisi_kisi ? String(data.link_kisi_kisi).trim() : null;
    const tampilkanKisiKisi = (data.tampilkan_kisi_kisi !== undefined && data.tampilkan_kisi_kisi !== null) ? (data.tampilkan_kisi_kisi ? 1 : 0) : (cleanLinkKisiKisi ? 1 : 0);
    const tampilkanTeksListening = data.tampilkan_teks_listening ? 1 : 0;

    const stmt = db.prepare(`
      INSERT INTO ulangan (guru_id, judul, mata_pelajaran, tingkat_kelas, deskripsi, kode_ujian, status, jumlah_soal_tampil, jumlah_soal_isian, jumlah_soal_essay, jumlah_soal_listening, acak_soal, tanggal_mulai, tanggal_selesai, durasi_menit, kkm, instruksi_remedial, link_remedial, zona_waktu, izinkan_singkatan, izinkan_informal, toleransi_typo, instruksi_penilaian_khusus, tampilkan_simbol, link_kisi_kisi, tampilkan_kisi_kisi, tampilkan_teks_listening)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      guruId, judul, mata_pelajaran, tingkat_kelas, deskripsi || '', kode_ujian,
      limitSoal, cleanIsian, cleanEssay, cleanListening, isAcak, cleanTanggalMulai, cleanTanggalSelesai, cleanDurasi,
      cleanKkm, cleanInstruksiRemedial, cleanLinkRemedial, cleanZonaWaktu,
      izinkanSingkatan, izinkanInformal, toleransiTypo, cleanInstruksiKhusus, tampilkanSimbol, cleanLinkKisiKisi, tampilkanKisiKisi, tampilkanTeksListening
    );
    const ulanganId = info.lastInsertRowid;

    if (Array.isArray(kelas_ids) && kelas_ids.length > 0) {
      classService.assignKelasToUlangan(ulanganId, kelas_ids);
    } else if (tingkat_kelas && tingkat_kelas.toLowerCase() !== 'umum') {
      try {
        const classNames = tingkat_kelas.split(/[,;/]+/).map(s => s.trim()).filter(Boolean);
        const matchingClasses = db.prepare('SELECT id, nama_kelas FROM kelas WHERE guru_id = ?').all(guruId);
        const nameMap = new Map(matchingClasses.map(k => [k.nama_kelas.toLowerCase(), k.id]));
        const ids = classNames.map(cn => nameMap.get(cn.toLowerCase())).filter(Boolean);
        if (ids.length > 0) {
          classService.assignKelasToUlangan(ulanganId, ids);
        }
      } catch (e) {
        console.warn('Auto-link classes error in createUlangan:', e);
      }
    }

    return this.getUlanganById(ulanganId, guruId);
  },

  // Ambil semua ulangan milik guru tertentu
  getUlanganByGuru(guruId) {
    const rows = db.prepare(`
      SELECT u.*, 
        (SELECT COUNT(*) FROM soal WHERE ulangan_id = u.id) as total_soal,
        (SELECT COALESCE(SUM(bobot), 0) FROM soal WHERE ulangan_id = u.id) as total_bobot,
        (SELECT COUNT(*) FROM peserta WHERE ulangan_id = u.id) as total_peserta
      FROM ulangan u
      WHERE u.guru_id = ?
      ORDER BY u.created_at DESC
    `).all(guruId);
    return rows;
  },

  // Ambil detail ulangan berdasarkan ID
  getUlanganById(id, guruId = null) {
    let query = 'SELECT * FROM ulangan WHERE id = ?';
    let params = [id];
    if (guruId !== null) {
      query += ' AND guru_id = ?';
      params.push(guruId);
    }
    const ulangan = db.prepare(query).get(...params);
    if (!ulangan) return null;

    ulangan.soal = this.getSoalByUlangan(id);
    ulangan.total_bobot = ulangan.soal.reduce((acc, s) => acc + (s.bobot || 0), 0);
    ulangan.kelas = classService.getKelasByUlangan(id);
    return ulangan;
  },

  // Update informasi ulangan
  updateUlangan(id, guruIdOrData, maybeData) {
    let guruId = guruIdOrData;
    let data = maybeData;
    if (maybeData === undefined && typeof guruIdOrData === 'object' && guruIdOrData !== null) {
      data = guruIdOrData;
      const found = db.prepare('SELECT guru_id FROM ulangan WHERE id = ?').get(id);
      if (!found) {
        throw new Error('Ulangan tidak ditemukan');
      }
      guruId = found.guru_id;
    }

    const existing = db.prepare('SELECT id FROM ulangan WHERE id = ? AND guru_id = ?').get(id, guruId);
    if (!existing) {
      throw new Error('Ulangan tidak ditemukan atau bukan milik guru ini');
    }

    const { judul, mata_pelajaran, tingkat_kelas, deskripsi, status, kelas_ids, jumlah_soal_tampil, jumlah_soal_isian, jumlah_soal_essay, acak_soal, tanggal_mulai, tanggal_selesai, durasi_menit, kkm } = data;
    const updates = [];
    const params = [];

    if (judul !== undefined) { updates.push('judul = ?'); params.push(judul); }
    if (mata_pelajaran !== undefined) { updates.push('mata_pelajaran = ?'); params.push(mata_pelajaran); }
    if (tingkat_kelas !== undefined) { updates.push('tingkat_kelas = ?'); params.push(tingkat_kelas); }
    if (deskripsi !== undefined) { updates.push('deskripsi = ?'); params.push(deskripsi); }
    if (jumlah_soal_tampil !== undefined) {
      const limit = (jumlah_soal_tampil !== null && jumlah_soal_tampil !== '') ? Math.max(1, Number(jumlah_soal_tampil)) : null;
      updates.push('jumlah_soal_tampil = ?');
      params.push(limit);
    }
    if (data.jumlah_soal_isian !== undefined) {
      const limitIsian = (data.jumlah_soal_isian !== null && data.jumlah_soal_isian !== '') ? Math.max(0, Number(data.jumlah_soal_isian)) : null;
      updates.push('jumlah_soal_isian = ?');
      params.push(limitIsian);
    }
    if (data.jumlah_soal_essay !== undefined) {
      const limitEssay = (data.jumlah_soal_essay !== null && data.jumlah_soal_essay !== '') ? Math.max(0, Number(data.jumlah_soal_essay)) : null;
      updates.push('jumlah_soal_essay = ?');
      params.push(limitEssay);
    }
    if (data.jumlah_soal_listening !== undefined) {
      const limitListening = (data.jumlah_soal_listening !== null && data.jumlah_soal_listening !== '') ? Math.max(0, Number(data.jumlah_soal_listening)) : null;
      updates.push('jumlah_soal_listening = ?');
      params.push(limitListening);
    }
    if (acak_soal !== undefined) {
      updates.push('acak_soal = ?');
      params.push(acak_soal ? 1 : 0);
    }
    // Validasi kuota tipe soal tidak boleh melebihi batas jumlah soal siswa
    const existingRow = db.prepare('SELECT jumlah_soal_tampil, jumlah_soal_isian, jumlah_soal_essay, jumlah_soal_listening, zona_waktu FROM ulangan WHERE id = ?').get(id);
    const finalLimit = jumlah_soal_tampil !== undefined 
      ? ((jumlah_soal_tampil !== null && jumlah_soal_tampil !== '') ? Math.max(1, Number(jumlah_soal_tampil)) : null)
      : existingRow?.jumlah_soal_tampil;
    const finalIsian = data.jumlah_soal_isian !== undefined
      ? ((data.jumlah_soal_isian !== null && data.jumlah_soal_isian !== '') ? Math.max(0, Number(data.jumlah_soal_isian)) : 0)
      : (existingRow?.jumlah_soal_isian || 0);
    const finalEssay = data.jumlah_soal_essay !== undefined
      ? ((data.jumlah_soal_essay !== null && data.jumlah_soal_essay !== '') ? Math.max(0, Number(data.jumlah_soal_essay)) : 0)
      : (existingRow?.jumlah_soal_essay || 0);
    const finalListening = data.jumlah_soal_listening !== undefined
      ? ((data.jumlah_soal_listening !== null && data.jumlah_soal_listening !== '') ? Math.max(0, Number(data.jumlah_soal_listening)) : null)
      : (existingRow?.jumlah_soal_listening !== undefined ? existingRow.jumlah_soal_listening : null);

    if (finalLimit && (finalIsian + finalEssay > finalLimit)) {
      throw new Error(`Total kuota wajib (${finalIsian + finalEssay} soal) tidak boleh melebihi batas jumlah soal siswa (${finalLimit} soal)`);
    }
    if (finalLimit && finalListening !== null && finalListening > finalLimit) {
      throw new Error(`Batas soal listening (${finalListening} soal) tidak boleh melebihi batas jumlah soal siswa (${finalLimit} soal)`);
    }

    let currentZw = data.zona_waktu;
    if (currentZw !== undefined) {
      currentZw = (currentZw && ['WIB', 'WITA', 'WIT'].includes(String(currentZw).toUpperCase())) ? String(currentZw).toUpperCase() : 'WIB';
      updates.push('zona_waktu = ?');
      params.push(currentZw);
    } else {
      currentZw = existingRow?.zona_waktu || 'WIB';
    }

    if (tanggal_mulai !== undefined) {
      updates.push('tanggal_mulai = ?');
      params.push(tanggal_mulai ? this.parseIndonesianDateTime(tanggal_mulai, currentZw) : null);
    }
    if (tanggal_selesai !== undefined) {
      updates.push('tanggal_selesai = ?');
      params.push(tanggal_selesai ? this.parseIndonesianDateTime(tanggal_selesai, currentZw) : null);
    }
    if (durasi_menit !== undefined) {
      const durasi = (durasi_menit !== null && durasi_menit !== '') ? Math.max(1, Number(durasi_menit)) : null;
      updates.push('durasi_menit = ?');
      params.push(durasi);
    }
    if (kkm !== undefined) {
      const cleanKkm = (kkm !== null && kkm !== '') ? Math.max(0, Math.min(100, Number(kkm))) : 75;
      updates.push('kkm = ?');
      params.push(cleanKkm);
    }
    if (data.instruksi_remedial !== undefined) {
      updates.push('instruksi_remedial = ?');
      params.push(data.instruksi_remedial ? String(data.instruksi_remedial).trim() : null);
    }
    if (data.link_remedial !== undefined) {
      updates.push('link_remedial = ?');
      params.push(data.link_remedial ? String(data.link_remedial).trim() : null);
    }
    if (data.izinkan_singkatan !== undefined) {
      updates.push('izinkan_singkatan = ?');
      params.push(data.izinkan_singkatan ? 1 : 0);
    }
    if (data.izinkan_informal !== undefined) {
      updates.push('izinkan_informal = ?');
      params.push(data.izinkan_informal ? 1 : 0);
    }
    if (data.toleransi_typo !== undefined) {
      updates.push('toleransi_typo = ?');
      params.push(data.toleransi_typo ? 1 : 0);
    }
    if (data.instruksi_penilaian_khusus !== undefined) {
      updates.push('instruksi_penilaian_khusus = ?');
      params.push(data.instruksi_penilaian_khusus ? String(data.instruksi_penilaian_khusus).trim() : null);
    }
    if (data.tampilkan_simbol !== undefined) {
      updates.push('tampilkan_simbol = ?');
      params.push(data.tampilkan_simbol ? 1 : 0);
    }
    if (data.link_kisi_kisi !== undefined) {
      updates.push('link_kisi_kisi = ?');
      params.push(data.link_kisi_kisi ? String(data.link_kisi_kisi).trim() : null);
    }
    if (data.tampilkan_kisi_kisi !== undefined) {
      updates.push('tampilkan_kisi_kisi = ?');
      params.push(data.tampilkan_kisi_kisi ? 1 : 0);
    }
    if (data.tampilkan_teks_listening !== undefined) {
      updates.push('tampilkan_teks_listening = ?');
      params.push(data.tampilkan_teks_listening ? 1 : 0);
    }
    if (status !== undefined) {
      if (!['draft', 'dibuka', 'ditutup', 'selesai'].includes(status)) {
        throw new Error('Status tidak valid');
      }
      updates.push('status = ?');
      params.push(status);
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id, guruId);
      db.prepare(`UPDATE ulangan SET ${updates.join(', ')} WHERE id = ? AND guru_id = ?`).run(...params);
    }

    if (Array.isArray(kelas_ids) && kelas_ids.length > 0) {
      classService.assignKelasToUlangan(id, kelas_ids);
    } else if (tingkat_kelas !== undefined && tingkat_kelas && tingkat_kelas.toLowerCase() !== 'umum') {
      try {
        const classNames = tingkat_kelas.split(/[,;/]+/).map(s => s.trim()).filter(Boolean);
        const matchingClasses = db.prepare('SELECT id, nama_kelas FROM kelas WHERE guru_id = ?').all(guruId);
        const nameMap = new Map(matchingClasses.map(k => [k.nama_kelas.toLowerCase(), k.id]));
        const ids = classNames.map(cn => nameMap.get(cn.toLowerCase())).filter(Boolean);
        if (ids.length > 0) {
          classService.assignKelasToUlangan(id, ids);
        } else if (Array.isArray(kelas_ids)) {
          classService.assignKelasToUlangan(id, kelas_ids);
        }
      } catch (e) {
        if (Array.isArray(kelas_ids)) classService.assignKelasToUlangan(id, kelas_ids);
      }
    } else if (Array.isArray(kelas_ids)) {
      classService.assignKelasToUlangan(id, kelas_ids);
    }

    return this.getUlanganById(id, guruId);
  },

  // Update status ulangan secara langsung
  updateStatusUlangan(id, status) {
    if (!['draft', 'dibuka', 'ditutup', 'selesai'].includes(status)) {
      throw new Error('Status tidak valid');
    }
    db.prepare('UPDATE ulangan SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
    return db.prepare('SELECT * FROM ulangan WHERE id = ?').get(id);
  },

  // Hapus ulangan
  deleteUlangan(id, guruId) {
    const existing = db.prepare('SELECT id FROM ulangan WHERE id = ? AND guru_id = ?').get(id, guruId);
    if (!existing) {
      throw new Error('Ulangan tidak ditemukan atau bukan milik guru ini');
    }
    db.prepare('DELETE FROM ulangan WHERE id = ? AND guru_id = ?').run(id, guruId);
    return true;
  },

  // FR-04: Buat Soal
  createSoal(ulanganId, data) {
    const { pertanyaan, jenis, bobot, kunci_jawaban, rubrik, tingkat_kelas, tingkat_kesulitan, gambar_url, pembahasan, audio_url, audio_script, is_listening, bahasa, kategori } = data;

    if (!pertanyaan || !jenis || bobot === undefined) {
      throw new Error('Pertanyaan, jenis soal, dan bobot wajib diisi');
    }

    if (!['isian', 'essay'].includes(jenis)) {
      throw new Error('Jenis soal harus isian atau essay');
    }

    const numBobot = Number(bobot);
    if (isNaN(numBobot) || numBobot <= 0) {
      throw new Error('Bobot soal harus berupa angka lebih besar dari 0');
    }

    // Urutan & nomor soal otomatis
    const maxOrder = db.prepare('SELECT MAX(urutan) as max_u, MAX(nomor) as max_n FROM soal WHERE ulangan_id = ?').get(ulanganId);
    const nextNomor = (maxOrder?.max_n || 0) + 1;
    const nextUrutan = (maxOrder?.max_u || 0) + 1;

    const stmt = db.prepare(`
      INSERT INTO soal (ulangan_id, nomor, jenis, pertanyaan, gambar_url, kunci_jawaban, rubrik, bobot, tingkat_kelas, tingkat_kesulitan, urutan, pembahasan, audio_url, audio_script, is_listening, bahasa, kategori, tampilkan_teks_listening)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const cleanTampilkanTeks = (data.tampilkan_teks_listening !== undefined && data.tampilkan_teks_listening !== null && data.tampilkan_teks_listening !== '')
      ? (data.tampilkan_teks_listening ? 1 : 0)
      : null;

    const info = stmt.run(
      ulanganId,
      data.nomor || nextNomor,
      jenis,
      pertanyaan,
      gambar_url || null,
      kunci_jawaban || '',
      rubrik || '',
      numBobot,
      tingkat_kelas || '',
      tingkat_kesulitan || 'sedang',
      data.urutan || nextUrutan,
      pembahasan || null,
      audio_url || null,
      audio_script || null,
      is_listening ? 1 : 0,
      bahasa || null,
      kategori || null,
      cleanTampilkanTeks
    );

    return db.prepare('SELECT * FROM soal WHERE id = ?').get(info.lastInsertRowid);
  },

  addSoal(ulanganId, data) {
    return this.createSoal(ulanganId, data);
  },

  getSoalByUlangan(ulanganId) {
    return db.prepare('SELECT * FROM soal WHERE ulangan_id = ? ORDER BY urutan ASC, nomor ASC').all(ulanganId);
  },

  getSoalById(soalId) {
    return db.prepare('SELECT * FROM soal WHERE id = ?').get(soalId);
  },

  updateSoal(soalId, data) {
    const existing = db.prepare('SELECT id FROM soal WHERE id = ?').get(soalId);
    if (!existing) {
      throw new Error('Soal tidak ditemukan');
    }

    const updates = [];
    const params = [];

    if (data.pertanyaan !== undefined) { updates.push('pertanyaan = ?'); params.push(data.pertanyaan); }
    if (data.gambar_url !== undefined) { updates.push('gambar_url = ?'); params.push(data.gambar_url); }
    if (data.jenis !== undefined) {
      if (!['isian', 'essay'].includes(data.jenis)) throw new Error('Jenis soal harus isian atau essay');
      updates.push('jenis = ?');
      params.push(data.jenis);
    }
    if (data.bobot !== undefined) {
      const b = Number(data.bobot);
      if (isNaN(b) || b <= 0) throw new Error('Bobot soal harus lebih besar dari 0');
      updates.push('bobot = ?');
      params.push(b);
    }
    if (data.kunci_jawaban !== undefined) { updates.push('kunci_jawaban = ?'); params.push(data.kunci_jawaban); }
    if (data.rubrik !== undefined) { updates.push('rubrik = ?'); params.push(data.rubrik); }
    if (data.pembahasan !== undefined) { updates.push('pembahasan = ?'); params.push(data.pembahasan); }
    if (data.tingkat_kelas !== undefined) { updates.push('tingkat_kelas = ?'); params.push(data.tingkat_kelas); }
    if (data.tingkat_kesulitan !== undefined) { updates.push('tingkat_kesulitan = ?'); params.push(data.tingkat_kesulitan); }
    if (data.urutan !== undefined) { updates.push('urutan = ?'); params.push(data.urutan); }
    if (data.nomor !== undefined) { updates.push('nomor = ?'); params.push(data.nomor); }
    if (data.audio_url !== undefined) { updates.push('audio_url = ?'); params.push(data.audio_url || null); }
    if (data.audio_script !== undefined) { updates.push('audio_script = ?'); params.push(data.audio_script || null); }
    if (data.is_listening !== undefined) { updates.push('is_listening = ?'); params.push(data.is_listening ? 1 : 0); }
    if (data.bahasa !== undefined) { updates.push('bahasa = ?'); params.push(data.bahasa || null); }
    if (data.kategori !== undefined) { updates.push('kategori = ?'); params.push(data.kategori || null); }
    if (data.tampilkan_teks_listening !== undefined) {
      const cleanTampilkanTeks = (data.tampilkan_teks_listening !== null && data.tampilkan_teks_listening !== '')
        ? (data.tampilkan_teks_listening ? 1 : 0)
        : null;
      updates.push('tampilkan_teks_listening = ?');
      params.push(cleanTampilkanTeks);
    }

    if (updates.length === 0) return this.getSoalById(soalId);

    params.push(soalId);
    db.prepare(`UPDATE soal SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return this.getSoalById(soalId);
  },

  deleteSoal(soalId) {
    const existing = db.prepare('SELECT id FROM soal WHERE id = ?').get(soalId);
    if (!existing) throw new Error('Soal tidak ditemukan');
    db.prepare('DELETE FROM soal WHERE id = ?').run(soalId);
    return true;
  },

  // FR-05: Normalisasi Nilai (Maksimum 100)
  calculateNormalizedScore(scoredItems) {
    if (!scoredItems || scoredItems.length === 0) return 0;

    let totalObtained = 0;
    let totalMaxPossible = 0;

    for (const item of scoredItems) {
      const maxScore = Number(item.bobot || item.skor_maksimum || 0);
      const score = Number(item.skor_final ?? item.skor_rekomendasi ?? 0);

      // Batasi skor pada rentang 0 sampai bobot soal (NFR-08)
      const clampedScore = Math.max(0, Math.min(score, maxScore));

      totalObtained += clampedScore;
      totalMaxPossible += maxScore;
    }

    if (totalMaxPossible <= 0) return 0;

    const normalized = (totalObtained / totalMaxPossible) * 100;
    // Bulatkan hingga 2 tempat desimal dan pastikan tidak melebihi 100
    const finalScore = Math.min(100, Math.max(0, Math.round(normalized * 100) / 100));
    return finalScore;
  },

  // Review jawaban siswa
  reviewJawaban(jawabanId, skor, catatan = null) {
    const jawaban = db.prepare(`
      SELECT j.id, j.pengerjaan_id, u.guru_id
      FROM jawaban j
      JOIN pengerjaan p ON j.pengerjaan_id = p.id
      JOIN ulangan u ON p.ulangan_id = u.id
      WHERE j.id = ?
    `).get(jawabanId);
    if (!jawaban) throw new Error('Jawaban tidak ditemukan');
    const reviewService = require('./reviewService');
    return reviewService.updateJawabanReview(jawabanId, jawaban.guru_id, {
      skor_final: skor,
      catatan_guru: catatan
    });
  },

  // Rilis nilai ulangan
  releaseNilai(ulanganId, isReleased = true) {
    const ulangan = db.prepare('SELECT id, guru_id FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan');
    const reviewService = require('./reviewService');
    return reviewService.toggleReleasePengerjaan(ulanganId, ulangan.guru_id, isReleased);
  }
};

module.exports = examService;
