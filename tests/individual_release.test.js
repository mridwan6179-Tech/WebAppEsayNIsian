const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const reviewService = require('../src/services/reviewService');
const studentService = require('../src/services/studentService');

test('Individual Student Release Test Suite', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();

  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Uji Rilis Nilai Perorangan',
    mata_pelajaran: 'Sejarah',
    tingkat_kelas: 'Kelas 11',
    durasi_menit: 60
  });

  const soal = examService.createSoal(ulangan.id, {
    pertanyaan: 'Kapan Proklamasi Kemerdekaan RI dibacakan?',
    jenis: 'isian',
    bobot: 100,
    kunci_jawaban: '17 Agustus 1945'
  });

  examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });
  const uDetail = examService.getUlanganById(ulangan.id, guru.id);

  // Siswa A
  const sA = studentService.startExam(uDetail.kode_ujian, 'Siswa Rilis A', '11 IPS 1');
  studentService.submitExam(sA.pengerjaanId, [{ soal_id: soal.id, jawaban_siswa: '17 Agustus 1945' }], 0, false);

  // Siswa B
  const sB = studentService.startExam(uDetail.kode_ujian, 'Siswa Rilis B', '11 IPS 1');
  studentService.submitExam(sB.pengerjaanId, [{ soal_id: soal.id, jawaban_siswa: '17 Agustus 1945' }], 0, false);

  // Siswa C (masih mengerjakan, belum submit)
  const sC = studentService.startExam(uDetail.kode_ujian, 'Siswa Rilis C', '11 IPS 1');

  // ── T-01: Awalnya semua belum dirilis ──────────────────────────────────────
  await t.test('T-01: Nilai awal belum dirilis (released_at = null)', () => {
    const list = reviewService.getPengerjaanListByUlangan(ulangan.id, guru.id);
    const rowA = list.find(p => p.pengerjaan_id === sA.pengerjaanId);
    const rowB = list.find(p => p.pengerjaan_id === sB.pengerjaanId);
    assert.equal(rowA.released_at, null);
    assert.equal(rowB.released_at, null);
  });

  // ── T-02: Rilis perorangan hanya merilis Siswa A, Siswa B tetap terkunci ─────
  await t.test('T-02: Rilis perorangan hanya membuka nilai Siswa A', () => {
    const res = reviewService.toggleReleaseSinglePengerjaan(sA.pengerjaanId, guru.id, true);
    assert.equal(res.success, true);
    assert.equal(res.isReleased, true);
    assert.ok(res.released_at !== null);

    const list = reviewService.getPengerjaanListByUlangan(ulangan.id, guru.id);
    const rowA = list.find(p => p.pengerjaan_id === sA.pengerjaanId);
    const rowB = list.find(p => p.pengerjaan_id === sB.pengerjaanId);
    assert.ok(rowA.released_at !== null, 'Siswa A harus sudah dirilis');
    assert.equal(rowB.released_at, null, 'Siswa B harus tetap terkunci');
  });

  // ── T-03: Rilis perorangan via toggleReleasePengerjaan dengan pengerjaanId ───
  await t.test('T-03: toggleReleasePengerjaan mendukung parameter pengerjaanId', () => {
    const res = reviewService.toggleReleasePengerjaan(ulangan.id, guru.id, true, null, sB.pengerjaanId);
    assert.equal(res.success, true);
    assert.equal(res.isReleased, true);

    const list = reviewService.getPengerjaanListByUlangan(ulangan.id, guru.id);
    const rowB = list.find(p => p.pengerjaan_id === sB.pengerjaanId);
    assert.ok(rowB.released_at !== null, 'Siswa B sekarang sudah dirilis');
  });

  // ── T-04: Tarik rilis perorangan hanya mengunci kembali Siswa A ───────────────
  await t.test('T-04: Tarik rilis perorangan hanya mengunci Siswa A kembali', () => {
    const res = reviewService.toggleReleaseSinglePengerjaan(sA.pengerjaanId, guru.id, false);
    assert.equal(res.success, true);
    assert.equal(res.isReleased, false);
    assert.equal(res.released_at, null);

    const list = reviewService.getPengerjaanListByUlangan(ulangan.id, guru.id);
    const rowA = list.find(p => p.pengerjaan_id === sA.pengerjaanId);
    const rowB = list.find(p => p.pengerjaan_id === sB.pengerjaanId);
    assert.equal(rowA.released_at, null, 'Siswa A harus ditarik kembali');
    assert.ok(rowB.released_at !== null, 'Siswa B tetap dirilis');
  });

  // ── T-05: Siswa yang belum submit dilarang dirilis ──────────────────────────
  await t.test('T-05: Menolak rilis untuk siswa yang belum submit ujian', () => {
    assert.throws(() => {
      reviewService.toggleReleaseSinglePengerjaan(sC.pengerjaanId, guru.id, true);
    }, /belum dapat dirilis karena ujian belum dikumpulkan/);
  });

  // ── T-06: Guru lain dilarang merilis pengerjaan siswa ────────────────────────
  await t.test('T-06: Ditolak jika pengerjaan bukan milik guru yang berwenang', () => {
    const invalidGuruId = 999999;
    assert.throws(() => {
      reviewService.toggleReleaseSinglePengerjaan(sB.pengerjaanId, invalidGuruId, false);
    }, /Data pengerjaan tidak ditemukan atau bukan milik guru ini/);
  });
});
