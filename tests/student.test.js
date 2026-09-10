const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');

test('T-03: Alur Siswa Masuk sampai Submit (FR-06 - FR-08, NFR-01)', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();

  // Setup ulangan untuk tes siswa
  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Harian Fisika',
    mata_pelajaran: 'Fisika',
    tingkat_kelas: 'Kelas 10'
  });

  const soal1 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Sebutkan satuan dari gaya dalam SI!',
    jenis: 'isian',
    bobot: 20,
    kunci_jawaban: 'Newton'
  });

  const soal2 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Jelaskan Hukum I Newton tentang kelembaman!',
    jenis: 'essay',
    bobot: 30,
    kunci_jawaban: 'Benda akan tetap diam atau bergerak lurus beraturan jika resultan gaya yang bekerja sama dengan nol.'
  });

  await t.test('FR-06: Ulangan berstatus draft ditolak saat siswa memasukkan kode', () => {
    const check = studentService.validateExamCode(ulangan.kode_ujian);
    assert.strictEqual(check.valid, false);
    assert.match(check.message, /belum dibuka/);
  });

  await t.test('FR-06: Membuka ulangan dan validasi kode berhasil', () => {
    examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });
    const check = studentService.validateExamCode(ulangan.kode_ujian);
    assert.strictEqual(check.valid, true);
    assert.strictEqual(check.ulangan.judul, 'Ulangan Harian Fisika');
    assert.strictEqual(check.ulangan.total_soal, 2);
  });

  let pengerjaanSession = null;

  await t.test('FR-07: Memulai pengerjaan - Nama dan kelas wajib, kunci jawaban tidak dibocorkan', () => {
    assert.throws(() => {
      studentService.startExam(ulangan.kode_ujian, '', 'X MIPA 1');
    }, /Nama siswa wajib diisi/);

    assert.throws(() => {
      studentService.startExam(ulangan.kode_ujian, 'Ahmad Fadhil', '');
    }, /Kelas siswa wajib diisi/);

    pengerjaanSession = studentService.startExam(ulangan.kode_ujian, 'Ahmad Fadhil', 'X MIPA 1');
    assert.ok(pengerjaanSession.pengerjaanId);
    assert.strictEqual(pengerjaanSession.alreadySubmitted, false);
    assert.strictEqual(pengerjaanSession.soal.length, 2);

    // Pastikan kunci_jawaban & rubrik TIDAK dibocorkan ke siswa
    for (const s of pengerjaanSession.soal) {
      assert.strictEqual(s.kunci_jawaban, undefined);
      assert.strictEqual(s.rubrik, undefined);
    }
  });

  await t.test('FR-08 & NFR-01: Submit jawaban tersimpan seketika tanpa koneksi AI', () => {
    const answers = [
      { soal_id: soal1.id, jawaban_siswa: 'Newton (N)' },
      { soal_id: soal2.id, jawaban_siswa: 'Jika tidak ada gaya luar yang bekerja, benda diam akan tetap diam dan yang bergerak akan tetap bergerak konstan.' }
    ];

    const submitResult = studentService.submitExam(pengerjaanSession.pengerjaanId, answers);
    assert.strictEqual(submitResult.success, true);
    assert.ok(submitResult.submitted_at);

    // Verifikasi di database bahwa status pengerjaan adalah submitted
    const pengerjaanDb = db.prepare('SELECT status, submitted_at FROM pengerjaan WHERE id = ?').get(pengerjaanSession.pengerjaanId);
    assert.strictEqual(pengerjaanDb.status, 'submitted');
    assert.ok(pengerjaanDb.submitted_at);

    // Verifikasi bahwa kedua jawaban tersimpan dengan status 'menunggu'
    const jawabanList = db.prepare('SELECT * FROM jawaban WHERE pengerjaan_id = ?').all(pengerjaanSession.pengerjaanId);
    assert.strictEqual(jawabanList.length, 2);
    for (const j of jawabanList) {
      assert.strictEqual(j.status_penilaian, 'menunggu');
      assert.ok(j.skor_maksimum > 0);
    }
  });

  await t.test('FR-07: Siswa yang sudah submit tidak dapat memulai ulang ujian', () => {
    const reStart = studentService.startExam(ulangan.kode_ujian, 'Ahmad Fadhil', 'X MIPA 1');
    assert.strictEqual(reStart.alreadySubmitted, true);
    assert.ok(reStart.submittedAt);
  });
});
