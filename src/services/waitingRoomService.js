const db = require('../config/database');
const studentService = require('./studentService');

const MAX_DEFAULT_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_STUDENTS || '20', 10);

// Antrean memori untuk siswa yang sedang menunggu slot kosong
// Map: ticketId -> { ticketId, ulanganId, kodeUjian, nama, kelas, status, createdAt, lastPolledAt }
const waitingTickets = new Map();

const waitingRoomService = {
  // Ambil batas maksimal siswa bersamaan
  getMaxConcurrent() {
    return MAX_DEFAULT_CONCURRENT;
  },

  // Hitung jumlah siswa yang saat ini sedang aktif mengerjakan (status = 'mengerjakan')
  getActiveStudentCount(ulanganId) {
    if (!ulanganId) return 0;
    const row = db.prepare(`
      SELECT COUNT(*) as c 
      FROM pengerjaan 
      WHERE ulangan_id = ? AND status = 'mengerjakan'
    `).get(ulanganId);
    return row ? row.c : 0;
  },

  // Periksa apakah siswa boleh langsung masuk atau harus antre
  checkEntry(kodeUjian, nama, kelas, customMax = null) {
    const maxLimit = customMax || this.getMaxConcurrent();
    const cleanKode = (kodeUjian || '').trim().toUpperCase();
    const cleanNama = (nama || '').trim();
    const cleanKelas = (kelas || '').trim();

    // 1. Validasi awal kode ujian
    const val = studentService.validateExamCode(cleanKode);
    if (!val.valid) {
      return { allowed: false, inQueue: false, error: val.message };
    }

    const ulanganId = val.ulangan.id;

    // 2. Periksa apakah siswa sudah memiliki pengerjaan aktif atau submitted
    const existingPeserta = db.prepare(`
      SELECT id FROM peserta 
      WHERE ulangan_id = ? AND LOWER(nama) = LOWER(?) AND LOWER(kelas) = LOWER(?)
    `).get(ulanganId, cleanNama, cleanKelas);

    if (existingPeserta) {
      const existingPengerjaan = db.prepare(`
        SELECT status FROM pengerjaan 
        WHERE ulangan_id = ? AND peserta_id = ?
      `).get(ulanganId, existingPeserta.id);

      // Jika sudah submitted atau sudah ada di dalam (refresh / rejoin), izinkan langsung tanpa antre
      if (existingPengerjaan) {
        return { allowed: true, inQueue: false, ulanganId };
      }
    }

    // 3. Hitung siswa yang sedang aktif mengerjakan
    const activeCount = this.getActiveStudentCount(ulanganId);

    // 4. Jika kapasitas masih tersedia (< maxLimit)
    if (activeCount < maxLimit) {
      return { allowed: true, inQueue: false, ulanganId, activeCount, maxLimit };
    }

    // 5. Kapasitas penuh (>= maxLimit): Masukkan ke sistem antrean ruang tunggu
    // Cek apakah siswa ini sudah punya tiket aktif di memori
    for (const [tId, t] of waitingTickets.entries()) {
      if (
        t.ulanganId === ulanganId &&
        t.nama.toLowerCase() === cleanNama.toLowerCase() &&
        t.kelas.toLowerCase() === cleanKelas.toLowerCase()
      ) {
        const pos = this.getQueuePosition(tId, ulanganId);
        return {
          allowed: false,
          inQueue: true,
          ticketId: tId,
          position: pos.position,
          totalWaiting: pos.totalWaiting,
          activeCount,
          maxLimit,
          message: `Ruang ujian sedang penuh (${activeCount}/${maxLimit} siswa). Anda berada di antrean nomor #${pos.position}.`
        };
      }
    }

    // Terbitkan tiket baru
    const ticketId = 'tkt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const newTicket = {
      ticketId,
      ulanganId,
      kodeUjian: cleanKode,
      nama: cleanNama,
      kelas: cleanKelas,
      status: 'waiting', // 'waiting' | 'ready' | 'used'
      createdAt: Date.now(),
      lastPolledAt: Date.now()
    };

    waitingTickets.set(ticketId, newTicket);
    const pos = this.getQueuePosition(ticketId, ulanganId);

    return {
      allowed: false,
      inQueue: true,
      ticketId,
      position: pos.position,
      totalWaiting: pos.totalWaiting,
      activeCount,
      maxLimit,
      message: `Ruang ujian sedang penuh (${activeCount}/${maxLimit} siswa). Anda berada di antrean nomor #${pos.position}.`
    };
  },

  // Dapatkan posisi antrean dari tiket
  getQueuePosition(ticketId, ulanganId) {
    const list = [];
    for (const [id, t] of waitingTickets.entries()) {
      if (t.ulanganId === ulanganId && t.status !== 'used') {
        list.push(t);
      }
    }
    list.sort((a, b) => a.createdAt - b.createdAt);

    const index = list.findIndex(t => t.ticketId === ticketId);
    return {
      position: index >= 0 ? index + 1 : 1,
      totalWaiting: list.length
    };
  },

  // Periksa status tiket saat polling dari frontend
  getTicketStatus(ticketId, customMax = null) {
    const maxLimit = customMax || this.getMaxConcurrent();
    const ticket = waitingTickets.get(ticketId);
    if (!ticket) {
      return { valid: false, message: 'Tiket antrean tidak ditemukan atau sudah kadaluarsa' };
    }

    ticket.lastPolledAt = Date.now();

    // Jika sudah status 'ready'
    if (ticket.status === 'ready') {
      return {
        valid: true,
        status: 'ready',
        ticket
      };
    }

    // Cek apakah slot sekarang sudah terbuka
    const activeCount = this.getActiveStudentCount(ticket.ulanganId);
    if (activeCount < maxLimit) {
      // Ambil tiket antrean terdepan
      const list = [];
      for (const t of waitingTickets.values()) {
        if (t.ulanganId === ticket.ulanganId && t.status === 'waiting') {
          list.push(t);
        }
      }
      list.sort((a, b) => a.createdAt - b.createdAt);

      if (list.length > 0 && list[0].ticketId === ticketId) {
        ticket.status = 'ready';
        return {
          valid: true,
          status: 'ready',
          ticket
        };
      }
    }

    const pos = this.getQueuePosition(ticketId, ticket.ulanganId);
    return {
      valid: true,
      status: 'waiting',
      position: pos.position,
      totalWaiting: pos.totalWaiting,
      activeCount,
      maxLimit
    };
  },

  // Tandai tiket selesai dipakai
  consumeTicket(ticketId) {
    const ticket = waitingTickets.get(ticketId);
    if (ticket) {
      ticket.status = 'used';
      waitingTickets.delete(ticketId);
    }
  },

  // Lepaskan slot pengerjaan saat siswa selesai submit
  releaseSlot(ulanganId) {
    if (!ulanganId) return;

    // Cari tiket antrean terdepan untuk ulangan ini dan promosikan jadi ready
    const list = [];
    for (const t of waitingTickets.values()) {
      if (t.ulanganId === Number(ulanganId) && t.status === 'waiting') {
        list.push(t);
      }
    }
    list.sort((a, b) => a.createdAt - b.createdAt);

    if (list.length > 0) {
      list[0].status = 'ready';
    }
  },

  // Bersihkan tiket mati/kadaluarsa (tidak ada polling > 5 menit)
  cleanExpiredTickets() {
    const now = Date.now();
    for (const [id, t] of waitingTickets.entries()) {
      if (now - t.lastPolledAt > 5 * 60 * 1000) {
        waitingTickets.delete(id);
      }
    }
  },

  // Reset antrean (untuk keperluan testing)
  _reset() {
    waitingTickets.clear();
  }
};

module.exports = waitingRoomService;
