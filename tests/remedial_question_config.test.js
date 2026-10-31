const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const reviewService = require('../src/services/reviewService');
const studentService = require('../src/services/studentService');

function addQuestion(examId, number, jenis, extra = {}) {
  return examService.createSoal(examId, {
    nomor: number,
    pertanyaan: `${jenis} ${number}`,
    jenis,
    bobot: 10,
    kunci_pg: jenis === 'pilihan_ganda' ? (extra.kompleks ? 'A,B' : 'A') : undefined,
    opsi_a: jenis === 'pilihan_ganda' ? 'A' : undefined,
    opsi_b: jenis === 'pilihan_ganda' ? 'B' : undefined,
    opsi_c: jenis === 'pilihan_ganda' ? 'C' : undefined,
    opsi_d: jenis === 'pilihan_ganda' ? 'D' : undefined,
    kunci_jawaban: jenis === 'isian' || jenis === 'essay' ? 'jawaban' : undefined,
    ...extra
  });
}

test('sesi remedial menyimpan jumlah dan persentase tipe soal lalu menerapkannya saat siswa masuk', () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: `Remedial ratio ${Date.now()}`,
    mata_pelajaran: 'Matematika',
    tingkat_kelas: '7A',
    kkm: 75,
    maksimal_percobaan: 1
  });

  for (let i = 1; i <= 6; i++) addQuestion(exam.id, i, 'pilihan_ganda');
  for (let i = 7; i <= 10; i++) addQuestion(exam.id, i, 'pilihan_ganda', { kompleks: true });
  for (let i = 11; i <= 14; i++) addQuestion(exam.id, i, 'essay');

  const pesertaId = db.prepare('INSERT INTO peserta (ulangan_id, nama, kelas) VALUES (?, ?, ?)')
    .run(exam.id, 'Siswa Remedial', '7A').lastInsertRowid;
  db.prepare(`
    INSERT INTO pengerjaan (ulangan_id, peserta_id, status, started_at, submitted_at, nilai_final, nilai_ai, attempt_ke)
    VALUES (?, ?, 'submitted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 40, 40, 1)
  `).run(exam.id, pesertaId);

  try {
    examService.updateUlangan(exam.id, guru.id, { status: 'dibuka' });
    const created = reviewService.createRemedialSession(exam.id, guru.id, {
      classes: ['7A'],
      baseUrl: 'https://contoh.test',
      question_count: 6,
      question_ratios: { pg_biasa: 50, pg_kompleks: 33, essay: 17 },
      waktu_mulai: new Date(Date.now() - 60_000).toISOString(),
      waktu_selesai: new Date(Date.now() + 3_600_000).toISOString()
    });

    assert.equal(created.session.remedial_question_count, 6);
    assert.deepEqual(JSON.parse(created.session.remedial_question_ratios), {
      pg_biasa: 50,
      pg_kompleks: 33,
      essay: 17
    });
    assert.ok(created.session.waktu_mulai);
    assert.ok(created.session.waktu_selesai);

    const started = studentService.startExam(created.session.kode_sesi, 'Siswa Remedial', '7A');
    assert.equal(started.soal.length, 6);
    const counts = started.soal.reduce((acc, soal) => {
      const key = soal.jenis === 'essay' ? 'essay' : (soal.tipe_pg === 'pg_kompleks' ? 'pg_kompleks' : 'pg_biasa');
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    assert.deepEqual(counts, { pg_biasa: 3, pg_kompleks: 2, essay: 1 });
  } finally {
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(exam.id);
  }
});

test('nama yang dipilih guru menjadi pengecualian dan siswa lain tetap boleh masuk', () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: `Remedial allowlist ${Date.now()}`,
    mata_pelajaran: 'IPA',
    tingkat_kelas: '8A',
    kkm: 75,
    maksimal_percobaan: 1
  });
  addQuestion(exam.id, 1, 'pilihan_ganda');

  const insertPeserta = db.prepare('INSERT INTO peserta (ulangan_id, nama, kelas) VALUES (?, ?, ?)');
  const tuntasId = insertPeserta.run(exam.id, 'Siswa Tuntas', '8A').lastInsertRowid;
  const rendahId = insertPeserta.run(exam.id, 'Siswa Rendah', '8A').lastInsertRowid;
  const insertAttempt = db.prepare(`
    INSERT INTO pengerjaan (ulangan_id, peserta_id, status, started_at, submitted_at, nilai_final, nilai_ai, attempt_ke)
    VALUES (?, ?, 'submitted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, 1)
  `);
  insertAttempt.run(exam.id, tuntasId, 90, 90);
  insertAttempt.run(exam.id, rendahId, 40, 40);

  try {
    examService.updateUlangan(exam.id, guru.id, { status: 'dibuka' });
    const created = reviewService.createRemedialSession(exam.id, guru.id, {
      classes: ['8A'],
      student_ids: [tuntasId],
      baseUrl: 'https://contoh.test'
    });

    assert.deepEqual(created.selected_student_ids, [tuntasId]);
    assert.throws(
      () => studentService.startExam(created.session.kode_sesi, 'Siswa Tuntas', '8A'),
      /tidak perlu mengulang/i
    );
    const started = studentService.startExam(created.session.kode_sesi, 'Siswa Rendah', '8A');
    assert.ok(started.pengerjaanId);
  } finally {
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(exam.id);
  }
});

test('siswa yang belum ikut ulangan tetap dapat masuk dan daftar nama ditandai sebagai pengecualian', () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: `Remedial reference only ${Date.now()}`,
    mata_pelajaran: 'Bahasa Indonesia',
    tingkat_kelas: '9A',
    kkm: 75,
    maksimal_percobaan: 1
  });
  addQuestion(exam.id, 1, 'pilihan_ganda');
  const knownId = db.prepare('INSERT INTO peserta (ulangan_id, nama, kelas) VALUES (?, ?, ?)')
    .run(exam.id, 'Siswa Referensi', '9A').lastInsertRowid;
  db.prepare(`
    INSERT INTO pengerjaan (ulangan_id, peserta_id, status, started_at, submitted_at, nilai_final, nilai_ai, attempt_ke)
    VALUES (?, ?, 'submitted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 40, 40, 1)
  `).run(exam.id, knownId);

  try {
    examService.updateUlangan(exam.id, guru.id, { status: 'dibuka' });
    const created = reviewService.createRemedialSession(exam.id, guru.id, {
      classes: ['9A'],
      student_ids: [knownId],
      baseUrl: 'https://contoh.test'
    });

    assert.equal(created.candidates.some(row => row.peserta_id === knownId), false);
    assert.throws(
      () => studentService.startExam(created.session.kode_sesi, 'Siswa Referensi', '9A'),
      /tidak perlu mengulang/i
    );
    const started = studentService.startExam(created.session.kode_sesi, 'Siswa Belum Ikut', '9A');
    assert.ok(started.pengerjaanId);
    assert.equal(started.peserta.nama, 'Siswa Belum Ikut');
    assert.match(created.whatsapp_text, /tidak perlu mengulang/i);
    assert.match(created.whatsapp_text, /belum mengikuti|belum ikut/i);
  } finally {
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(exam.id);
  }
});
