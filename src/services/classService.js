const db = require('../config/database');

const classService = {
  createKelas(guruId, namaKelas) {
    if (!namaKelas || !namaKelas.trim()) {
      throw new Error('Nama kelas wajib diisi');
    }
    const cleanNama = namaKelas.trim();

    // Cek duplikasi nama kelas untuk guru ini
    const existing = db.prepare('SELECT id FROM kelas WHERE guru_id = ? AND LOWER(nama_kelas) = LOWER(?)').get(guruId, cleanNama);
    if (existing) {
      throw new Error('Kelas dengan nama ini sudah ada');
    }

    const stmt = db.prepare('INSERT INTO kelas (guru_id, nama_kelas) VALUES (?, ?)');
    const info = stmt.run(guruId, cleanNama);
    return db.prepare('SELECT * FROM kelas WHERE id = ?').get(info.lastInsertRowid);
  },

  getKelasByGuru(guruId) {
    return db.prepare(`
      SELECT k.*, 
        (SELECT COUNT(DISTINCT uk.ulangan_id) FROM ulangan_kelas uk WHERE uk.kelas_id = k.id) as total_ulangan
      FROM kelas k 
      WHERE k.guru_id = ? 
      ORDER BY k.nama_kelas ASC
    `).all(guruId);
  },

  deleteKelas(kelasId, guruId) {
    const existing = db.prepare('SELECT id FROM kelas WHERE id = ? AND guru_id = ?').get(kelasId, guruId);
    if (!existing) {
      throw new Error('Kelas tidak ditemukan');
    }
    db.prepare('DELETE FROM kelas WHERE id = ?').run(kelasId);
    return true;
  },

  assignKelasToUlangan(ulanganId, kelasIds) {
    const deleteOld = db.prepare('DELETE FROM ulangan_kelas WHERE ulangan_id = ?');
    const insertNew = db.prepare('INSERT OR IGNORE INTO ulangan_kelas (ulangan_id, kelas_id) VALUES (?, ?)');

    db.transaction(() => {
      deleteOld.run(ulanganId);
      if (Array.isArray(kelasIds)) {
        for (const kid of kelasIds) {
          if (kid) insertNew.run(ulanganId, Number(kid));
        }
      }
    })();

    return this.getKelasByUlangan(ulanganId);
  },

  getKelasByUlangan(ulanganId) {
    return db.prepare(`
      SELECT k.id, k.nama_kelas
      FROM ulangan_kelas uk
      JOIN kelas k ON uk.kelas_id = k.id
      WHERE uk.ulangan_id = ?
      ORDER BY k.nama_kelas ASC
    `).all(ulanganId);
  }
};

module.exports = classService;
