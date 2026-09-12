const db = require('../config/database');
const examService = require('./examService');

const bankSoalService = {
  // Ambil semua soal di bank soal milik guru dengan opsi filter & pencarian
  getAll(guruId, filters = {}) {
    let query = 'SELECT * FROM bank_soal WHERE guru_id = ?';
    const params = [guruId];

    if (filters.kategori && filters.kategori.trim() && filters.kategori !== 'all') {
      query += ' AND kategori = ?';
      params.push(filters.kategori.trim());
    }

    if (filters.jenis && ['isian', 'essay'].includes(filters.jenis)) {
      query += ' AND jenis = ?';
      params.push(filters.jenis);
    }

    if (filters.tingkat_kesulitan && ['mudah', 'sedang', 'sulit'].includes(filters.tingkat_kesulitan)) {
      query += ' AND tingkat_kesulitan = ?';
      params.push(filters.tingkat_kesulitan);
    }

    if (filters.tingkat_kelas && filters.tingkat_kelas.trim() && filters.tingkat_kelas !== 'all') {
      query += ' AND tingkat_kelas = ?';
      params.push(filters.tingkat_kelas.trim());
    }

    if (filters.is_listening !== undefined && filters.is_listening !== null && filters.is_listening !== '' && filters.is_listening !== 'all') {
      query += ' AND is_listening = ?';
      params.push(Number(filters.is_listening) ? 1 : 0);
    }

    if (filters.search && filters.search.trim()) {
      const kw = '%' + filters.search.trim() + '%';
      query += ' AND (pertanyaan LIKE ? OR pembahasan LIKE ? OR kunci_jawaban LIKE ? OR sub_topik LIKE ?)';
      params.push(kw, kw, kw, kw);
    }

    query += ' ORDER BY created_at DESC';

    return db.prepare(query).all(...params);
  },

  // Ambil detail butir bank soal berdasarkan ID
  getById(id, guruId) {
    return db.prepare('SELECT * FROM bank_soal WHERE id = ? AND guru_id = ?').get(id, guruId);
  },

  // Ambil daftar kategori unik milik guru untuk dropdown filter
  getCategories(guruId) {
    const rows = db.prepare(`
      SELECT DISTINCT kategori 
      FROM bank_soal 
      WHERE guru_id = ? AND kategori IS NOT NULL AND TRIM(kategori) != ''
      ORDER BY kategori ASC
    `).all(guruId);
    return rows.map(r => r.kategori);
  },

  // Tambah soal baru ke Bank Soal
  create(guruId, data) {
    const {
      kategori, sub_topik, tingkat_kelas, jenis, pertanyaan,
      kunci_jawaban, rubrik, pembahasan, tingkat_kesulitan,
      bobot_standar, gambar_url, audio_url, audio_script, is_listening, bahasa
    } = data;

    if (!pertanyaan || !pertanyaan.trim()) {
      throw new Error('Pertanyaan wajib diisi');
    }

    const cleanJenis = jenis === 'isian' ? 'isian' : 'essay';
    const cleanKategori = (kategori && kategori.trim()) ? kategori.trim() : 'Umum';
    const cleanKesulitan = ['mudah', 'sedang', 'sulit'].includes(tingkat_kesulitan) ? tingkat_kesulitan : 'sedang';
    const cleanBobot = (bobot_standar !== undefined && bobot_standar !== null && Number(bobot_standar) > 0) ? Number(bobot_standar) : 10;
    const cleanListening = is_listening ? 1 : 0;
    const cleanTampilkanTeks = (data.tampilkan_teks_listening !== undefined && data.tampilkan_teks_listening !== null && data.tampilkan_teks_listening !== '')
      ? (data.tampilkan_teks_listening ? 1 : 0)
      : 0;

    const stmt = db.prepare(`
      INSERT INTO bank_soal (
        guru_id, kategori, sub_topik, tingkat_kelas, jenis,
        pertanyaan, kunci_jawaban, rubrik, pembahasan, tingkat_kesulitan,
        bobot_standar, gambar_url, audio_url, audio_script, is_listening, bahasa, tampilkan_teks_listening
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      guruId,
      cleanKategori,
      sub_topik || null,
      tingkat_kelas || null,
      cleanJenis,
      pertanyaan.trim(),
      kunci_jawaban || null,
      rubrik || null,
      pembahasan || null,
      cleanKesulitan,
      cleanBobot,
      gambar_url || null,
      audio_url || null,
      audio_script || null,
      cleanListening,
      bahasa || null,
      cleanTampilkanTeks
    );

    db.syncCloud();
    return this.getById(info.lastInsertRowid, guruId);
  },

  // Simpan banyak butir soal sekaligus ke Bank Soal (misal hasil AI Generator)
  createBatch(guruId, items) {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }
    const createdList = [];
    for (const item of items) {
      createdList.push(this.create(guruId, item));
    }
    return createdList;
  },

  // Perbarui soal di Bank Soal
  update(id, guruId, data) {
    const existing = this.getById(id, guruId);
    if (!existing) {
      throw new Error('Soal bank tidak ditemukan atau bukan milik Anda');
    }

    const updates = [];
    const params = [];

    if (data.kategori !== undefined) { updates.push('kategori = ?'); params.push(data.kategori ? data.kategori.trim() : 'Umum'); }
    if (data.sub_topik !== undefined) { updates.push('sub_topik = ?'); params.push(data.sub_topik ? data.sub_topik.trim() : null); }
    if (data.tingkat_kelas !== undefined) { updates.push('tingkat_kelas = ?'); params.push(data.tingkat_kelas ? data.tingkat_kelas.trim() : null); }
    if (data.jenis !== undefined) {
      if (!['isian', 'essay'].includes(data.jenis)) throw new Error('Jenis soal harus isian atau essay');
      updates.push('jenis = ?'); params.push(data.jenis);
    }
    if (data.pertanyaan !== undefined) {
      if (!data.pertanyaan.trim()) throw new Error('Pertanyaan tidak boleh kosong');
      updates.push('pertanyaan = ?'); params.push(data.pertanyaan.trim());
    }
    if (data.kunci_jawaban !== undefined) { updates.push('kunci_jawaban = ?'); params.push(data.kunci_jawaban); }
    if (data.rubrik !== undefined) { updates.push('rubrik = ?'); params.push(data.rubrik); }
    if (data.pembahasan !== undefined) { updates.push('pembahasan = ?'); params.push(data.pembahasan); }
    if (data.tingkat_kesulitan !== undefined) {
      const k = ['mudah', 'sedang', 'sulit'].includes(data.tingkat_kesulitan) ? data.tingkat_kesulitan : 'sedang';
      updates.push('tingkat_kesulitan = ?'); params.push(k);
    }
    if (data.bobot_standar !== undefined) {
      const b = Math.max(1, Number(data.bobot_standar) || 10);
      updates.push('bobot_standar = ?'); params.push(b);
    }
    if (data.gambar_url !== undefined) { updates.push('gambar_url = ?'); params.push(data.gambar_url || null); }
    if (data.audio_url !== undefined) { updates.push('audio_url = ?'); params.push(data.audio_url || null); }
    if (data.audio_script !== undefined) { updates.push('audio_script = ?'); params.push(data.audio_script || null); }
    if (data.is_listening !== undefined) { updates.push('is_listening = ?'); params.push(data.is_listening ? 1 : 0); }
    if (data.bahasa !== undefined) { updates.push('bahasa = ?'); params.push(data.bahasa || null); }
    if (data.tampilkan_teks_listening !== undefined) {
      updates.push('tampilkan_teks_listening = ?');
      params.push(data.tampilkan_teks_listening ? 1 : 0);
    }

    if (updates.length === 0) return existing;

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id, guruId);

    db.prepare(`UPDATE bank_soal SET ${updates.join(', ')} WHERE id = ? AND guru_id = ?`).run(...params);
    db.syncCloud();
    return this.getById(id, guruId);
  },

  // Hapus butir soal dari Bank Soal
  delete(id, guruId) {
    const existing = this.getById(id, guruId);
    if (!existing) {
      throw new Error('Soal bank tidak ditemukan atau bukan milik Anda');
    }
    db.prepare('DELETE FROM bank_soal WHERE id = ? AND guru_id = ?').run(id, guruId);
    db.syncCloud();
    return true;
  },

  // Simpan/Salin soal dari paket ulangan aktif ke Bank Soal
  copyFromExamSoal(soalId, guruId, customCategory = null) {
    const row = db.prepare(`
      SELECT s.*, u.guru_id, u.mata_pelajaran, u.tingkat_kelas as u_tingkat_kelas
      FROM soal s
      JOIN ulangan u ON s.ulangan_id = u.id
      WHERE s.id = ?
    `).get(soalId);

    if (!row) {
      throw new Error('Soal ulangan tidak ditemukan');
    }

    if (row.guru_id !== guruId) {
      throw new Error('Anda tidak memiliki akses ke soal ulangan ini');
    }

    const kategori = customCategory || row.kategori || row.mata_pelajaran || 'Umum';

    return this.create(guruId, {
      kategori,
      sub_topik: null,
      tingkat_kelas: row.tingkat_kelas || row.u_tingkat_kelas,
      jenis: row.jenis,
      pertanyaan: row.pertanyaan,
      kunci_jawaban: row.kunci_jawaban,
      rubrik: row.rubrik,
      pembahasan: row.pembahasan || null,
      tingkat_kesulitan: row.tingkat_kesulitan || 'sedang',
      bobot_standar: row.bobot || 10,
      gambar_url: row.gambar_url,
      audio_url: row.audio_url,
      audio_script: row.audio_script,
      is_listening: row.is_listening,
      bahasa: row.bahasa,
      tampilkan_teks_listening: row.tampilkan_teks_listening
    });
  },

  // Salin banyak butir soal sekaligus dari ulangan aktif ke Bank Soal
  copyBatchFromExam(ulanganId, soalIds, guruId, customCategory = null) {
    if (!Array.isArray(soalIds) || soalIds.length === 0) {
      throw new Error('Pilih minimal satu butir soal untuk dimasukkan ke Bank Soal');
    }

    const ulangan = db.prepare('SELECT id, guru_id, mata_pelajaran, tingkat_kelas FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan || ulangan.guru_id !== guruId) {
      throw new Error('Ulangan tidak ditemukan atau bukan milik Anda');
    }

    const placeholders = soalIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT * FROM soal 
      WHERE id IN (${placeholders}) AND ulangan_id = ?
    `).all(...soalIds, ulanganId);

    if (rows.length === 0) {
      throw new Error('Tidak ada butir soal valid yang ditemukan untuk disalin');
    }

    const createdList = [];
    for (const row of rows) {
      const kategori = (customCategory && customCategory.trim())
        ? customCategory.trim()
        : (row.kategori || ulangan.mata_pelajaran || 'Umum');

      const created = this.create(guruId, {
        kategori,
        sub_topik: null,
        tingkat_kelas: row.tingkat_kelas || ulangan.tingkat_kelas,
        jenis: row.jenis,
        pertanyaan: row.pertanyaan,
        kunci_jawaban: row.kunci_jawaban,
        rubrik: row.rubrik,
        pembahasan: row.pembahasan || null,
        tingkat_kesulitan: row.tingkat_kesulitan || 'sedang',
        bobot_standar: row.bobot || 10,
        gambar_url: row.gambar_url,
        audio_url: row.audio_url,
        audio_script: row.audio_script,
        is_listening: row.is_listening,
        bahasa: row.bahasa,
        tampilkan_teks_listening: row.tampilkan_teks_listening
      });
      createdList.push(created);
    }

    return createdList;
  },

  // Impor sekumpulan butir Bank Soal ke dalam ulangan aktif
  importToExam(ulanganId, guruId, bankSoalIds) {
    if (!Array.isArray(bankSoalIds) || bankSoalIds.length === 0) {
      throw new Error('Pilih minimal satu soal dari Bank Soal untuk diimpor');
    }

    const ulangan = db.prepare('SELECT id, guru_id FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan || ulangan.guru_id !== guruId) {
      throw new Error('Ulangan target tidak ditemukan atau bukan milik Anda');
    }

    const placeholders = bankSoalIds.map(() => '?').join(',');
    const bankItems = db.prepare(`
      SELECT * FROM bank_soal 
      WHERE id IN (${placeholders}) AND guru_id = ?
    `).all(...bankSoalIds, guruId);

    if (bankItems.length === 0) {
      throw new Error('Tidak ada soal valid yang ditemukan di Bank Soal');
    }

    const createdSoalList = [];
    for (const bSoal of bankItems) {
      const newSoal = examService.createSoal(ulanganId, {
        pertanyaan: bSoal.pertanyaan,
        jenis: bSoal.jenis,
        bobot: bSoal.bobot_standar || 10,
        kunci_jawaban: bSoal.kunci_jawaban || '',
        rubrik: bSoal.rubrik || '',
        tingkat_kelas: bSoal.tingkat_kelas || '',
        tingkat_kesulitan: bSoal.tingkat_kesulitan || 'sedang',
        gambar_url: bSoal.gambar_url || null,
        pembahasan: bSoal.pembahasan || null,
        audio_url: bSoal.audio_url || null,
        audio_script: bSoal.audio_script || null,
        is_listening: bSoal.is_listening || 0,
        bahasa: bSoal.bahasa || null,
        kategori: bSoal.kategori || null,
        tampilkan_teks_listening: bSoal.tampilkan_teks_listening
      });
      createdSoalList.push(newSoal);
    }

    db.syncCloud();
    return createdSoalList;
  },

  // AI Cerdas Pemilih Soal dari Bank Soal berdasarkan kriteria guru
  aiSmartPick(guruId, ulanganId, criteria = {}) {
    const {
      kategori,
      sub_topik,
      jumlah_soal,
      jumlah_isian,
      jumlah_essay,
      tingkat_kesulitan,
      is_listening,
      auto_import
    } = criteria;

    let pool = this.getAll(guruId, {
      kategori: (kategori && kategori !== 'all') ? kategori : undefined,
      tingkat_kesulitan: (tingkat_kesulitan && tingkat_kesulitan !== 'campuran') ? tingkat_kesulitan : undefined,
      is_listening: (is_listening !== undefined && is_listening !== null && is_listening !== '') ? is_listening : undefined
    });

    if (sub_topik && sub_topik.trim()) {
      const st = sub_topik.toLowerCase();
      pool = pool.filter(q => 
        (q.sub_topik && q.sub_topik.toLowerCase().includes(st)) ||
        q.pertanyaan.toLowerCase().includes(st) ||
        (q.pembahasan && q.pembahasan.toLowerCase().includes(st))
      );
    }

    if (pool.length === 0) {
      throw new Error('Tidak ada soal di Bank Soal yang memenuhi kriteria yang diminta');
    }

    const isianPool = pool.filter(q => q.jenis === 'isian');
    const essayPool = pool.filter(q => q.jenis === 'essay');

    const shuffle = (arr) => {
      const res = [...arr];
      for (let i = res.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [res[i], res[j]] = [res[j], res[i]];
      }
      return res;
    };

    let selected = [];

    const reqIsian = (jumlah_isian !== undefined && jumlah_isian !== null && jumlah_isian !== '') ? Number(jumlah_isian) : null;
    const reqEssay = (jumlah_essay !== undefined && jumlah_essay !== null && jumlah_essay !== '') ? Number(jumlah_essay) : null;
    const reqTotal = (jumlah_soal !== undefined && jumlah_soal !== null && jumlah_soal !== '') ? Number(jumlah_soal) : null;

    if (reqIsian !== null || reqEssay !== null) {
      const takeIsian = Math.min(reqIsian || 0, isianPool.length);
      const takeEssay = Math.min(reqEssay || 0, essayPool.length);

      const shuffledIsian = shuffle(isianPool);
      const shuffledEssay = shuffle(essayPool);

      selected.push(...shuffledIsian.slice(0, takeIsian));
      selected.push(...shuffledEssay.slice(0, takeEssay));

      if (reqTotal && selected.length < reqTotal) {
        const remainingIds = new Set(selected.map(s => s.id));
        const rest = shuffle(pool.filter(q => !remainingIds.has(q.id)));
        const needed = reqTotal - selected.length;
        selected.push(...rest.slice(0, needed));
      }
    } else {
      const count = reqTotal ? Math.min(reqTotal, pool.length) : Math.min(5, pool.length);
      selected = shuffle(pool).slice(0, count);
    }

    let imported = [];
    if (auto_import && ulanganId) {
      imported = this.importToExam(ulanganId, guruId, selected.map(s => s.id));
    }

    return {
      success: true,
      total_ditemukan: pool.length,
      total_dipilih: selected.length,
      selected_soal: selected,
      imported_soal: imported
    };
  }
};

module.exports = bankSoalService;
