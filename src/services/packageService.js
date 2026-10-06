const db = require('../config/database');

const packageService = {
  // Ambil daftar nama paket standar
  getPackageNames(count = 1) {
    const validCount = Math.max(1, Math.min(4, Number(count) || 1));
    return ['A', 'B', 'C', 'D'].slice(0, validCount);
  },

  // Seeded deterministic shuffle agar pengacakan paket konsisten dan reproducible
  seededShuffle(array, seedStr) {
    const arr = [...array];
    let seed = 0;
    for (let i = 0; i < seedStr.length; i++) {
      seed = (seed * 31 + seedStr.charCodeAt(i)) & 0xffffffff;
    }
    const pseudoRandom = () => {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      return (seed >>> 0) / 4294967296;
    };

    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(pseudoRandom() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },

  // Generate / regenerasi paket soal untuk satu ulangan
  generatePackages(ulanganId, options = {}) {
    const ulangan = db.prepare('SELECT * FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) {
      throw new Error('Ulangan tidak ditemukan');
    }

    const packageCount = Math.max(1, Math.min(4, Number(options.packageCount || ulangan.jumlah_paket || 1)));
    const packageNames = this.getPackageNames(packageCount);

    // Ambil soal pilihan ganda yang terkait dengan ulangan ini
    // Catatan: Jika ada soal esai/isian juga, kita pisahkan agar PG tetap berurutan di awal
    const pgQuestions = db.prepare(`
      SELECT id, nomor, pertanyaan, opsi_a, opsi_b, opsi_c, opsi_d, opsi_e, kunci_pg, bobot, urutan
      FROM soal
      WHERE ulangan_id = ? AND jenis = 'pilihan_ganda'
      ORDER BY urutan ASC, nomor ASC
    `).all(ulanganId);

    if (pgQuestions.length === 0) {
      // Jika belum ada jenis 'pilihan_ganda', cek apakah ada soal umum yang memiliki kunci_pg
      const fallbackPg = db.prepare(`
        SELECT id, nomor, pertanyaan, opsi_a, opsi_b, opsi_c, opsi_d, opsi_e, kunci_pg, bobot, urutan
        FROM soal
        WHERE ulangan_id = ? AND kunci_pg IS NOT NULL AND TRIM(kunci_pg) != ''
        ORDER BY urutan ASC, nomor ASC
      `).all(ulanganId);
      if (fallbackPg.length > 0) {
        pgQuestions.push(...fallbackPg);
      }
    }

    // Hapus paket lama jika ada
    db.prepare('DELETE FROM paket_soal WHERE ulangan_id = ?').run(ulanganId);

    const createdPackages = [];

    for (const pkgName of packageNames) {
      let orderedQuestions;
      if (pkgName === 'A') {
        // Paket A selalu urutan asli
        orderedQuestions = [...pgQuestions];
      } else {
        // Paket B, C, D diacak dengan seed deterministik
        orderedQuestions = this.seededShuffle(pgQuestions, `ulangan-${ulanganId}-paket-${pkgName}`);
      }

      const questionIds = orderedQuestions.map(q => q.id);
      const answerKeyMap = {};

      orderedQuestions.forEach((q, index) => {
        const displayNum = index + 1;
        answerKeyMap[String(displayNum)] = (q.kunci_pg || 'A').toUpperCase().trim();
      });

      const stmt = db.prepare(`
        INSERT INTO paket_soal (ulangan_id, nama_paket, urutan_soal_ids, kunci_jawaban_map)
        VALUES (?, ?, ?, ?)
      `);

      const info = stmt.run(
        ulanganId,
        pkgName,
        JSON.stringify(questionIds),
        JSON.stringify(answerKeyMap)
      );

      createdPackages.push({
        id: info.lastInsertRowid,
        ulangan_id: ulanganId,
        nama_paket: pkgName,
        total_soal_pg: orderedQuestions.length,
        kunci_jawaban_map: answerKeyMap,
        urutan_soal_ids: questionIds
      });
    }

    // Update jumlah paket di tabel ulangan
    db.prepare('UPDATE ulangan SET jumlah_paket = ? WHERE id = ?').run(packageCount, ulanganId);
    if (typeof db.syncCloud === 'function') db.syncCloud(true);

    return {
      success: true,
      ulangan_id: ulanganId,
      jumlah_paket: packageCount,
      packages: createdPackages
    };
  },

  // Ambil daftar paket untuk ulangan tertentu
  getPackagesByUlangan(ulanganId) {
    const packages = db.prepare(`
      SELECT id, ulangan_id, nama_paket, urutan_soal_ids, kunci_jawaban_map, created_at
      FROM paket_soal
      WHERE ulangan_id = ?
      ORDER BY nama_paket ASC
    `).all(ulanganId);

    return packages.map(p => {
      try {
        p.urutan_soal_ids = JSON.parse(p.urutan_soal_ids);
      } catch (e) {
        p.urutan_soal_ids = [];
      }
      try {
        p.kunci_jawaban_map = JSON.parse(p.kunci_jawaban_map);
      } catch (e) {
        p.kunci_jawaban_map = {};
      }
      p.total_soal = Array.isArray(p.urutan_soal_ids) ? p.urutan_soal_ids.length : 0;
      return p;
    });
  },

  // Ambil kunci jawaban spesifik suatu paket
  getAnswerKey(ulanganId, packageName = 'A') {
    const pkg = db.prepare(`
      SELECT kunci_jawaban_map FROM paket_soal
      WHERE ulangan_id = ? AND UPPER(nama_paket) = UPPER(?)
    `).get(ulanganId, packageName);

    if (pkg && pkg.kunci_jawaban_map) {
      try {
        return JSON.parse(pkg.kunci_jawaban_map);
      } catch (e) {
        return {};
      }
    }

    // Fallback jika belum di-generate ke paket_soal: generate on-the-fly dari tabel soal
    const questions = db.prepare(`
      SELECT nomor, kunci_pg FROM soal
      WHERE ulangan_id = ? AND jenis = 'pilihan_ganda'
      ORDER BY urutan ASC, nomor ASC
    `).all(ulanganId);

    const map = {};
    questions.forEach((q, idx) => {
      map[String(idx + 1)] = (q.kunci_pg || 'A').toUpperCase().trim();
    });
    return map;
  },

  // Ambil naskah soal lengkap per paket untuk dicetak
  getPrintableQuestionsByPackage(ulanganId, packageName = 'A') {
    const ulangan = db.prepare('SELECT * FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan');

    const pkg = db.prepare(`
      SELECT * FROM paket_soal
      WHERE ulangan_id = ? AND UPPER(nama_paket) = UPPER(?)
    `).get(ulanganId, packageName);

    let orderedPg = [];

    if (pkg && pkg.urutan_soal_ids) {
      const ids = JSON.parse(pkg.urutan_soal_ids);
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        const rawSoals = db.prepare(`SELECT * FROM soal WHERE id IN (${placeholders})`).all(...ids);
        const soalMap = new Map(rawSoals.map(s => [s.id, s]));
        orderedPg = ids.map((id, idx) => {
          const s = soalMap.get(id);
          return s ? { ...s, nomor_tampil: idx + 1 } : null;
        }).filter(Boolean);
      }
    } else {
      orderedPg = db.prepare(`
        SELECT *, ROW_NUMBER() OVER (ORDER BY urutan, nomor) as nomor_tampil
        FROM soal
        WHERE ulangan_id = ? AND jenis = 'pilihan_ganda'
        ORDER BY urutan, nomor
      `).all(ulanganId);
    }

    // Ambil juga soal esai/isian jika ulangan jenis campuran
    const essayQuestions = db.prepare(`
      SELECT * FROM soal
      WHERE ulangan_id = ? AND jenis IN ('isian', 'essay')
      ORDER BY urutan ASC, nomor ASC
    `).all(ulanganId);

    return {
      ulangan,
      paket: packageName.toUpperCase(),
      opsi_count: Number(ulangan.opsi_pg_count) || 4,
      soal_pg: orderedPg,
      soal_essay: essayQuestions
    };
  }
};

module.exports = packageService;
