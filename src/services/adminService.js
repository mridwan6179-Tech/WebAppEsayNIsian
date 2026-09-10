const db = require('../config/database');
const geminiService = require('./geminiService');

const adminService = {
  // Ambil seluruh daftar guru beserta jumlah ulangan yang dibuat
  getAllGuru() {
    const rows = db.prepare(`
      SELECT 
        g.id,
        g.email,
        g.nama,
        g.no_wa,
        g.created_at,
        COUNT(DISTINCT u.id) as total_ulangan,
        COUNT(DISTINCT p.id) as total_peserta
      FROM guru g
      LEFT JOIN ulangan u ON g.id = u.guru_id
      LEFT JOIN pengerjaan p ON u.id = p.ulangan_id
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `).all();

    return rows;
  },

  // Tambah guru baru
  createGuru(nama, email, password, no_wa = null) {
    const cleanNama = (nama || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanPassword = (password || '').trim();
    const cleanWa = no_wa ? String(no_wa).trim() : null;

    if (!cleanNama || !cleanEmail || !cleanPassword) {
      throw new Error('Nama, email, dan password wajib diisi');
    }

    const existing = db.prepare('SELECT id FROM guru WHERE LOWER(email) = LOWER(?)').get(cleanEmail);
    if (existing) {
      throw new Error('Email guru sudah terdaftar dalam sistem');
    }

    const info = db.prepare(`
      INSERT INTO guru (nama, email, password, no_wa)
      VALUES (?, ?, ?, ?)
    `).run(cleanNama, cleanEmail, cleanPassword, cleanWa);

    return {
      id: info.lastInsertRowid,
      nama: cleanNama,
      email: cleanEmail,
      no_wa: cleanWa
    };
  },

  // Update profil guru / reset password
  updateGuru(guruId, data) {
    const existing = db.prepare('SELECT id, nama, email, no_wa FROM guru WHERE id = ?').get(guruId);
    if (!existing) {
      throw new Error('Guru tidak ditemukan');
    }

    const updates = [];
    const params = [];

    if (data.nama !== undefined && data.nama.trim() !== '') {
      updates.push('nama = ?');
      params.push(data.nama.trim());
    }

    if (data.no_wa !== undefined) {
      updates.push('no_wa = ?');
      params.push(data.no_wa ? String(data.no_wa).trim() : null);
    }

    if (data.email !== undefined && data.email.trim() !== '') {
      const newEmail = data.email.trim().toLowerCase();
      const duplicate = db.prepare('SELECT id FROM guru WHERE LOWER(email) = LOWER(?) AND id != ?').get(newEmail, guruId);
      if (duplicate) {
        throw new Error('Email sudah digunakan oleh guru lain');
      }
      updates.push('email = ?');
      params.push(newEmail);
    }

    if (data.password !== undefined && data.password.trim() !== '') {
      updates.push('password = ?');
      params.push(data.password.trim());
    }

    if (updates.length > 0) {
      params.push(guruId);
      db.prepare(`
        UPDATE guru 
        SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(...params);
    }

    return db.prepare('SELECT id, nama, email, created_at FROM guru WHERE id = ?').get(guruId);
  },

  // Hapus akun guru beserta seluruh ulangan, bank soal, dan data terkait (Cascade Delete)
  deleteGuru(guruId) {
    const existing = db.prepare('SELECT id, nama FROM guru WHERE id = ?').get(guruId);
    if (!existing) {
      throw new Error('Guru tidak ditemukan');
    }

    // Hitung sisa guru agar tidak 0
    const count = db.prepare('SELECT COUNT(*) as c FROM guru').get().c;
    if (count <= 1) {
      throw new Error('Tidak dapat menghapus satu-satunya akun guru. Buat akun guru lain terlebih dahulu.');
    }

    // Hapus seluruh data turunan (ulangan, soal, pengerjaan, jawaban, review, kelas)
    const deleteTx = db.transaction(() => {
      // 1. Hapus review_guru yang dibuat oleh guru ini
      db.prepare('DELETE FROM review_guru WHERE guru_id = ?').run(guruId);

      // 2. Ambil seluruh ulangan milik guru ini
      const ulangans = db.prepare('SELECT id FROM ulangan WHERE guru_id = ?').all(guruId);
      for (const u of ulangans) {
        // Ambil seluruh pengerjaan dari ulangan ini
        const pengerjaans = db.prepare('SELECT id FROM pengerjaan WHERE ulangan_id = ?').all(u.id);
        for (const p of pengerjaans) {
          const jawabans = db.prepare('SELECT id FROM jawaban WHERE pengerjaan_id = ?').all(p.id);
          for (const j of jawabans) {
            db.prepare('DELETE FROM antrean_review WHERE jawaban_id = ?').run(j.id);
            db.prepare('DELETE FROM review_guru WHERE jawaban_id = ?').run(j.id);
          }
          db.prepare('DELETE FROM jawaban WHERE pengerjaan_id = ?').run(p.id);
        }
        db.prepare('DELETE FROM pengerjaan WHERE ulangan_id = ?').run(u.id);
        db.prepare('DELETE FROM soal WHERE ulangan_id = ?').run(u.id);
        db.prepare('DELETE FROM peserta WHERE ulangan_id = ?').run(u.id);
        db.prepare('DELETE FROM ulangan_kelas WHERE ulangan_id = ?').run(u.id);
        db.prepare('DELETE FROM ulangan WHERE id = ?').run(u.id);
      }

      // 3. Hapus kelas yang dibuat guru
      db.prepare('DELETE FROM kelas WHERE guru_id = ?').run(guruId);

      // 4. Hapus guru
      db.prepare('DELETE FROM guru WHERE id = ?').run(guruId);
    });

    deleteTx();
    return { success: true, message: `Akun guru ${existing.nama} beserta seluruh ulangan dan soalnya berhasil dihapus` };
  },

  // Ambil Semua API Key Gemini (dengan Masking)
  getAllAiKeys() {
    const keys = db.prepare(`
      SELECT id, label, api_key, is_active, priority, status, last_tested_at, last_error, created_at
      FROM gemini_api_keys
      ORDER BY priority ASC, id ASC
    `).all();

    return keys.map(k => {
      const raw = k.api_key || '';
      let masked = '********';
      if (raw.length > 10) {
        masked = `${raw.substring(0, 6)}...${raw.substring(raw.length - 4)}`;
      }
      return {
        ...k,
        masked_key: masked,
        api_key: undefined // Jangan ekspos raw key ke antarmuka
      };
    });
  },

  // Tambah API Key Baru
  addAiKey(label, apiKey, priority = 1) {
    const cleanKey = (apiKey || '').trim();
    if (!cleanKey) {
      throw new Error('API Key tidak boleh kosong');
    }
    const cleanLabel = (label || '').trim() || 'Kunci Cadangan';

    const info = db.prepare(`
      INSERT INTO gemini_api_keys (label, api_key, is_active, priority, status)
      VALUES (?, ?, 1, ?, 'ready')
    `).run(cleanLabel, cleanKey, Number(priority) || 1);

    // Sinkronkan ke app_settings jika ini satu-satunya kunci
    const count = db.prepare('SELECT COUNT(*) as c FROM gemini_api_keys WHERE is_active = 1').get().c;
    if (count === 1) {
      this.updateAiConfig(cleanKey);
    }

    geminiService.clearModelCooldowns();

    let masked = '********';
    if (cleanKey.length > 10) {
      masked = `${cleanKey.substring(0, 6)}...${cleanKey.substring(cleanKey.length - 4)}`;
    }

    return {
      success: true,
      id: info.lastInsertRowid,
      label: cleanLabel,
      priority: Number(priority) || 1,
      masked_key: masked,
      is_active: 1,
      message: 'API Key berhasil ditambahkan'
    };
  },

  // Perbarui Pengaturan API Key (Label, Status Aktif, Prioritas, atau Kunci Baru)
  updateAiKey(id, data = {}) {
    const existing = db.prepare('SELECT * FROM gemini_api_keys WHERE id = ?').get(id);
    if (!existing) {
      throw new Error('API Key tidak ditemukan');
    }

    const updates = [];
    const params = [];

    if (data.label !== undefined && data.label.trim() !== '') {
      updates.push('label = ?');
      params.push(data.label.trim());
    }
    if (data.is_active !== undefined) {
      updates.push('is_active = ?');
      params.push(data.is_active ? 1 : 0);
    }
    if (data.priority !== undefined) {
      updates.push('priority = ?');
      params.push(Number(data.priority) || 1);
    }
    if (data.api_key !== undefined && data.api_key.trim() !== '') {
      updates.push('api_key = ?');
      params.push(data.api_key.trim());
    }

    if (updates.length > 0) {
      params.push(id);
      db.prepare(`UPDATE gemini_api_keys SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    geminiService.clearModelCooldowns();
    return { success: true, message: 'API Key berhasil diperbarui' };
  },

  // Hapus API Key
  deleteAiKey(id) {
    const existing = db.prepare('SELECT * FROM gemini_api_keys WHERE id = ?').get(id);
    if (!existing) {
      throw new Error('API Key tidak ditemukan');
    }

    db.prepare('DELETE FROM gemini_api_keys WHERE id = ?').run(id);
    geminiService.clearModelCooldowns();
    return { success: true, message: 'API Key berhasil dihapus' };
  },

  // Uji Kunci Tertentu secara Spesifik
  async testSpecificKey(keyId) {
    const keyRecord = db.prepare('SELECT * FROM gemini_api_keys WHERE id = ?').get(keyId);
    if (!keyRecord) {
      throw new Error('API Key tidak ditemukan');
    }

    try {
      const candidates = await geminiService.getAvailableCandidateModels(keyRecord.api_key);
      const topModel = candidates[0] || 'gemini-2.0-flash';
      db.prepare(`
        UPDATE gemini_api_keys 
        SET status = 'ready', last_tested_at = CURRENT_TIMESTAMP, last_error = NULL 
        WHERE id = ?
      `).run(keyId);

      return {
        success: true,
        model_terdeteksi: topModel,
        kandidat: candidates.slice(0, 5),
        message: `Koneksi berhasil! Model aktif: ${topModel}`
      };
    } catch (err) {
      db.prepare(`
        UPDATE gemini_api_keys 
        SET status = 'error', last_tested_at = CURRENT_TIMESTAMP, last_error = ? 
        WHERE id = ?
      `).run(err.message, keyId);
      throw new Error(`Koneksi gagal: ${err.message}`);
    }
  },

  // Ambil Konfigurasi AI Aktif
  getAiConfig() {
    const activeKeys = this.getAllAiKeys();
    const setting = db.prepare("SELECT value, updated_at FROM app_settings WHERE key = 'gemini_api_key'").get();
    const rawKey = setting?.value || process.env.GEMINI_API_KEY || '';

    // Maskir API key demi keamanan
    let masked = 'Belum dikonfigurasi';
    if (rawKey && rawKey !== 'YOUR_GEMINI_API_KEY') {
      if (rawKey.length > 10) {
        masked = `${rawKey.substring(0, 6)}...${rawKey.substring(rawKey.length - 4)}`;
      } else {
        masked = '********';
      }
    }

    return {
      has_key: Boolean(rawKey && rawKey !== 'YOUR_GEMINI_API_KEY'),
      masked_key: masked,
      total_keys: activeKeys.length,
      active_keys: activeKeys.filter(k => k.is_active === 1).length,
      updated_at: setting?.updated_at || null
    };
  },

  // Perbarui Google Gemini API Key
  updateAiConfig(newApiKey) {
    const cleanKey = (newApiKey || '').trim();
    if (!cleanKey) {
      throw new Error('API Key tidak boleh kosong');
    }

    // Simpan ke database app_settings
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('gemini_api_key', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(cleanKey);

    // Pastikan juga tersimpan di gemini_api_keys
    const existing = db.prepare("SELECT id FROM gemini_api_keys WHERE label = 'Kunci Utama (Default)'").get();
    if (existing) {
      db.prepare("UPDATE gemini_api_keys SET api_key = ?, is_active = 1 WHERE id = ?").run(cleanKey, existing.id);
    } else {
      db.prepare("INSERT INTO gemini_api_keys (label, api_key, is_active, priority) VALUES ('Kunci Utama (Default)', ?, 1, 1)").run(cleanKey);
    }

    // Update runtime env
    process.env.GEMINI_API_KEY = cleanKey;

    // Reset cooldown dan cache model agar langsung menggunakan key baru
    geminiService.clearModelCooldowns();

    return {
      success: true,
      message: 'Gemini API Key berhasil diperbarui dan aktif seketika'
    };
  },

  // Uji koneksi API Key secara live
  async testAiConnection(apiKey = null) {
    const key = apiKey || db.prepare("SELECT value FROM app_settings WHERE key = 'gemini_api_key'").get()?.value || process.env.GEMINI_API_KEY;
    if (!key || key === 'YOUR_GEMINI_API_KEY') {
      throw new Error('API Key belum diisi atau tidak valid');
    }

    try {
      const candidates = await geminiService.getAvailableCandidateModels(key);
      const topModel = candidates[0] || 'gemini-2.0-flash';
      return {
        success: true,
        model_terdeteksi: topModel,
        total_model_tersedia: candidates.length,
        kandidat: candidates.slice(0, 5),
        message: `Koneksi berhasil! Model aktif: ${topModel}`
      };
    } catch (err) {
      throw new Error(`Gagal terhubung ke Gemini API: ${err.message}`);
    }
  }
};

module.exports = adminService;
