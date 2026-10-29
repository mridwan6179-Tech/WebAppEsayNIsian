const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const studentService = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'studentService.js'), 'utf8');

function functionSource(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.notEqual(start, -1, `marker tidak ditemukan: ${startMarker}`);
  assert.notEqual(end, -1, `marker tidak ditemukan: ${endMarker}`);
  return html.slice(start, end);
}

test('exam-code token query parameter is never stored as a student session token', () => {
  assert.match(html, /const paramStudentToken = urlParams\.get\('student_session_token'\);/);
  assert.doesNotMatch(html, /const paramStudentToken = urlParams\.get\('student_session_token'\)\s*\|\|\s*urlParams\.get\('token'\)/);
});

test('invalid resume sessions return to student authentication instead of retrying forever', () => {
  const source = functionSource('async function resumeOrCheckSession', 'window.retryResumeSession');
  assert.match(source, /if \(res\.status === 401\)/);
  assert.match(source, /window\.clearCurrentStudentSession\(\);/);
  assert.match(source, /stepAuth\.classList\.remove\('hidden'\)/);
  assert.match(source, /showAlert\(/);
});

test('invalid result sessions stop polling and return to student authentication', () => {
  const source = functionSource('async function checkResultStatusWithRetry', '// Kompatibilitas fungsi pemanggilan lama');
  assert.match(source, /if \(res\.status === 401\)/);
  assert.match(source, /window\.clearCurrentStudentSession\(\);/);
  assert.match(source, /stepAuth\.classList\.remove\('hidden'\)/);
  assert.match(source, /showAlert\(/);
});

test('new HTTP attempts do not adopt an arbitrary client supplied session token', () => {
  const startRoute = server.slice(
    server.indexOf("app.post('/api/siswa/mulai'"),
    server.indexOf('// Polling status antrean ruang tunggu siswa')
  );
  const queueRoute = server.slice(
    server.indexOf("app.get('/api/siswa/antrean/:ticketId'"),
    server.indexOf("app.post('/api/siswa/submit'")
  );

  assert.match(startRoute, /const studentSessionToken = studentService\.generateStudentSessionToken\(\);/);
  assert.doesNotMatch(startRoute, /getStudentSessionToken\(req\)/);
  assert.match(startRoute, /studentService\.startExam\(kode_ujian, nama, kelas, sesi_id, Boolean\(is_retake\), studentSessionToken \|\| null, true\)/);
  assert.doesNotMatch(server, /req\.query\.token/);
  assert.match(queueRoute, /studentService\.startExam\(ticket\.kodeUjian, ticket\.nama, ticket\.kelas, ticket\.sesiId, Boolean\(ticket\.isRetake\), ticket\.studentSessionToken \|\| null, true/);
});

test('a new exam-code URL never auto-resumes the previous browser attempt', () => {
  const recovery = functionSource('// Pemulihan Sesi Pengerjaan Tersimpan', 'async function checkKodeUlangan');
  assert.match(recovery, /currentPengerjaanId\s*&&\s*!directParamKode/);
});

test('submit treats an invalid session as a login reset instead of a network retry', () => {
  const submit = functionSource('async function doSubmit', '// Resume sesi pengerjaan aktif siswa');
  assert.match(submit, /res\.status === 401/);
  assert.match(submit, /window\.clearCurrentStudentSession\(\);/);
  assert.match(submit, /stepAuth\.classList\.remove\('hidden'\)/);
  assert.match(submit, /showAlert\(/);
});

test('submit retries only transient server responses', () => {
  const submit = functionSource('async function doSubmit', '// Resume sesi pengerjaan aktif siswa');
  assert.match(submit, /retryableSubmitStatuses/);
  assert.match(submit, /408/);
  assert.match(submit, /429/);
  assert.match(submit, /500/);
  assert.doesNotMatch(submit, /if \(!res\.ok && submitAttempt < maxSubmitAttempts\)/);
});

test('successful submit removes the persisted attempt handle before a shared-browser refresh', () => {
  assert.match(html, /function forgetPersistedStudentAttempt\(\)/);
  const submit = functionSource('async function doSubmit', '// Resume sesi pengerjaan aktif siswa');
  assert.match(submit, /forgetPersistedStudentAttempt\(\);/);
  assert.match(html, /currentPengerjaanId && !directParamKode/);
});

test('active student sessions are scoped to the browser tab instead of shared local storage', () => {
  assert.match(html, /function readStudentSessionValue\(key\)[\s\S]*sessionStorage\.getItem\(key\)/);
  assert.match(html, /const studentAttemptKey = 'ulangan_pengerjaan_id';/);
  assert.match(html, /const studentSessionTokenKey = 'ulangan_student_session_token';/);
  assert.match(html, /localStorage\.removeItem\('ulangan_pengerjaan_id'\)/);
  assert.match(html, /sessionStorage\.removeItem\(studentSessionTokenKey\)/);
  assert.doesNotMatch(html, /localStorage\.(getItem|setItem)\('ulangan_pengerjaan_id'/);
  assert.doesNotMatch(html, /localStorage\.(getItem|setItem)\(studentSessionTokenKey\)/);
  assert.doesNotMatch(html, /let currentPengerjaanId = localStorage\.getItem\('ulangan_pengerjaan_id'\)/);
  assert.doesNotMatch(html, /let currentStudentSessionToken = localStorage\.getItem\(studentSessionTokenKey\)/);
});

test('student async responses and drafts stay bound to the active tab session', () => {
  assert.match(html, /studentSessionEpoch/);
  assert.match(html, /isActiveStudentContext/);
  assert.match(html, /sessionStorage\.getItem\(draftKey\)/);
  assert.match(html, /sessionStorage\.setItem\(draftKey/);
  assert.match(html, /sessionStorage\.getItem\(backupKey\)/);
  assert.match(html, /sessionStorage\.setItem\(backupKey/);
  assert.doesNotMatch(html, /localStorage\.getItem\(draftKey\)/);
  assert.doesNotMatch(html, /localStorage\.setItem\(draftKey/);

  const resultPolling = functionSource('async function checkResultStatusWithRetry', '// Kompatibilitas fungsi pemanggilan lama');
  const resume = functionSource('async function resumeOrCheckSession', 'window.retryResumeSession');
  const submit = functionSource('async function doSubmit', '// Resume sesi pengerjaan aktif siswa');
  assert.match(resultPolling, /isActiveStudentContext/);
  assert.match(resume, /isActiveStudentContext/);
  assert.match(submit, /isActiveStudentContext/);
});

test('waiting-room tickets survive a refresh within the same browser tab', () => {
  assert.match(html, /studentQueueTicketKey/);
  assert.match(html, /sessionStorage\.setItem\(studentQueueTicketKey/);
  assert.match(html, /sessionStorage\.removeItem\(studentQueueTicketKey/);
  assert.match(html, /showWaitingRoom\(\{ ticketId: activeTicketId/);
});

test('student history is scoped to the verified participant record', () => {
  const history = studentService.slice(
    studentService.indexOf('getStudentExamHistory(pengerjaanId'),
    studentService.indexOf('// Mengambil sesi pengerjaan aktif siswa')
  );
  assert.match(history, /verifyStudentSession\(pengerjaanId, studentSessionToken\)/);
  assert.match(history, /current_identity/);
  assert.match(history, /LOWER\(TRIM\(pes\.nama\)\)/);
  assert.match(history, /LOWER\(TRIM\(pes\.kelas\)\)/);
  assert.match(history, /\.all\(pengerjaanId\)/);
});

test('retake sends the current attempt proof back to the server', () => {
  const retake = functionSource('async function doRetakeExam', '// Muat Riwayat Nilai Ulangan Siswa');
  assert.match(retake, /pengerjaan_id:\s*currentPengerjaanId/);
  assert.match(retake, /student_session_token:\s*getStudentSessionToken\(\)/);
});

test('remedial submit clears its loading state when the tab context changes mid-request', () => {
  const submit = functionSource('async function doSubmit', '// Resume sesi pengerjaan aktif siswa');
  assert.match(submit, /if \(!isActiveStudentContext\(submitContext\)\) \{[\s\S]*?resetSubmitUi\(\);[\s\S]*?return;/);
});

test('auto-submit clears a pre-existing loading state when its session context is stale', () => {
  const submit = functionSource('async function doSubmit', '// Resume sesi pengerjaan aktif siswa');
  assert.match(submit, /const submitContext = captureStudentContext\(currentPengerjaanId\);\s*if \(!isActiveStudentContext\(submitContext\)\) \{[\s\S]*?resetSubmitUi\(\);\s*return;/);
});

test('submit timeout remains active while the response body is being decoded', () => {
  const submit = functionSource('async function doSubmit', '// Resume sesi pengerjaan aktif siswa');
  assert.match(submit, /data = await res\.json\(\);[\s\S]*?clearTimeout\(timeoutId\);/);
  assert.doesNotMatch(submit, /clearTimeout\(timeoutId\);\s*data = await res\.json\(\);/);
});

test('starting remedial has a bounded request so its button cannot spin forever', () => {
  const remedial = functionSource('async function startDirectRemedial', "\n    document.getElementById('btn-start-direct-remedial')?.addEventListener");
  assert.match(remedial, /new AbortController\(\)/);
  assert.match(remedial, /setTimeout\(\(\) => controller\.abort\(\),/);
  assert.match(remedial, /signal: controller\.signal/);
  assert.match(remedial, /clearTimeout\(remedialTimeoutId\)/);
});

test('result polling timeout remains active while the result body is being decoded', () => {
  const polling = functionSource('async function checkResultStatusWithRetry', '// Kompatibilitas fungsi pemanggilan lama');
  assert.match(polling, /const result = await res\.json\(\);[\s\S]*?clearTimeout\(timeoutId\);/);
  assert.doesNotMatch(polling, /clearTimeout\(timeoutId\);\s*const result = await res\.json\(\);/);
});

test('starting remedial clears drafts from both browser storage scopes', () => {
  const remedial = functionSource('async function startDirectRemedial', "\n    document.getElementById('btn-start-direct-remedial')?.addEventListener");
  assert.match(remedial, /for \(const storage of \[sessionStorage, localStorage\]\)/);
  assert.match(remedial, /storage\.removeItem\(`ulangan_draft_\$\{pid\}`\)/);
});
