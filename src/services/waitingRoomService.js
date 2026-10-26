const crypto = require('crypto');
const db = require('../config/database');
const studentService = require('./studentService');

// Maksimal 20 siswa mengerjakan satu ulangan secara bersamaan.
const configuredCapacity = Number.parseInt(process.env.MAX_INSIDE_EXAM || '20', 10);
const MAX_INSIDE_EXAM = Math.max(1, Math.min(20, Number.isFinite(configuredCapacity) ? configuredCapacity : 20));
const MAX_BURST_ENTRY = Math.max(1, Number.parseInt(process.env.MAX_BURST_ENTRY || '20', 10));
const MAX_BURST_SUBMIT = Math.max(1, Number.parseInt(process.env.MAX_BURST_SUBMIT || '20', 10));

let activeEnteringCount = 0;
let activeSubmits = 0;
const submitQueue = [];

const now = () => Date.now();
const makeTicketId = () => `tkt_${now()}_${crypto.randomBytes(5).toString('hex')}`;
const makeReservationId = () => `seat_${now()}_${crypto.randomBytes(5).toString('hex')}`;

function toTicket(row) {
  if (!row) return null;
  return {
    ticketId: row.ticket_id,
    ulanganId: Number(row.ulangan_id),
    kodeUjian: row.kode_ujian,
    nama: row.nama,
    kelas: row.kelas,
    sesiId: row.sesi_id == null ? null : Number(row.sesi_id),
    studentSessionToken: row.student_session_token,
    ownershipPengerjaanId: row.ownership_pengerjaan_id || null,
    ownershipStudentSessionToken: row.ownership_student_session_token || null,
    isRetake: Boolean(row.is_retake),
    status: row.status,
    createdAt: Number(row.created_at),
    lastPolledAt: Number(row.last_polled_at)
  };
}

function getTicketRow(ticketId) {
  return db.prepare('SELECT * FROM ruang_tunggu_ujian WHERE ticket_id = ?').get(ticketId);
}

function processNextSubmit() {
  while (activeSubmits < MAX_BURST_SUBMIT && submitQueue.length > 0) {
    const task = submitQueue.shift();
    activeSubmits++;
    Promise.resolve()
      .then(() => task.fn())
      .then(task.resolve, task.reject)
      .finally(() => {
        activeSubmits = Math.max(0, activeSubmits - 1);
        processNextSubmit();
      });
  }
}

const waitingRoomService = {
  getMaxInside() { return MAX_INSIDE_EXAM; },
  getMaxBurst() { return MAX_BURST_ENTRY; },

  getActiveStudentCount(ulanganId) {
    if (!ulanganId) return 0;
    const row = db.prepare(`SELECT COUNT(*) AS c FROM pengerjaan WHERE ulangan_id = ? AND status = 'mengerjakan'`).get(ulanganId);
    return Number(row?.c || 0);
  },

  // Reservasi singkat menutup race antar request/instance: satu query atomik
  // hanya berhasil bila jumlah pengerjaan aktif + reservasi yang belum kadaluarsa
  // masih di bawah kapasitas. Reservasi dihapus saat startExam berhasil.
  reserveSeat(ulanganId, studentSessionToken, maxCapacity = null) {
    if (!ulanganId || !studentSessionToken) return { allowed: true, reserved: false };
    const limit = Math.max(1, Math.min(20, Number(maxCapacity || this.getMaxInside())));
    const current = now();
    this.cleanExpiredSeatReservations(current);
    const existing = db.prepare(`
      SELECT reservation_id FROM ruang_tunggu_seat
      WHERE ulangan_id = ? AND student_session_token = ? AND expires_at >= ?
    `).get(ulanganId, studentSessionToken, current);
    if (existing) return { allowed: true, reserved: true, reservationId: existing.reservation_id, existing: true };

    const reservationId = makeReservationId();
    const result = db.prepare(`
      INSERT INTO ruang_tunggu_seat (reservation_id, ulangan_id, student_session_token, status, created_at, expires_at)
      SELECT ?, ?, ?, 'reserved', ?, ?
      WHERE (
        (SELECT COUNT(*) FROM pengerjaan WHERE ulangan_id = ? AND status = 'mengerjakan')
        + (SELECT COUNT(*) FROM ruang_tunggu_seat WHERE ulangan_id = ? AND status = 'reserved' AND expires_at >= ?)
      ) < ?
    `).run(reservationId, ulanganId, studentSessionToken, current, current + 30000, ulanganId, ulanganId, current, limit);
    if (Number(result?.changes || 0) === 1) return { allowed: true, reserved: true, reservationId };
    return { allowed: false, reserved: false };
  },

  activateSeat(studentSessionToken) {
    if (!studentSessionToken) return;
    db.prepare('DELETE FROM ruang_tunggu_seat WHERE student_session_token = ?').run(studentSessionToken);
  },

  releaseSeat(studentSessionToken) {
    if (!studentSessionToken) return;
    db.prepare('DELETE FROM ruang_tunggu_seat WHERE student_session_token = ?').run(studentSessionToken);
  },

  cleanExpiredSeatReservations(current = now()) {
    db.prepare('DELETE FROM ruang_tunggu_seat WHERE expires_at < ?').run(current);
  },

  checkEntry(kodeUjian, nama, kelas, customMax = null, sesiId = null, studentSessionToken = null, ownershipPengerjaanId = null, ownershipStudentSessionToken = null) {
    this.cleanExpiredTickets();
    const maxCapacity = Math.max(1, Math.min(20, Number(customMax || this.getMaxInside())));
    const cleanKode = String(kodeUjian || '').trim().toUpperCase();
    const cleanNama = String(nama || '').trim();
    const cleanKelas = String(kelas || '').trim();
    const strictOwnership = Boolean(studentSessionToken || ownershipPengerjaanId || ownershipStudentSessionToken);
    const val = studentService.validateExamCode(cleanKode);
    if (!val.valid) return { allowed: false, inQueue: false, error: val.message };
    const ulanganId = val.ulangan.id;

    if (ownershipPengerjaanId && ownershipStudentSessionToken) {
      const ownedAttempt = db.prepare(`
        SELECT p.id FROM pengerjaan p JOIN peserta pes ON pes.id = p.peserta_id
        WHERE p.id = ? AND p.ulangan_id = ? AND p.student_session_token = ?
          AND LOWER(TRIM(pes.nama)) = LOWER(?) AND LOWER(TRIM(pes.kelas)) = LOWER(?)
      `).get(ownershipPengerjaanId, ulanganId, ownershipStudentSessionToken, cleanNama, cleanKelas);
      if (ownedAttempt) return { allowed: true, inQueue: false, ulanganId };
      return { allowed: false, inQueue: false, error: 'Sesi siswa tidak valid atau identitas tidak cocok.' };
    }

    const existingPeserta = db.prepare(`SELECT id FROM peserta WHERE ulangan_id = ? AND LOWER(nama) = LOWER(?) AND LOWER(kelas) = LOWER(?)`).get(ulanganId, cleanNama, cleanKelas);
    if (existingPeserta) {
      const existing = db.prepare(`SELECT id, status, student_session_token FROM pengerjaan WHERE ulangan_id = ? AND peserta_id = ? ORDER BY id DESC LIMIT 1`).get(ulanganId, existingPeserta.id);
      const ownsExisting = existing && ownershipPengerjaanId && Number(existing.id) === Number(ownershipPengerjaanId) && ownershipStudentSessionToken && existing.student_session_token === ownershipStudentSessionToken;
      if (ownsExisting || !strictOwnership) return { allowed: true, inQueue: false, ulanganId };
    }

    const activeCount = this.getActiveStudentCount(ulanganId);
    if (activeCount >= maxCapacity) {
      return this.createOrGetWaitingTicket(ulanganId, cleanKode, cleanNama, cleanKelas, activeCount, maxCapacity, 'Ruang ujian sedang penuh', sesiId, studentSessionToken, ownershipPengerjaanId, ownershipStudentSessionToken);
    }
    if (this.getWaitingListForExam(ulanganId).length > 0 || activeEnteringCount >= MAX_BURST_ENTRY) {
      return this.createOrGetWaitingTicket(ulanganId, cleanKode, cleanNama, cleanKelas, activeCount, maxCapacity, 'Sistem sedang mengatur antrean gerbang masuk', sesiId, studentSessionToken, ownershipPengerjaanId, ownershipStudentSessionToken);
    }

    if (studentSessionToken) {
      const reservation = this.reserveSeat(ulanganId, studentSessionToken, maxCapacity);
      if (!reservation.allowed) {
        return this.createOrGetWaitingTicket(ulanganId, cleanKode, cleanNama, cleanKelas, activeCount, maxCapacity, 'Ruang ujian baru saja penuh', sesiId, studentSessionToken, ownershipPengerjaanId, ownershipStudentSessionToken);
      }
    }

    activeEnteringCount++;
    setTimeout(() => { activeEnteringCount = Math.max(0, activeEnteringCount - 1); }, 1500);
    return { allowed: true, inQueue: false, ulanganId, activeCount, maxLimit: maxCapacity };
  },

  getWaitingListForExam(ulanganId) {
    return db.prepare(`SELECT * FROM ruang_tunggu_ujian WHERE ulangan_id = ? AND status IN ('waiting', 'ready') ORDER BY created_at ASC, ticket_id ASC`).all(ulanganId).map(toTicket);
  },

  createOrGetWaitingTicket(ulanganId, cleanKode, cleanNama, cleanKelas, activeCount, maxCapacity, reason, sesiId = null, studentSessionToken = null, ownershipPengerjaanId = null, ownershipStudentSessionToken = null) {
    const token = String(studentSessionToken || `queue_${crypto.randomBytes(16).toString('hex')}`);
    let row = db.prepare(`SELECT * FROM ruang_tunggu_ujian WHERE ulangan_id = ? AND student_session_token = ? AND status IN ('waiting', 'ready') ORDER BY created_at ASC LIMIT 1`).get(ulanganId, token);
    if (!row) {
      const createdAt = now();
      const ticketId = makeTicketId();
      try {
        db.prepare(`
          INSERT INTO ruang_tunggu_ujian
            (ticket_id, ulangan_id, kode_ujian, nama, kelas, sesi_id, student_session_token, ownership_pengerjaan_id, ownership_student_session_token, is_retake, status, created_at, last_polled_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'waiting', ?, ?)
        `).run(ticketId, ulanganId, cleanKode, cleanNama, cleanKelas, sesiId || null, token, ownershipPengerjaanId || null, ownershipStudentSessionToken || null, createdAt, createdAt);
        row = getTicketRow(ticketId);
      } catch (err) {
        row = db.prepare(`SELECT * FROM ruang_tunggu_ujian WHERE ulangan_id = ? AND student_session_token = ? AND status IN ('waiting', 'ready') ORDER BY created_at ASC LIMIT 1`).get(ulanganId, token);
        if (!row) throw err;
      }
    }
    const ticket = toTicket(row);
    const pos = this.getQueuePosition(ticket.ticketId, ulanganId);
    return { allowed: false, inQueue: true, ticketId: ticket.ticketId, position: pos.position, totalWaiting: pos.totalWaiting, activeCount, maxLimit: maxCapacity, studentSessionToken: token, message: `${reason} (${activeCount}/${maxCapacity} siswa). Anda berada di antrean nomor #${pos.position}.` };
  },

  getQueuePosition(ticketId, ulanganId) {
    const list = this.getWaitingListForExam(ulanganId);
    const index = list.findIndex(ticket => ticket.ticketId === ticketId);
    return { position: index >= 0 ? index + 1 : 1, totalWaiting: list.length };
  },

  ownsTicket(ticketId, studentSessionToken) {
    if (!ticketId || !studentSessionToken) return false;
    return Boolean(db.prepare(`SELECT 1 FROM ruang_tunggu_ujian WHERE ticket_id = ? AND student_session_token = ? AND status IN ('waiting', 'ready')`).get(ticketId, studentSessionToken));
  },

  getTicketStatus(ticketId, customMax = null) {
    this.cleanExpiredTickets();
    const row = getTicketRow(ticketId);
    if (!row) return { valid: false, message: 'Tiket antrean tidak ditemukan atau sudah kadaluarsa' };
    const maxLimit = Math.max(1, Math.min(20, Number(customMax || this.getMaxInside())));
    const polledAt = now();
    db.prepare('UPDATE ruang_tunggu_ujian SET last_polled_at = ? WHERE ticket_id = ?').run(polledAt, ticketId);
    if (row.status === 'ready') return { valid: true, status: 'ready', ticket: toTicket({ ...row, last_polled_at: polledAt }), maxLimit };
    if (row.status === 'used') return { valid: false, message: 'Tiket antrean sudah digunakan' };
    const activeCount = this.getActiveStudentCount(row.ulangan_id);
    if (activeCount < maxLimit && activeEnteringCount < MAX_BURST_ENTRY) {
      const list = this.getWaitingListForExam(row.ulangan_id);
      if (list[0]?.ticketId === ticketId) {
        db.prepare("UPDATE ruang_tunggu_ujian SET status = 'ready', last_polled_at = ? WHERE ticket_id = ? AND status = 'waiting'").run(polledAt, ticketId);
        return { valid: true, status: 'ready', ticket: toTicket(getTicketRow(ticketId)), maxLimit };
      }
    }
    const pos = this.getQueuePosition(ticketId, row.ulangan_id);
    return { valid: true, status: 'waiting', position: pos.position, totalWaiting: pos.totalWaiting, activeCount, maxLimit };
  },

  consumeTicket(ticketId) {
    db.prepare("UPDATE ruang_tunggu_ujian SET status = 'used', last_polled_at = ? WHERE ticket_id = ? AND status IN ('waiting', 'ready')").run(now(), ticketId);
  },

  releaseSlot(ulanganId) {
    if (!ulanganId) return;
    const first = db.prepare(`SELECT ticket_id FROM ruang_tunggu_ujian WHERE ulangan_id = ? AND status = 'waiting' ORDER BY created_at ASC, ticket_id ASC LIMIT 1`).get(Number(ulanganId));
    if (first) db.prepare("UPDATE ruang_tunggu_ujian SET status = 'ready', last_polled_at = ? WHERE ticket_id = ? AND status = 'waiting'").run(now(), first.ticket_id);
  },

  queueSubmit(submitFn) {
    return new Promise((resolve, reject) => { submitQueue.push({ fn: submitFn, resolve, reject }); processNextSubmit(); });
  },
  getSubmitQueueLength() { return submitQueue.length; },
  getActiveSubmitsCount() { return activeSubmits; },
  cleanExpiredTickets() { db.prepare("DELETE FROM ruang_tunggu_ujian WHERE status IN ('waiting', 'ready') AND last_polled_at < ?").run(now() - 5 * 60 * 1000); },
  _reset() {
    try { db.prepare('DELETE FROM ruang_tunggu_ujian').run(); } catch (_) {}
    try { db.prepare('DELETE FROM ruang_tunggu_seat').run(); } catch (_) {}
    activeEnteringCount = 0;
    activeSubmits = 0;
    submitQueue.length = 0;
  }
};

module.exports = waitingRoomService;
