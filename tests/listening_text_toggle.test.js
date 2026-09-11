const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const bankSoalService = require('../src/services/bankSoalService');

test('T-26: Pengaturan Teks Listening oleh Guru/Admin (Disembunyikan secara Default / Ujian Listening Murni)', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  assert.ok(guru, 'Guru harus ada di database');

  // 1. Buat Ulangan Listening dengan default (tampilkan_teks_listening = 0)
  const exam = examService.createUlangan(guru.id, {
    judul: 'Ulangan Bahasa Inggris Listening Murni',
    mata_pelajaran: 'Bahasa Inggris',
    tingkat_kelas: '9A',
    tampilkan_teks_listening: 0
  });

  assert.strictEqual(exam.tampilkan_teks_listening, 0, 'Default tampilkan_teks_listening harus 0');

  // 2. Tambahkan butir soal listening dengan naskah script
  const soalListening = examService.createSoal(exam.id, {
    jenis: 'isian',
    pertanyaan: 'Where are they going tomorrow morning?',
    kunci_jawaban: 'National Museum',
    bobot: 20,
    is_listening: 1,
    audio_script: 'Attention students, tomorrow morning we will gather at school before heading to the National Museum.',
    bahasa: 'Bahasa Inggris'
  });

  assert.strictEqual(soalListening.is_listening, 1);

  // 3. Siswa mengecek kode ulangan (validateExamCode)
  examService.updateStatusUlangan(exam.id, 'dibuka');
  const validCheck = studentService.validateExamCode(exam.kode_ujian);
  assert.ok(validCheck.valid);
  assert.strictEqual(validCheck.ulangan.tampilkan_teks_listening, 0, 'Siswa harus menerima tampilkan_teks_listening = 0');

  // 4. Siswa memulai ujian (startExam)
  const startRes = studentService.startExam(exam.kode_ujian, 'Rudi Listening Test', '9A');
  assert.ok(startRes.soal && startRes.soal.length > 0);
  assert.strictEqual(startRes.ulangan.tampilkan_teks_listening, 0);

  // 5. Siswa melanjutkan sesi (getActiveSession)
  const sessionRes = studentService.getActiveSession(startRes.pengerjaanId);
  assert.ok(sessionRes && !sessionRes.alreadySubmitted);
  assert.strictEqual(sessionRes.ulangan.tampilkan_teks_listening, 0, 'Sesi aktif siswa harus membawa tampilkan_teks_listening = 0');

  // 6. Guru mengaktifkan naskah teks listening (updateUlangan -> 1)
  const examUpdated = examService.updateUlangan(exam.id, guru.id, {
    tampilkan_teks_listening: 1
  });
  assert.strictEqual(examUpdated.tampilkan_teks_listening, 1);

  // 7. Sesi siswa kini menerima opsi tampilkan teks = 1
  const sessionAfterToggle = studentService.getActiveSession(startRes.pengerjaanId);
  assert.strictEqual(sessionAfterToggle.ulangan.tampilkan_teks_listening, 1, 'Setelah diaktifkan guru, tampilkan_teks_listening siswa menjadi 1');

  // 8. Per-soal override test di updateSoal
  const soalUpdated = examService.updateSoal(soalListening.id, {
    tampilkan_teks_listening: 1
  });
  assert.strictEqual(soalUpdated.tampilkan_teks_listening, 1);

  // 9. Bank Soal copy & import preserves tampilkan_teks_listening
  const bankItem = bankSoalService.copyFromExamSoal(soalListening.id, guru.id, 'Bahasa Inggris');
  assert.strictEqual(bankItem.tampilkan_teks_listening, 1);

  // Clean up
  examService.deleteUlangan(exam.id, guru.id);
  bankSoalService.delete(bankItem.id, guru.id);
});
