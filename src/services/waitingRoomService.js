const db = require('../config/database');
const studentService = require('./studentService');

// Kapasitas siswa yang bisa mengerjakan di dalam ruang ujian secara bersamaan (Bisa banyak / 200 siswa)
const MAX_INSIDE_EXAM = parseInt(process.env.MAX_INSIDE_EXAM || '200', 10);

// Batas lonjakan serentak (Burst) pada Gerbang Masuk & Gerbang Submit (Maks 20 serentak)
const MAX_BURST_ENTRY = parseInt(process.env.MAX_BURST_ENTRY || '20', 10);
const MAX_BURST_SUBMIT = parseInt(process.env.MAX_BURST_SUBMIT || '20', 10);

// Antrean ruang tunggu masuk (Entry Gate Queue)
const waitingTickets = new Map();
let activeEnteringCount = 0;

// Antrean pengumpulan jawaban serentak (Submit Gate Mutex Queue)
let activeSubmits = 0;
const submitQueue = [];

function processNextSubmit() {
  if (activeSubmits >= MAX_BURST_SUBMIT || submitQueue.length === 0) {
    return;
  }
  const task = submitQueue.shift();
  activeSubmits++;

  Promise.resolve()
    .then(() => task.fn())
    .then(result => {
      task.resolve(result);
    })
    .catch(err => {
      task.reject(err);
    })
    .finally(() => {
      activeSubmits = Math.max(0, activeSubmits - 1);
      processNextSubmit();
    });
}

const waitingRoomService = {
  // Ambil kapasitas maksimal di dalam pengerjaan
  getMaxInside() {
    return MAX_INSIDE_EXAM;
  },

  // Ambil batas serentak burst (Masuk & Submit)
  getMaxBurst() {
    return MAX_BURST_ENTRY;
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

  // GERBANG 1: Masuk Ujian (Entry Gate)
  // Memastikan siswa yang sedang mengerjakan di dalam bisa mencapai kapasitas penuh (200 siswa),
  // namun jika ada lonjakan serentak > 20 siswa dalam detik yang sama, siswa diantrekan beberapa detik secara halus.
  checkEntry(kodeUjian, nama, kelas, customMax = null) {
    const maxCapacity = customMax || this.getMaxInside();
    const burstLimit = this.getMaxBurst();
    const cleanKode = (kodeUjian || '').trim().toUpperCase();
    const cleanNama = (nama || '').trim();
    const cleanKelas = (kelas || '').trim();

    // 1. Validasi awal kode ujian
    const val = studentService.validateExamCode(cleanKode);
    if (!val.valid) {
      return { allowed: false, inQueue: false, error: val.message };
    }

    const ulanganId = val.ulangan.id;

    // 2. Periksa apakah siswa sudah memiliki pengerjaan aktif atau submitted (Rejoin / Refresh)
    const existingPeserta = db.prepare(`
      SELECT id FROM peserta 
      WHERE ulangan_id = ? AND LOWER(nama) = LOWER(?) AND LOWER(kelas) = LOWER(?)
    `).get(ulanganId, cleanNama, cleanKelas);

    if (existingPeserta) {
      const existingPengerjaan = db.prepare(`
        SELECT status FROM pengerjaan 
        WHERE ulangan_id = ? AND peserta_id = ?
      `).get(ulanganId, existingPeserta.id);

      // Siswa yang sudah di dalam boleh langsung masuk tanpa antre
      if (existingPengerjaan) {
        return { allowed: true, inQueue: false, ulanganId };
      }
    }

    // 3. Hitung siswa yang sedang aktif mengerjakan di dalam ruang ujian
    const activeCount = this.getActiveStudentCount(ulanganId);

    // Jika ruang ujian sudah penuh total (misal 200 siswa)
    if (activeCount >= maxCapacity) {
      return this.createOrGetWaitingTicket(ulanganId, cleanKode, cleanNama, cleanKelas, activeCount, maxCapacity, 'Ruang ujian sedang penuh');
    }

    // 4. Cek apakah terjadi lonjakan serentak masuk (Burst Entry Gate > 20)
    // Jika antrean tiket sedang ada siswa yang mengantre, siswa baru harus antre di belakangnya
    const waitingForThisExam = this.getWaitingListForExam(ulanganId);
    if (waitingForThisExam.length > 0 || activeEnteringCount >= burstLimit) {
      return this.createOrGetWaitingTicket(ulanganId, cleanKode, cleanNama, cleanKelas, activeCount, maxCapacity, 'Sistem sedang mengatur antrean gerbang masuk');
    }

    // Lolos masuk ke lembar ujian
    activeEnteringCount++;
    setTimeout(() => {
      if (activeEnteringCount > 0) activeEnteringCount--;
    }, 1500);

    return { allowed: true, inQueue: false, ulanganId, activeCount, maxLimit: maxCapacity };
  },

  getWaitingListForExam(ulanganId) {
    const list = [];
    for (const t of waitingTickets.values()) {
      if (t.ulanganId === ulanganId && t.status !== 'used') {
        list.push(t);
      }
    }
    list.sort((a, b) => a.createdAt - b.createdAt);
    return list;
  },

  createOrGetWaitingTicket(ulanganId, cleanKode, cleanNama, cleanKelas, activeCount, maxCapacity, reason) {
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
          maxLimit: maxCapacity,
          message: `${reason} (${activeCount}/${maxCapacity} siswa). Anda berada di antrean nomor #${pos.position}.`
        };
      }
    }

    const ticketId = 'tkt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const newTicket = {
      ticketId,
      ulanganId,
      kodeUjian: cleanKode,
      nama: cleanNama,
      kelas: cleanKelas,
      status: 'waiting',
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
      maxLimit: maxCapacity,
      message: `${reason} (${activeCount}/${maxCapacity} siswa). Anda berada di antrean nomor #${pos.position}.`
    };
  },

  getQueuePosition(ticketId, ulanganId) {
    const list = this.getWaitingListForExam(ulanganId);
    const index = list.findIndex(t => t.ticketId === ticketId);
    return {
      position: index >= 0 ? index + 1 : 1,
      totalWaiting: list.length
    };
  },

  getTicketStatus(ticketId, customMax = null) {
    const maxLimit = customMax || this.getMaxInside();
    const ticket = waitingTickets.get(ticketId);
    if (!ticket) {
      return { valid: false, message: 'Tiket antrean tidak ditemukan atau sudah kadaluarsa' };
    }

    ticket.lastPolledAt = Date.now();

    if (ticket.status === 'ready') {
      return {
        valid: true,
        status: 'ready',
        ticket
      };
    }

    const activeCount = this.getActiveStudentCount(ticket.ulanganId);
    if (activeCount < maxLimit && activeEnteringCount < this.getMaxBurst()) {
      const list = this.getWaitingListForExam(ticket.ulanganId);
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

  consumeTicket(ticketId) {
    const ticket = waitingTickets.get(ticketId);
    if (ticket) {
      ticket.status = 'used';
      waitingTickets.delete(ticketId);
    }
  },

  releaseSlot(ulanganId) {
    if (!ulanganId) return;
    const list = this.getWaitingListForExam(Number(ulanganId));
    if (list.length > 0) {
      list[0].status = 'ready';
    }
  },

  // GERBANG 2: Pengumpulan Jawaban Serentak (Submit Queue Gate)
  // Menjaga agar saat puluhan siswa submit serentak, proses penulisan ke database
  // diproses dalam antrean cepat (maks 20 proses paralel) sehingga SQLite tidak terkunci (database is locked)
  // dan server tidak hang / down. Dilengkapi timeout guard 10 detik agar tidak pernah menggantung.
  queueSubmit(submitFn) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Batas waktu antrean submit terlampaui (timeout)'));
        }
      }, 10000);

      submitQueue.push({
        fn: submitFn,
        resolve: (val) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            resolve(val);
          }
        },
        reject: (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            reject(err);
          }
        }
      });
      processNextSubmit();
    });
  },

  getSubmitQueueLength() {
    return submitQueue.length;
  },

  getActiveSubmitsCount() {
    return activeSubmits;
  },

  cleanExpiredTickets() {
    const now = Date.now();
    for (const [id, t] of waitingTickets.entries()) {
      if (now - t.lastPolledAt > 5 * 60 * 1000) {
        waitingTickets.delete(id);
      }
    }
  },

  _reset() {
    waitingTickets.clear();
    activeEnteringCount = 0;
    activeSubmits = 0;
    submitQueue.length = 0;
  }
};

module.exports = waitingRoomService;
