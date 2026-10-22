const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const queueService = require('../src/services/queueService');
const waitingRoomService = require('../src/services/waitingRoomService');

function unique(value) {
  return `${value}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test('10 peserta serentak: dua antrean, AI FIFO, remedial, dan nilai tertinggi tetap terisolasi', async () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const ulangan = examService.createUlangan(guru.id, {
    judul: unique('Uji 10 Peserta AI'),
    mata_pelajaran: 'Informatika',
    tingkat_kelas: '8',
    durasi_menit: 60,
    kkm: 75,
    skor_langsung_ai: 1,
    remedial_langsung: 1,
    maksimal_percobaan: 2,
    kebijakan_nilai: 'tertinggi'
  });
  const soalA = examService.createSoal(ulangan.id, {
    nomor: 1,
    jenis: 'essay',
    pertanyaan: 'Jelaskan konsep pertama.',
    bobot: 50,
    kunci_jawaban: 'Konsep pertama'
  });
  const soalB = examService.createSoal(ulangan.id, {
    nomor: 2,
    jenis: 'essay',
    pertanyaan: 'Jelaskan konsep kedua.',
    bobot: 50,
    kunci_jawaban: 'Konsep kedua'
  });
  examService.updateStatusUlangan(ulangan.id, 'dibuka');
  waitingRoomService._reset();

  const students = Array.from({ length: 10 }, (_, index) => ({
    name: unique(`Peserta-${index + 1}`),
    className: '8A'
  }));

  try {
    // Gate kapasitas dibuat 8 agar peserta ke-9 dan ke-10 benar-benar antre.
    const entries = await Promise.all(students.map(async student => {
      const gate = waitingRoomService.checkEntry(
        ulangan.kode_ujian,
        student.name,
        student.className,
        8
      );
      if (!gate.allowed) return { student, gate, session: null };
      const session = studentService.startExam(ulangan.kode_ujian, student.name, student.className);
      return { student, gate, session };
    }));

    const waitingEntries = entries.filter(item => item.gate.inQueue);
    assert.equal(waitingEntries.length, 2, 'tepat dua peserta harus menunggu');
    assert.deepEqual(waitingEntries.map(item => item.gate.position), [1, 2]);

    const activeEntries = entries.filter(item => item.session);
    assert.equal(activeEntries.length, 8);
    const activeIds = new Set(activeEntries.map(item => item.session.pengerjaanId));
    assert.equal(activeIds.size, 8, 'attempt aktif tidak boleh berbagi ID');

    // Satu slot dibuka, tiket pertama diproses, lalu slot kedua dibuka untuk tiket kedua.
    const firstActive = activeEntries[0].session;
    studentService.saveDraft(firstActive.pengerjaanId, [
      { soal_id: soalA.id, jawaban_siswa: `LOW-${activeEntries[0].student.name}` },
      { soal_id: soalB.id, jawaban_siswa: `LOW-${activeEntries[0].student.name}` }
    ], null, null, firstActive.studentSessionToken);
    studentService.submitExam(firstActive.pengerjaanId, [
      { soal_id: soalA.id, jawaban_siswa: `LOW-${activeEntries[0].student.name}` },
      { soal_id: soalB.id, jawaban_siswa: `LOW-${activeEntries[0].student.name}` }
    ], 0, false, null, firstActive.studentSessionToken);
    waitingRoomService.releaseSlot(ulangan.id);

    const firstTicket = waitingEntries[0].gate.ticketId;
    assert.equal(waitingRoomService.getTicketStatus(firstTicket, 8).status, 'ready');
    waitingRoomService.consumeTicket(firstTicket);
    const firstQueuedSession = studentService.startExam(
      ulangan.kode_ujian,
      waitingEntries[0].student.name,
      waitingEntries[0].student.className
    );
    assert.ok(firstQueuedSession.pengerjaanId);

    const secondActive = activeEntries[1].session;
    studentService.submitExam(secondActive.pengerjaanId, [
      { soal_id: soalA.id, jawaban_siswa: `HIGH-${activeEntries[1].student.name}` },
      { soal_id: soalB.id, jawaban_siswa: `HIGH-${activeEntries[1].student.name}` }
    ], 0, false, null, secondActive.studentSessionToken);
    waitingRoomService.releaseSlot(ulangan.id);

    const secondTicket = waitingEntries[1].gate.ticketId;
    assert.equal(waitingRoomService.getTicketStatus(secondTicket, 8).status, 'ready');
    waitingRoomService.consumeTicket(secondTicket);
    const secondQueuedSession = studentService.startExam(
      ulangan.kode_ujian,
      waitingEntries[1].student.name,
      waitingEntries[1].student.className
    );
    assert.ok(secondQueuedSession.pengerjaanId);

    const allSessions = [
      ...activeEntries.slice(0, 2).map(item => item.session),
      ...activeEntries.slice(2).map(item => item.session),
      firstQueuedSession,
      secondQueuedSession
    ];
    assert.equal(allSessions.length, 10);
    assert.equal(new Set(allSessions.map(session => session.pengerjaanId)).size, 10);
    assert.equal(new Set(allSessions.map(session => session.studentSessionToken)).size, 10);
    assert.equal(new Set(allSessions.map(session => session.peserta.id)).size, 10);

    // Semua jawaban berbeda per peserta. Jawaban LOW hanya untuk peserta pertama.
    for (let i = 2; i < allSessions.length; i++) {
      const session = allSessions[i];
      const name = students.find(student => student.name === session.peserta.nama)?.name || session.peserta.nama;
      studentService.submitExam(session.pengerjaanId, [
        { soal_id: soalA.id, jawaban_siswa: `HIGH-${name}` },
        { soal_id: soalB.id, jawaban_siswa: `HIGH-${name}` }
      ], 0, false, null, session.studentSessionToken);
    }

    const lowSession = allSessions[0];
    const highSessions = allSessions.slice(1);
    for (const session of highSessions) {
      const rows = db.prepare('SELECT jawaban_siswa FROM jawaban WHERE pengerjaan_id = ? ORDER BY soal_id').all(session.pengerjaanId);
      assert.equal(rows.length, 2);
      assert.ok(rows.every(row => row.jawaban_siswa.startsWith('HIGH-')));
    }

    const grade = async item => {
      const low = String(item.jawaban_siswa || '').startsWith('LOW-');
      const remedial = String(item.jawaban_siswa || '').startsWith('REMEDIAL-');
      return {
        status_jawaban: low ? 'salah' : 'benar',
        skor_rekomendasi: remedial ? Number(item.bobot) : (low ? 20 : 45),
        alasan_ai: remedial ? 'Jawaban remedial benar.' : 'Uji AI terisolasi.',
        model_ai: 'test_ai'
      };
    };

    // Proses FIFO sampai seluruh jawaban awal selesai dan nilai dirilis otomatis.
    for (;;) {
      const step = await queueService.processNextAnswer(ulangan.id, grade);
      if (step.done) break;
    }

    const lowStatus = studentService.getPengerjaanStatus(lowSession.pengerjaanId, lowSession.studentSessionToken);
    assert.equal(lowStatus.isReleased, true);
    assert.equal(lowStatus.canDirectRemedial, true);
    assert.ok(Number(lowStatus.nilaiFinal) < 75);

    for (const session of highSessions) {
      const status = studentService.getPengerjaanStatus(session.pengerjaanId, session.studentSessionToken);
      assert.equal(status.isReleased, true);
      assert.ok(Number(status.nilaiFinal) >= 75);
      assert.equal(status.canDirectRemedial, false);
    }

    // Remedial memperbaiki attempt yang sama. Nilai terbaik harus menjadi nilai remedial.
    const remedial = studentService.startDirectRemedial(
      lowSession.pengerjaanId,
      { nama: lowSession.peserta.nama, kelas: lowSession.peserta.kelas },
      lowSession.studentSessionToken
    );
    assert.equal(remedial.success, true);
    studentService.submitExam(lowSession.pengerjaanId, [
      { soal_id: soalA.id, jawaban_siswa: `REMEDIAL-${lowSession.peserta.nama}` },
      { soal_id: soalB.id, jawaban_siswa: `REMEDIAL-${lowSession.peserta.nama}` }
    ], 0, false, null, lowSession.studentSessionToken);

    for (;;) {
      const step = await queueService.processNextAnswer(ulangan.id, grade);
      if (step.done) break;
    }

    const finalLow = studentService.getPengerjaanStatus(lowSession.pengerjaanId, lowSession.studentSessionToken);
    assert.equal(finalLow.isReleased, true);
    assert.equal(Number(finalLow.nilaiFinal), 100);
    assert.equal(Number(finalLow.nilai_terbaik), 100);
    assert.equal(finalLow.nama, lowSession.peserta.nama);

    // Token peserta lain tidak boleh membuka atau membaca hasil peserta remedial.
    const foreign = studentService.getPengerjaanStatus(lowSession.pengerjaanId, highSessions[0].studentSessionToken);
    assert.equal(foreign, null);
  } finally {
    waitingRoomService._reset();
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(ulangan.id);
  }
});
