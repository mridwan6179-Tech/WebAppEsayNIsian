const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const db = require('../src/config/database');
const app = require('../server');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');

function unique(value) {
  return `${value}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test('recovery token resumes the same attempt and rotates the browser session token', () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: unique('Recovery Token'),
    mata_pelajaran: 'Bahasa',
    tingkat_kelas: '8A',
    durasi_menit: 60
  });
  const question = examService.createSoal(exam.id, {
    nomor: 1,
    jenis: 'isian',
    pertanyaan: 'Jawaban?',
    bobot: 100,
    kunci_jawaban: 'ya'
  });
  examService.updateStatusUlangan(exam.id, 'dibuka');

  try {
    const first = studentService.startExam(exam.kode_ujian, 'Siswa Recovery', '8A');
    assert.match(first.studentRecoveryToken, /^[A-Z0-9-]{8,}$/);
    assert.equal(studentService.verifyStudentRecoveryToken(first.pengerjaanId, first.studentRecoveryToken, 'Siswa Recovery', '8A'), true);

    const resumed = studentService.recoverStudentSession(exam.kode_ujian, 'Siswa Recovery', '8A', first.studentRecoveryToken);
    assert.equal(resumed.pengerjaanId, first.pengerjaanId);
    assert.notEqual(resumed.studentSessionToken, first.studentSessionToken);
    assert.equal(resumed.studentRecoveryToken, first.studentRecoveryToken);
    assert.equal(studentService.verifyStudentSession(first.pengerjaanId, first.studentSessionToken), null);
    assert.ok(studentService.verifyStudentSession(first.pengerjaanId, resumed.studentSessionToken));
    assert.equal(studentService.verifyStudentRecoveryToken(first.pengerjaanId, first.studentRecoveryToken, 'Siswa Lain', '8A'), false);
    db.prepare("UPDATE pengerjaan SET disconnected_at = datetime('now', '-61 minutes'), last_active_at = datetime('now', '-61 minutes') WHERE id = ?").run(first.pengerjaanId);
    assert.equal(studentService.verifyStudentRecoveryToken(first.pengerjaanId, first.studentRecoveryToken, 'Siswa Recovery', '8A'), false);
    assert.equal(question.id > 0, true);
  } finally {
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(exam.id);
  }
});

test('HTTP recovery route accepts the token and returns the original attempt', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: unique('HTTP Recovery Token'),
    mata_pelajaran: 'Bahasa',
    tingkat_kelas: '9A',
    durasi_menit: 60
  });
  examService.createSoal(exam.id, {
    nomor: 1,
    jenis: 'isian',
    pertanyaan: 'Jawaban?',
    bobot: 100,
    kunci_jawaban: 'ya'
  });
  examService.updateStatusUlangan(exam.id, 'dibuka');
  const first = studentService.startExam(exam.kode_ujian, 'Siswa HTTP Recovery', '9A');

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  t.after(() => {
    server.close();
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(exam.id);
  });

  const response = await fetch(`http://localhost:${server.address().port}/api/siswa/pulihkan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kode_ujian: exam.kode_ujian,
      nama: 'Siswa HTTP Recovery',
      kelas: '9A',
      recovery_token: first.studentRecoveryToken
    })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.pengerjaanId, first.pengerjaanId);
  assert.equal(body.studentRecoveryToken, first.studentRecoveryToken);
});

test('remedial recovery keeps a persisted ten minute deadline', () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: unique('Remedial Recovery Deadline'),
    mata_pelajaran: 'Bahasa',
    tingkat_kelas: '7A',
    durasi_menit: 60,
    remedial_langsung: 1,
    kkm: 75
  });
  const question = examService.createSoal(exam.id, {
    nomor: 1,
    jenis: 'pilihan_ganda',
    pertanyaan: 'Pilih?',
    bobot: 100,
    kunci_pg: 'A',
    opsi_a: 'Benar',
    opsi_b: 'Salah'
  });
  examService.updateStatusUlangan(exam.id, 'dibuka');

  try {
    const first = studentService.startExam(exam.kode_ujian, 'Siswa Remedial Recovery', '7A');
    studentService.submitExam(first.pengerjaanId, [{ soal_id: question.id, jawaban_siswa: 'B' }], 0, false, null, first.studentSessionToken);
    db.prepare('UPDATE pengerjaan SET released_at = CURRENT_TIMESTAMP, nilai_final = 0 WHERE id = ?').run(first.pengerjaanId);

    const remedial = studentService.startDirectRemedial(first.pengerjaanId, { nama: 'Siswa Remedial Recovery', kelas: '7A' }, first.studentSessionToken);
    assert.match(remedial.deadline_at, /T/);
    const deadline = new Date(remedial.deadline_at).getTime();
    assert.ok(deadline > Date.now());
    assert.ok(deadline - Date.now() <= 10 * 60 * 1000 + 2000);

    const resumed = studentService.getActiveSession(first.pengerjaanId, remedial.studentSessionToken);
    assert.equal(resumed.deadline_at, remedial.deadline_at);
  } finally {
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(exam.id);
  }
});

test('released class ranking uses one row per student and the best released attempt', () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: unique('Ranking Accuracy'),
    mata_pelajaran: 'Matematika',
    tingkat_kelas: '8B',
    durasi_menit: 60,
    maksimal_percobaan: 2,
    kebijakan_nilai: 'tertinggi'
  });
  const question = examService.createSoal(exam.id, {
    nomor: 1,
    jenis: 'pilihan_ganda',
    pertanyaan: 'Pilih?',
    bobot: 100,
    kunci_pg: 'A',
    opsi_a: 'Benar',
    opsi_b: 'Salah'
  });
  examService.updateStatusUlangan(exam.id, 'dibuka');

  try {
    const a1 = studentService.startExam(exam.kode_ujian, 'Siswa Ranking A', '8B');
    studentService.submitExam(a1.pengerjaanId, [{ soal_id: question.id, jawaban_siswa: 'B' }], 0, false, null, a1.studentSessionToken);
    db.prepare('UPDATE pengerjaan SET released_at = CURRENT_TIMESTAMP, nilai_final = 40 WHERE id = ?').run(a1.pengerjaanId);

    const a2 = studentService.startExam(exam.kode_ujian, 'Siswa Ranking A', '8B', null, true, a1.studentSessionToken, true, a1.pengerjaanId, a1.studentSessionToken);
    studentService.submitExam(a2.pengerjaanId, [{ soal_id: question.id, jawaban_siswa: 'A' }], 0, false, null, a2.studentSessionToken);
    db.prepare('UPDATE pengerjaan SET released_at = CURRENT_TIMESTAMP, nilai_final = 90 WHERE id = ?').run(a2.pengerjaanId);

    const b = studentService.startExam(exam.kode_ujian, 'Siswa Ranking B', '8B');
    studentService.submitExam(b.pengerjaanId, [{ soal_id: question.id, jawaban_siswa: 'B' }], 0, false, null, b.studentSessionToken);
    db.prepare('UPDATE pengerjaan SET released_at = CURRENT_TIMESTAMP, nilai_final = 70 WHERE id = ?').run(b.pengerjaanId);

    const status = studentService.getPengerjaanStatus(a2.pengerjaanId, a2.studentSessionToken);
    assert.equal(status.rekapNilaiKelas.length, 2);
    assert.deepEqual(status.rekapNilaiKelas.map(row => [row.nama, row.nilai, row.ranking]), [
      ['Siswa Ranking A', 90, 1],
      ['Siswa Ranking B', 70, 2]
    ]);
  } finally {
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(exam.id);
  }
});
