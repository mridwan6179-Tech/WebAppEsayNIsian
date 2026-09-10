const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const waitingRoomService = require('../src/services/waitingRoomService');

test('=== PENGUJIAN SISTEM ANTREAN RUANG TUNGGU UJIAN (MAX 20 SISWA BERSAMAAN) ===', async (t) => {
  // Setup data pengujian
  const teacherEmail = 'guru_queue@sekolah.id';
  let guru = db.prepare('SELECT id FROM guru WHERE email = ?').get(teacherEmail);
  if (!guru) {
    const info = db.prepare('INSERT INTO guru (nama, email, password) VALUES (?, ?, ?)')
      .run('Guru Queue Tester', teacherEmail, 'password123');
    guru = { id: info.lastInsertRowid };
  }

  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Uji Kapasitas Antrean 20',
    mata_pelajaran: 'Teknologi Informasi',
    tingkat_kelas: '10 MIPA'
  });
  const kodeUjian = ulangan.kode_ujian;

  examService.createSoal(ulangan.id, {
    nomor: 1,
    jenis: 'isian',
    pertanyaan: 'Berapa batas kapasitas siswa bersamaan?',
    bobot: 10,
    kunci_jawaban: '20'
  });

  examService.updateStatusUlangan(ulangan.id, 'dibuka');

  // Bersihkan tiket antrean sebelum mulai
  waitingRoomService._reset();

  await t.test('1. Siswa dapat masuk langsung selama jumlah aktif kurang dari batas maksimal (misal batas = 3 untuk simulasi)', () => {
    const customLimit = 3;

    // Siswa 1
    const res1 = waitingRoomService.checkEntry(kodeUjian, 'Siswa 01', '10 MIPA 1', customLimit);
    assert.strictEqual(res1.allowed, true);
    assert.strictEqual(res1.inQueue, false);
    studentService.startExam(kodeUjian, 'Siswa 01', '10 MIPA 1');

    // Siswa 2
    const res2 = waitingRoomService.checkEntry(kodeUjian, 'Siswa 02', '10 MIPA 1', customLimit);
    assert.strictEqual(res2.allowed, true);
    studentService.startExam(kodeUjian, 'Siswa 02', '10 MIPA 1');

    // Siswa 3
    const res3 = waitingRoomService.checkEntry(kodeUjian, 'Siswa 03', '10 MIPA 1', customLimit);
    assert.strictEqual(res3.allowed, true);
    studentService.startExam(kodeUjian, 'Siswa 03', '10 MIPA 1');

    const activeNow = waitingRoomService.getActiveStudentCount(ulangan.id);
    assert.strictEqual(activeNow, 3);
  });

  let ticketIdSiswa4 = null;

  await t.test('2. Siswa ke-4 ditolak masuk langsung dan otomatis masuk antrean ruang tunggu (posisi #1)', () => {
    const customLimit = 3;
    const res4 = waitingRoomService.checkEntry(kodeUjian, 'Siswa 04', '10 MIPA 1', customLimit);

    assert.strictEqual(res4.allowed, false);
    assert.strictEqual(res4.inQueue, true);
    assert.strictEqual(res4.position, 1);
    assert.strictEqual(res4.totalWaiting, 1);
    assert.ok(res4.ticketId);
    ticketIdSiswa4 = res4.ticketId;

    // Siswa ke-5 masuk antrean posisi #2
    const res5 = waitingRoomService.checkEntry(kodeUjian, 'Siswa 05', '10 MIPA 1', customLimit);
    assert.strictEqual(res5.allowed, false);
    assert.strictEqual(res5.inQueue, true);
    assert.strictEqual(res5.position, 2);
    assert.strictEqual(res5.totalWaiting, 2);
  });

  await t.test('3. Siswa yang sudah berada di dalam ujian (Siswa 01) me-refresh halaman tidak diantrekan ulang', () => {
    const customLimit = 3;
    const refreshRes = waitingRoomService.checkEntry(kodeUjian, 'Siswa 01', '10 MIPA 1', customLimit);
    assert.strictEqual(refreshRes.allowed, true);
    assert.strictEqual(refreshRes.inQueue, false);
  });

  await t.test('4. Ketika Siswa 01 mengumpulkan ujian (submit), 1 slot terbuka dan Siswa 04 otomatis menjadi ready', () => {
    const customLimit = 3;

    // Cari pengerjaan Siswa 01
    const p1 = db.prepare(`
      SELECT p.id FROM pengerjaan p
      JOIN peserta pes ON p.peserta_id = pes.id
      WHERE pes.nama = 'Siswa 01' AND p.ulangan_id = ?
    `).get(ulangan.id);

    assert.ok(p1);

    // Siswa 01 submit
    studentService.submitExam(p1.id, [{ nomor: 1, jawaban_siswa: '20' }]);
    waitingRoomService.releaseSlot(ulangan.id);

    // Cek tiket Siswa 04 (antrean terdepan)
    const status4 = waitingRoomService.getTicketStatus(ticketIdSiswa4, customLimit);
    assert.strictEqual(status4.status, 'ready');

    // Konsumsi tiket Siswa 04 dan mulai ujian
    waitingRoomService.consumeTicket(ticketIdSiswa4);
    const started4 = studentService.startExam(kodeUjian, 'Siswa 04', '10 MIPA 1');
    assert.ok(started4.pengerjaanId);
  });

  await t.test('5. Kapasitas default sistem terpasang pada 20 siswa bersamaan', () => {
    const max = waitingRoomService.getMaxConcurrent();
    assert.strictEqual(max, 20);
  });

  // Cleanup
  waitingRoomService._reset();
});
