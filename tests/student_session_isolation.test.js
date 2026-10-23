const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const app = require('../server');

function unique(value) {
  return `${value}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test('student attempt token isolates shared lab sessions', () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: unique('Isolasi Lab'),
    mata_pelajaran: 'Informatika',
    tingkat_kelas: '8',
    durasi_menit: 60
  });
  const soal = examService.createSoal(exam.id, {
    nomor: 1,
    jenis: 'isian',
    pertanyaan: 'Sebutkan warna langit.',
    bobot: 100,
    kunci_jawaban: 'Biru'
  });
  examService.updateUlangan(exam.id, guru.id, { status: 'dibuka' });

  try {
    const siswaA = studentService.startExam(exam.kode_ujian, unique('Siswa A'), '8A');
    const siswaB = studentService.startExam(exam.kode_ujian, unique('Siswa B'), '8A');

    assert.match(siswaA.studentSessionToken, /^[A-Za-z0-9_-]{40,}$/);
    assert.match(siswaB.studentSessionToken, /^[A-Za-z0-9_-]{40,}$/);
    assert.notEqual(siswaA.studentSessionToken, siswaB.studentSessionToken);
    assert.equal(studentService.verifyStudentSession(siswaA.pengerjaanId, siswaA.studentSessionToken).id, siswaA.pengerjaanId);
    assert.equal(studentService.verifyStudentSession(siswaA.pengerjaanId, siswaB.studentSessionToken), null);
    assert.equal(studentService.verifyStudentSession(siswaA.pengerjaanId, null), null);

    const persisted = db.prepare('SELECT student_session_token FROM pengerjaan WHERE id = ?').get(siswaA.pengerjaanId);
    assert.equal(persisted.student_session_token, siswaA.studentSessionToken);
  } finally {
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(exam.id);
  }
});

test('student HTTP routes reject stale or cross-owner tokens', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: unique('Isolasi HTTP'),
    mata_pelajaran: 'Bahasa',
    tingkat_kelas: '9',
    durasi_menit: 60
  });
  const soal = examService.createSoal(exam.id, {
    nomor: 1,
    jenis: 'isian',
    pertanyaan: 'Sebutkan warna langit.',
    bobot: 100,
    kunci_jawaban: 'Biru'
  });
  examService.updateUlangan(exam.id, guru.id, { status: 'dibuka' });

  const siswaA = studentService.startExam(exam.kode_ujian, unique('Siswa A'), '9A');
  const siswaB = studentService.startExam(exam.kode_ujian, unique('Siswa B'), '9A');
  let server;
  let baseUrl;

  await new Promise(resolve => {
    server = http.createServer(app);
    server.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  t.after(() => {
    server.close();
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(exam.id);
  });

  const request = (path, options = {}) => fetch(`${baseUrl}${path}`, options);
  const jsonHeaders = (token) => ({
    'Content-Type': 'application/json',
    ...(token ? { 'X-Student-Session-Token': token } : {})
  });

  await t.test('resume requires the owner token', async () => {
    const missing = await request(`/api/siswa/sesi/${siswaA.pengerjaanId}`);
    assert.equal(missing.status, 401);
    const cross = await request(`/api/siswa/sesi/${siswaA.pengerjaanId}`, {
      headers: { 'X-Student-Session-Token': siswaB.studentSessionToken }
    });
    assert.equal(cross.status, 401);
    const own = await request(`/api/siswa/sesi/${siswaA.pengerjaanId}`, {
      headers: { 'X-Student-Session-Token': siswaA.studentSessionToken }
    });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).data.pengerjaanId, siswaA.pengerjaanId);
  });

  await t.test('draft, heartbeat, result, history, and submit reject cross-owner writes/reads', async () => {
    const draft = await request('/api/siswa/draft', {
      method: 'POST',
      headers: jsonHeaders(siswaB.studentSessionToken),
      body: JSON.stringify({ pengerjaan_id: siswaA.pengerjaanId, jawaban: [{ soal_id: soal.id, jawaban_siswa: 'salah' }] })
    });
    assert.equal(draft.status, 401);

    const ping = await request('/api/siswa/ping', {
      method: 'POST',
      headers: jsonHeaders(siswaB.studentSessionToken),
      body: JSON.stringify({ pengerjaan_id: siswaA.pengerjaanId, status: 'active' })
    });
    assert.equal(ping.status, 401);

    const result = await request(`/api/siswa/hasil/${siswaA.pengerjaanId}`, {
      headers: { 'X-Student-Session-Token': siswaB.studentSessionToken }
    });
    assert.equal(result.status, 401);

    const history = await request(`/api/siswa/riwayat/${siswaA.pengerjaanId}`, {
      headers: { 'X-Student-Session-Token': siswaB.studentSessionToken }
    });
    assert.equal(history.status, 401);

    const submit = await request('/api/siswa/submit', {
      method: 'POST',
      headers: jsonHeaders(siswaB.studentSessionToken),
      body: JSON.stringify({ pengerjaan_id: siswaA.pengerjaanId, jawaban: [{ soal_id: soal.id, jawaban_siswa: 'salah' }] })
    });
    assert.equal(submit.status, 401);

    const ownDraft = await request('/api/siswa/draft', {
      method: 'POST',
      headers: jsonHeaders(siswaA.studentSessionToken),
      body: JSON.stringify({ pengerjaan_id: siswaA.pengerjaanId, jawaban: [{ soal_id: soal.id, jawaban_siswa: 'Biru' }] })
    });
    assert.equal(ownDraft.status, 200);
  });
});

test('browser binds protected requests to the student token lifecycle', () => {
  const html = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /ulangan_student_session_token/);
  assert.match(html, /X-Student-Session-Token/);
  assert.match(html, /student_session_token: getStudentSessionToken\(\)/);
  assert.match(html, /localStorage\.removeItem\(studentSessionTokenKey\)/);
});

test('student history stays scoped to participant id even when names and classes match', () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: unique('Riwayat Identitas Sama'),
    mata_pelajaran: 'Matematika',
    tingkat_kelas: '8',
    durasi_menit: 60
  });
  const soal = examService.createSoal(exam.id, {
    nomor: 1,
    jenis: 'isian',
    pertanyaan: 'Berapakah 2 + 2?',
    bobot: 100,
    kunci_jawaban: '4'
  });
  examService.updateUlangan(exam.id, guru.id, { status: 'dibuka' });

  try {
    const tokenA = studentService.generateStudentSessionToken();
    const tokenB = studentService.generateStudentSessionToken();
    const siswaA = studentService.startExam(exam.kode_ujian, 'Siswa Sama', '8A', null, false, tokenA, true);
    const siswaB = studentService.startExam(exam.kode_ujian, 'Siswa Sama', '8A', null, false, tokenB, true);

    studentService.submitExam(siswaA.pengerjaanId, [{ soal_id: soal.id, jawaban_siswa: '4' }], 0, false, null, siswaA.studentSessionToken);
    studentService.submitExam(siswaB.pengerjaanId, [{ soal_id: soal.id, jawaban_siswa: '3' }], 0, false, null, siswaB.studentSessionToken);

    const historyA = studentService.getStudentExamHistory(siswaA.pengerjaanId, siswaA.studentSessionToken);
    const historyB = studentService.getStudentExamHistory(siswaB.pengerjaanId, siswaB.studentSessionToken);

    assert.ok(historyA.every(item => item.pengerjaanId !== siswaB.pengerjaanId));
    assert.ok(historyB.every(item => item.pengerjaanId !== siswaA.pengerjaanId));
    assert.ok(historyA.some(item => item.pengerjaanId === siswaA.pengerjaanId));
    assert.ok(historyB.some(item => item.pengerjaanId === siswaB.pengerjaanId));
  } finally {
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(exam.id);
  }
});

