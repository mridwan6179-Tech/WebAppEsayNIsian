/**
 * pinService.js - Layanan PIN Sekali Pakai & Token Peserta Ujian
 * 
 * Fitur:
 * - Generate pool PIN unik 6-digit sekali pakai per ujian
 * - Siswa mengklaim PIN saat memasukkan nama & kelas (1 siswa = 1 PIN)
 * - Mencegah siswa lain atau perangkat lain memakai PIN atau identitas yang sama
 * - Guru dapat menambah token/PIN kapan saja secara live selama ujian berlangsung
 * - Guru dapat mereset perangkat/PIN jika siswa ganti HP atau mengalami kendala
 * - Opsional per ulangan (bisa diaktifkan/dinonaktifkan oleh guru)
 */

const db = require('../config/database');

// Generate PIN 6 digit numerik unik
function generatePin(length = 6) {
  const chars = '0123456789';
  let pin = '';
  for (let i = 0; i < length; i++) {
    pin += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pin;
}

// Generate device fingerprint dari IP + User-Agent
function makeDeviceId(req) {
  const ip = req?.ip || req?.headers?.['x-forwarded-for'] || 'unknown';
  const ua = req?.headers?.['user-agent'] || 'unknown';
  const raw = `${ip}|${ua}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `dev_${Math.abs(hash).toString(36)}`;
}

// Otorisasi guru selalu dibatasi pada pemilik ulangan yang tepat.
function isGuruAuthorized(guruId, ulanganGuruId) {
  if (!guruId) return true;
  return Number(ulanganGuruId) === Number(guruId);
}

const pinService = {

  /**
   * Cek apakah ulangan menggunakan sistem PIN sekali pakai
   */
  isUlanganPinActive(ulanganId) {
    const row = db.prepare('SELECT pin_aktif FROM ulangan WHERE id = ?').get(ulanganId);
    return row ? Number(row.pin_aktif) === 1 : false;
  },

  /**
   * Aktifkan atau nonaktifkan sistem PIN untuk ujian
   */
  setUlanganPinMode(ulanganId, guruId, aktif) {
    const ulangan = db.prepare('SELECT id, guru_id FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan');
    if (guruId && !isGuruAuthorized(guruId, ulangan.guru_id)) throw new Error('Akses ditolak: bukan ulangan milik Anda');

    const flag = aktif ? 1 : 0;
    if (flag === 0) {
      db.prepare('UPDATE ulangan SET pin_aktif = 0, token_ujian = NULL WHERE id = ?').run(ulanganId);
    } else {
      db.prepare('UPDATE ulangan SET pin_aktif = 1 WHERE id = ?').run(ulanganId);
    }
    if (typeof db.syncCloud === 'function') db.syncCloud(true);
    return { success: true, pin_aktif: flag };
  },

  /**
   * Generate pool PIN sekali pakai untuk ujian (misal 30 PIN di awal)
   */
  generatePoolPins(ulanganId, guruId, count = 10) {
    const ulangan = db.prepare('SELECT id, guru_id, pin_aktif, token_ujian FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan');
    if (guruId && !isGuruAuthorized(guruId, ulangan.guru_id)) throw new Error('Akses ditolak: bukan ulangan milik Anda');

    const jumlah = Math.max(1, Math.min(1000, Number(count) || 10));
    const generated = [];

    // Baca PIN yang sudah ada di database ke memory Set untuk pencarian instan O(1)
    const existingPins = new Set(
      db.prepare('SELECT pin FROM pin_sessions WHERE ulangan_id = ?').all(ulanganId).map(r => r.pin)
    );

    for (let i = 0; i < jumlah; i++) {
      let pin;
      let attempts = 0;
      do {
        pin = generatePin(6);
        attempts++;
      } while (existingPins.has(pin) && attempts < 100);

      existingPins.add(pin);
      generated.push(pin);
    }

    // Batch insert untuk performa super instan (terutama pada Turso LibSQL embedded replica)
    if (generated.length > 0) {
      const CHUNK_SIZE = 50;
      for (let i = 0; i < generated.length; i += CHUNK_SIZE) {
        const chunk = generated.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '(?, ?, 0, CURRENT_TIMESTAMP)').join(', ');
        const params = [];
        for (const p of chunk) {
          params.push(ulanganId, p);
        }
        db.prepare(`INSERT INTO pin_sessions (ulangan_id, pin, is_used, created_at) VALUES ${placeholders}`).run(...params);
      }
    }

    // Pertahankan batas token_ujian jika guru sudah mengonfigurasi batas kuota secara eksplisit
    const curr = db.prepare('SELECT token_ujian FROM ulangan WHERE id = ?').get(ulanganId);
    let finalQuota = curr?.token_ujian;
    if (curr && (curr.token_ujian === null || curr.token_ujian === undefined)) {
      const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM pin_sessions WHERE ulangan_id = ?').get(ulanganId);
      finalQuota = totalRow?.cnt || generated.length;
      db.prepare('UPDATE ulangan SET token_ujian = ? WHERE id = ?').run(finalQuota, ulanganId);
    }

    return {
      success: true,
      count: generated.length,
      pins: generated,
      total_token: finalQuota,
      message: `${generated.length} PIN sekali pakai berhasil dibuat`
    };
  },

  /**
   * Sinkronkan kuota token ujian: jika jumlah PIN saat ini kurang dari targetQuota,
   * buatkan selisihnya otomatis.
   */
  syncTokenPool(ulanganId, guruId, targetQuota) {
    const ulangan = db.prepare('SELECT id, guru_id, pin_aktif, token_ujian FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan');
    if (guruId && !isGuruAuthorized(guruId, ulangan.guru_id)) throw new Error('Akses ditolak: bukan ulangan milik Anda');

    const target = (targetQuota !== null && targetQuota !== undefined && targetQuota !== '') ? Math.max(0, Math.min(1000, Number(targetQuota))) : null;
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM pin_sessions WHERE ulangan_id = ?').get(ulanganId);
    const currentCount = Number(countRow?.cnt || 0);

    if (target && target > currentCount) {
      const deficit = target - currentCount;
      const res = this.generatePoolPins(ulanganId, guruId, deficit);
      db.prepare('UPDATE ulangan SET token_ujian = ? WHERE id = ?').run(target, ulanganId);
      return res;
    } else {
      db.prepare('UPDATE ulangan SET token_ujian = ? WHERE id = ?').run(target, ulanganId);
      return {
        success: true,
        count: 0,
        total_token: target || currentCount,
        message: 'Kuota token berhasil disesuaikan'
      };
    }
  },

  /**
   * Tambah token PIN saat ujian sedang berlangsung (live)
   */
  addTokenUjian(ulanganId, guruId, tambah = 5) {
    const delta = Math.max(1, Math.min(500, Number(tambah) || 5));
    const result = this.generatePoolPins(ulanganId, guruId, delta);
    // Tambah kuota token_ujian jika ulangan memiliki batas kuota
    const u = db.prepare('SELECT token_ujian FROM ulangan WHERE id = ?').get(ulanganId);
    if (u && u.token_ujian !== null && u.token_ujian !== undefined) {
      db.prepare('UPDATE ulangan SET token_ujian = token_ujian + ? WHERE id = ?').run(delta, ulanganId);
    }
    const summary = this.getAllPins(ulanganId, guruId);
    return {
      success: true,
      ditambah: delta,
      total_token: summary.total,
      tersedia: summary.available,
      terpakai: summary.used,
      new_pins: result.pins,
      message: `${delta} token PIN baru berhasil ditambahkan`
    };
  },

  /**
   * Set kuota token ujian (batas maksimal)
   */
  setTokenUjian(ulanganId, guruId, jumlahToken) {
    const ulangan = db.prepare('SELECT id, guru_id FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan');
    if (guruId && !isGuruAuthorized(guruId, ulangan.guru_id)) throw new Error('Akses ditolak: bukan ulangan milik Anda');

    const token = Math.max(0, Number(jumlahToken) || 0);
    db.prepare('UPDATE ulangan SET token_ujian = ? WHERE id = ?').run(token || null, ulanganId);
    return { success: true, token_ujian: token || null };
  },

  /**
   * Cek ketersediaan kuota token ujian
   */
  checkTokenAvailable(ulanganId, pesertaId = null) {
    const ulangan = db.prepare('SELECT token_ujian, pin_aktif FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) return { allowed: true };

    // JIKA SISTEM PIN / TOKEN SUDAH DINONAKTIFKAN, JANGAN DIBATASI APAPUN!
    if (Number(ulangan.pin_aktif) !== 1) return { allowed: true };

    const maxToken = Number(ulangan.token_ujian) || 0;
    if (!maxToken) return { allowed: true };

    // Cek apakah siswa ini sudah pernah terdaftar mengerjakan ujian ini (reconnect diperbolehkan)
    if (pesertaId) {
      const existing = db.prepare('SELECT id FROM pengerjaan WHERE ulangan_id = ? AND peserta_id = ?').get(ulanganId, pesertaId);
      if (existing) return { allowed: true, reason: 'returning' };
    }

    // Hitung peserta unik yang sudah masuk
    const countRow = db.prepare('SELECT COUNT(DISTINCT peserta_id) as cnt FROM pengerjaan WHERE ulangan_id = ?').get(ulanganId);
    const used = Number(countRow?.cnt || 0);

    if (used >= maxToken) {
      return {
        allowed: false,
        used,
        max: maxToken,
        message: `Batas kuota token peserta sudah penuh (${used}/${maxToken} siswa). Hubungi guru pengawas untuk menambah token.`
      };
    }

    return { allowed: true, used, max: maxToken };
  },

  /**
   * Validasi PIN saat siswa masuk ujian
   */
  validatePin(ulanganId, nama, kelas, pin, deviceId = null) {
    if (!pin || typeof pin !== 'string' || pin.trim().length === 0) {
      return { valid: false, message: 'PIN ujian wajib diisi' };
    }

    const cleanPin = pin.trim();
    const cleanNama = (nama || '').trim();
    const cleanKelas = (kelas || '').trim();

    if (!cleanNama || !cleanKelas) {
      return { valid: false, message: 'Nama dan kelas wajib diisi sebelum memasukkan PIN' };
    }

    // Cari baris PIN di database untuk ulangan ini
    const session = db.prepare('SELECT * FROM pin_sessions WHERE ulangan_id = ? AND pin = ?').get(ulanganId, cleanPin);

    if (!session) {
      return {
        valid: false,
        message: 'PIN tidak terdaftar untuk ujian ini. Pastikan PIN yang dimasukkan sudah benar sesuai yang diberikan guru.'
      };
    }

    // KASUS 1: PIN masih belum digunakan (Fresh dari pool)
    if (Number(session.is_used) === 0) {
      // Cek apakah siswa ini sudah pernah mengklaim PIN lain di ujian ini
      const alreadyClaimed = db.prepare(`
        SELECT pin FROM pin_sessions 
        WHERE ulangan_id = ? AND is_used = 1 
          AND LOWER(TRIM(nama_siswa)) = LOWER(?) 
          AND LOWER(TRIM(kelas_siswa)) = LOWER(?)
      `).get(ulanganId, cleanNama, cleanKelas);

      if (alreadyClaimed) {
        return {
          valid: false,
          alreadyUsed: true,
          message: `Anda sudah pernah terdaftar dengan PIN (${alreadyClaimed.pin}). Harap gunakan PIN tersebut untuk masuk kembali.`
        };
      }

      // Cek batas kuota token ujian sebelum klaim
      const tokenCheck = this.checkTokenAvailable(ulanganId, null);
      if (!tokenCheck.allowed) {
        return { valid: false, message: tokenCheck.message };
      }

      // Buat atau dapatkan peserta ID
      let peserta = db.prepare(
        'SELECT id FROM peserta WHERE ulangan_id = ? AND LOWER(TRIM(nama)) = LOWER(?) AND LOWER(TRIM(kelas)) = LOWER(?)'
      ).get(ulanganId, cleanNama, cleanKelas);

      let pesertaId = peserta?.id || null;
      if (!pesertaId) {
        const info = db.prepare('INSERT INTO peserta (ulangan_id, nama, kelas) VALUES (?, ?, ?)').run(ulanganId, cleanNama, cleanKelas);
        pesertaId = info.lastInsertRowid;
      }

      // Klaim PIN untuk siswa ini
      db.prepare(`
        UPDATE pin_sessions
        SET is_used = 1,
            peserta_id = ?,
            nama_siswa = ?,
            kelas_siswa = ?,
            device_id = ?,
            used_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(pesertaId, cleanNama, cleanKelas, deviceId || null, session.id);

      return {
        valid: true,
        pin: session.pin,
        peserta_id: pesertaId,
        reconnect: false,
        message: 'PIN berhasil diverifikasi. Selamat mengerjakan!'
      };
    }

    // KASUS 2: PIN sudah terpakai
    const isSameStudent = (
      session.nama_siswa &&
      session.kelas_siswa &&
      session.nama_siswa.trim().toLowerCase() === cleanNama.toLowerCase() &&
      session.kelas_siswa.trim().toLowerCase() === cleanKelas.toLowerCase()
    );

    if (isSameStudent) {
      // Siswa yang sama masuk kembali (reconnect / refresh)
      if (deviceId) {
        db.prepare('UPDATE pin_sessions SET device_id = COALESCE(device_id, ?) WHERE id = ?').run(deviceId, session.id);
      }
      return {
        valid: true,
        pin: session.pin,
        peserta_id: session.peserta_id,
        reconnect: true,
        message: 'Selamat datang kembali, sesi ujian Anda dilanjutkan.'
      };
    }

    // Jika orang lain yang mencoba memakai PIN yang sudah digunakan
    return {
      valid: false,
      alreadyUsed: true,
      message: `PIN ini sudah digunakan oleh ${session.nama_siswa || 'siswa lain'} (${session.kelas_siswa || ''}). Setiap siswa harus menggunakan PIN yang berbeda!`
    };
  },

  /**
   * Ambil semua daftar PIN peserta pada suatu ulangan
   */
  getAllPins(ulanganId, guruId = null) {
    const ulangan = db.prepare('SELECT id, guru_id, pin_aktif, token_ujian, judul, mata_pelajaran FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan');
    if (guruId && !isGuruAuthorized(guruId, ulangan.guru_id)) throw new Error('Akses ditolak: bukan ulangan milik Anda');

    const rows = db.prepare(`
      SELECT 
        ps.id,
        ps.ulangan_id,
        ps.peserta_id,
        ps.pin,
        ps.is_used,
        ps.nama_siswa,
        ps.kelas_siswa,
        ps.device_id,
        ps.created_at,
        ps.used_at,
        p.nama as nama_peserta,
        p.kelas as kelas_peserta,
        peng.status as status_pengerjaan,
        peng.nilai_final
      FROM pin_sessions ps
      LEFT JOIN peserta p ON ps.peserta_id = p.id
      LEFT JOIN pengerjaan peng ON ps.peserta_id = peng.peserta_id AND ps.ulangan_id = peng.ulangan_id
      WHERE ps.ulangan_id = ?
      ORDER BY ps.is_used ASC, ps.created_at DESC, ps.id ASC
    `).all(ulanganId);

    const usedCount = rows.filter(r => Number(r.is_used) === 1).length;
    const availableCount = rows.length - usedCount;

    return {
      success: true,
      ulangan: {
        id: ulangan.id,
        judul: ulangan.judul,
        mata_pelajaran: ulangan.mata_pelajaran,
        pin_aktif: Number(ulangan.pin_aktif) === 1,
        token_ujian: ulangan.token_ujian || null
      },
      total: rows.length,
      used: usedCount,
      available: availableCount,
      data: rows.map(r => ({
        id: r.id,
        pin: r.pin,
        is_used: Number(r.is_used) === 1,
        nama: r.nama_siswa || r.nama_peserta || '-',
        kelas: r.kelas_siswa || r.kelas_peserta || '-',
        device_id: r.device_id || '-',
        created_at: r.created_at,
        used_at: r.used_at,
        status_pengerjaan: r.status_pengerjaan || (Number(r.is_used) === 1 ? 'mengerjakan' : 'belum_mulai'),
        nilai_final: r.nilai_final
      }))
    };
  },

  /**
   * Reset PIN tertentu (agar dapat digunakan kembali oleh siswa yang sama di HP baru, atau dilepas ke pool)
   */
  resetPin(ulanganId, pinId, guruId = null, mode = 'unclaim') {
    const ulangan = db.prepare('SELECT id, guru_id FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan');
    if (guruId && !isGuruAuthorized(guruId, ulangan.guru_id)) throw new Error('Akses ditolak: bukan ulangan milik Anda');

    if (mode === 'device_only') {
      // Hanya reset device id (izinkan siswa ganti HP dengan PIN yang sama)
      db.prepare('UPDATE pin_sessions SET device_id = NULL WHERE id = ? AND ulangan_id = ?').run(pinId, ulanganId);
      return { success: true, message: 'Kunci perangkat berhasil di-reset. Siswa dapat masuk dari perangkat baru.' };
    }

    // Reset penuh ke status belum digunakan
    db.prepare(`
      UPDATE pin_sessions 
      SET is_used = 0, nama_siswa = NULL, kelas_siswa = NULL, peserta_id = NULL, device_id = NULL, used_at = NULL
      WHERE id = ? AND ulangan_id = ?
    `).run(pinId, ulanganId);

    return { success: true, message: 'PIN berhasil di-reset dan siap digunakan kembali.' };
  },

  /**
   * Hapus butir PIN yang belum digunakan
   */
  deletePin(ulanganId, pinId, guruId = null) {
    const ulangan = db.prepare('SELECT id, guru_id FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan');
    if (guruId && !isGuruAuthorized(guruId, ulangan.guru_id)) throw new Error('Akses ditolak: bukan ulangan milik Anda');

    const session = db.prepare('SELECT is_used FROM pin_sessions WHERE id = ? AND ulangan_id = ?').get(pinId, ulanganId);
    if (!session) throw new Error('PIN tidak ditemukan');
    if (Number(session.is_used) === 1) {
      throw new Error('PIN yang sudah digunakan oleh siswa tidak dapat dihapus. Silakan reset terlebih dahulu.');
    }

    db.prepare('DELETE FROM pin_sessions WHERE id = ? AND ulangan_id = ?').run(pinId, ulanganId);

    // Update count token_ujian
    const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM pin_sessions WHERE ulangan_id = ?').get(ulanganId);
    db.prepare('UPDATE ulangan SET token_ujian = ? WHERE id = ?').run(totalRow?.cnt || null, ulanganId);

    return { success: true, message: 'PIN berhasil dihapus' };
  },

  /**
   * Generate format sebaran teks PIN untuk WhatsApp / Cetak
   */
  formatBroadcastText(ulanganId, guruId) {
    const summary = this.getAllPins(ulanganId, guruId);
    const u = summary.ulangan;

    let text = `*DAFTAR PIN SEKALI PAKAI UJIAN*\n`;
    text += `Mata Pelajaran: *${u.mata_pelajaran}*\n`;
    text += `Judul Ujian: *${u.judul}*\n`;
    text += `Total PIN: *${summary.total}* (Tersedia: ${summary.available}, Terpakai: ${summary.used})\n\n`;
    text += `_Petunjuk: Setiap siswa hanya boleh menggunakan 1 PIN unik berikut saat masuk. PIN otomatis hangus setelah dipakai._\n\n`;

    summary.data.forEach((p, idx) => {
      const status = p.is_used ? `[TERPAKAI - ${p.nama} (${p.kelas})]` : `[TERSEDIA]`;
      text += `${idx + 1}. *${p.pin}* ${status}\n`;
    });

    return { success: true, text };
  },

  makeDeviceId
};

module.exports = pinService;
