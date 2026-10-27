const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
const queueSource = fs.readFileSync(path.join(repoRoot, 'src', 'services', 'waitingRoomService.js'), 'utf8');
const studentSource = fs.readFileSync(path.join(repoRoot, 'src', 'services', 'studentService.js'), 'utf8');
const browserSource = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const waitingRoomService = require('../src/services/waitingRoomService');
const app = require('../server');
const http = require('node:http');

function unique(value) {
  return `${value}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test('submit route deduplicates retries instead of running a queue timeout fallback', () => {
  assert.match(serverSource, /inFlightStudentSubmits/);
  assert.match(serverSource, /inFlightStudentSubmits\.set\(/);
  assert.match(serverSource, /inFlightStudentSubmits\.get\(/);
  assert.doesNotMatch(serverSource, /memproses submit langsung/);
  assert.doesNotMatch(serverSource, /result = studentService\.submitExam\(pengerjaan_id/);
});

test('submit queue keeps accepted work alive until it completes', () => {
  const start = queueSource.indexOf('queueSubmit(submitFn)');
  const end = queueSource.indexOf('getSubmitQueueLength()', start);
  const submitQueueSource = queueSource.slice(start, end);
  assert.doesNotMatch(submitQueueSource, /Batas waktu antrean submit terlampaui/);
  assert.doesNotMatch(submitQueueSource, /setTimeout\(\(\) => \{/);
});

test('submit overload returns a retryable queue status instead of crashing the app', () => {
  assert.match(serverSource, /submit_queued:\s*true/);
  assert.match(serverSource, /retry_after_ms:\s*2000/);
  assert.match(browserSource, /retryableSubmitStatuses = new Set\(\[408, 425, 429, 500, 502, 503, 504\]\)/);
});

test('database submit claim protects an attempt across server instances', () => {
  assert.match(studentSource, /submit_lock_token/);
  assert.match(studentSource, /status = 'mengerjakan'/);
  assert.match(studentSource, /SUBMIT_IN_PROGRESS/);
  assert.match(studentSource, /claimSubmitSlotRelease/);
  assert.match(studentSource, /submit_slot_released_at/);
});

test('late autosave cannot overwrite a payload while submit is claimed', () => {
  assert.match(studentSource, /pengerjaan\.submit_lock_token/);
  assert.match(studentSource, /submitInProgress/);
  const remedialStart = studentSource.indexOf('startDirectRemedial(');
  const remedialEnd = studentSource.indexOf('// Pembersihan Otomatis', remedialStart);
  assert.match(studentSource.slice(remedialStart, remedialEnd), /submit_slot_released_at = NULL/);
});

test('refresh after a completed submit removes the persisted attempt handle', () => {
  const resumeStart = browserSource.indexOf('async function resumeOrCheckSession');
  const resumeEnd = browserSource.indexOf('window.retryResumeSession', resumeStart);
  const resumeSource = browserSource.slice(resumeStart, resumeEnd);
  assert.match(resumeSource, /result\.data\.alreadySubmitted/);
  assert.match(resumeSource, /forgetPersistedStudentAttempt\(\)/);
  assert.match(browserSource, /function forgetPersistedStudentAttempt\(\)[\s\S]*sessionStorage\.removeItem\(studentAttemptKey\)/);
  assert.match(browserSource, /function forgetPersistedStudentAttempt\(\)[\s\S]*sessionStorage\.removeItem\(studentSessionTokenKey\)/);
});

test('already-submitted retry releases the exam slot for queued students', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: unique('Submit Slot Recovery'),
    mata_pelajaran: 'Bahasa',
    tingkat_kelas: '9A',
    durasi_menit: 60
  });
  const soal = examService.createSoal(exam.id, {
    nomor: 1,
    jenis: 'isian',
    pertanyaan: 'Jawaban?',
    bobot: 100,
    kunci_jawaban: 'ya'
  });
  examService.updateStatusUlangan(exam.id, 'dibuka');
  const session = studentService.startExam(exam.kode_ujian, unique('Slot Recovery'), '9A');
  studentService.submitExam(session.pengerjaanId, [{ soal_id: soal.id, jawaban_siswa: 'ya' }], 0, false, null, session.studentSessionToken);

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  t.after(() => {
    server.close();
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(exam.id);
  });

  const originalReleaseSlot = waitingRoomService.releaseSlot;
  const released = [];
  waitingRoomService.releaseSlot = (ulanganId) => released.push(Number(ulanganId));
  t.after(() => { waitingRoomService.releaseSlot = originalReleaseSlot; });

  const response = await fetch(`http://localhost:${server.address().port}/api/siswa/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Student-Session-Token': session.studentSessionToken
    },
    body: JSON.stringify({
      pengerjaan_id: session.pengerjaanId,
      jawaban: [{ soal_id: soal.id, jawaban_siswa: 'ya' }]
    })
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).alreadySubmitted, true);

  const duplicateResponse = await fetch(`http://localhost:${server.address().port}/api/siswa/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Student-Session-Token': session.studentSessionToken
    },
    body: JSON.stringify({
      pengerjaan_id: session.pengerjaanId,
      jawaban: [{ soal_id: soal.id, jawaban_siswa: 'ya' }]
    })
  });
  assert.equal(duplicateResponse.status, 200);
  assert.equal((await duplicateResponse.json()).alreadySubmitted, true);
  assert.deepEqual(released, [exam.id]);
});

test('10 peserta dapat submit ujian campuran 30 soal bersamaan tanpa tertukar', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: unique('Stress 30 Soal'),
    mata_pelajaran: 'Informatika',
    tingkat_kelas: '10A',
    durasi_menit: 90,
    skor_langsung_ai: 1,
    maksimal_percobaan: 2,
    kebijakan_nilai: 'tertinggi'
  });
  const questions = [];
  try {
    for (let i = 0; i < 10; i++) {
      questions.push(examService.createSoal(exam.id, {
        jenis: 'pilihan_ganda', nomor: i + 1, bobot: 2,
        pertanyaan: `PG ${i + 1}`, kunci_pg: i % 2 ? 'B' : 'A',
        opsi_a: 'A', opsi_b: 'B', opsi_c: 'C', opsi_d: 'D'
      }));
    }
    for (let i = 0; i < 5; i++) {
      questions.push(examService.createSoal(exam.id, {
        jenis: 'pilihan_ganda', nomor: 11 + i, bobot: 2,
        pertanyaan: `PG Kompleks ${i + 1}`, kunci_pg: 'A,C',
        opsi_a: 'A', opsi_b: 'B', opsi_c: 'C', opsi_d: 'D'
      }));
    }
    for (let i = 0; i < 5; i++) {
      questions.push(examService.createSoal(exam.id, {
        jenis: 'isian', nomor: 16 + i, bobot: 2,
        pertanyaan: `Isian ${i + 1}`, kunci_jawaban: 'jawaban',
        is_listening: i === 0 ? 1 : 0, audio_script: i === 0 ? 'audio' : null
      }));
    }
    for (let i = 0; i < 5; i++) {
      questions.push(examService.createSoal(exam.id, {
        jenis: 'essay', nomor: 21 + i, bobot: 2,
        pertanyaan: `Essay ${i + 1}`, kunci_jawaban: 'jawaban',
        is_listening: i === 0 ? 1 : 0, audio_script: i === 0 ? 'audio' : null
      }));
    }
    const game = require('../src/services/codingGameService').getPresets()[0];
    for (let i = 0; i < 5; i++) {
      questions.push(examService.createSoal(exam.id, {
        jenis: 'koding_game', nomor: 26 + i, bobot: 2,
        pertanyaan: `Koding ${i + 1}`, game_data: game
      }));
    }
    examService.updateStatusUlangan(exam.id, 'dibuka');

    const sessions = Array.from({ length: 10 }, (_, index) =>
      studentService.startExam(exam.kode_ujian, unique(`Stress Siswa ${index + 1}`), '10A')
    );
    assert.equal(new Set(sessions.map(s => s.pengerjaanId)).size, 10);

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    t.after(() => server.close());
    const baseUrl = `http://localhost:${server.address().port}`;
    const submit = session => fetch(`${baseUrl}/api/siswa/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Student-Session-Token': session.studentSessionToken },
      body: JSON.stringify({
        pengerjaan_id: session.pengerjaanId,
        jawaban: questions.map((question, index) => ({
          soal_id: question.id,
          jawaban_siswa: question.jenis === 'pilihan_ganda' ? (index % 2 ? 'B' : 'A') : `jawaban-${session.peserta.nama || session.pengerjaanId}`
        }))
      })
    }).then(async response => ({ status: response.status, body: await response.json() }));

    const results = await Promise.all(sessions.map(submit));
    assert.ok(results.every(result => result.status === 200 && result.body.success));
    for (const session of sessions) {
      const attempt = db.prepare('SELECT status FROM pengerjaan WHERE id = ?').get(session.pengerjaanId);
      const answerCount = db.prepare('SELECT COUNT(*) AS c FROM jawaban WHERE pengerjaan_id = ?').get(session.pengerjaanId);
      assert.equal(attempt.status, 'submitted');
      assert.equal(Number(answerCount.c), 30);
    }

  } finally {
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(exam.id);
  }
});

