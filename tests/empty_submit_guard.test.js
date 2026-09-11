const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');

test('Empty Submit Guard Test Suite', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();

  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Uji Guard Submit Kosong',
    mata_pelajaran: 'PKN',
    tingkat_kelas: 'Kelas 9',
    durasi_menit: 60
  });

  const soal1 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Apa itu Pancasila?',
    jenis: 'isian',
    bobot: 50,
    kunci_jawaban: 'Dasar negara Indonesia'
  });

  const soal2 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Jelaskan sila ke-1!',
    jenis: 'essay',
    bobot: 50,
    kunci_jawaban: 'Ketuhanan Yang Maha Esa'
  });

  examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

  const ulanganData = db.prepare('SELECT * FROM ulangan WHERE id = ?').get(ulangan.id);
  const NAMA = 'Siswa Guard Test';
  const KELAS = 'Kelas 9A';

  // ── T-01: Submit manual dengan jawaban array kosong [] ditolak ──────────────
  await t.test('T-01: submit manual jawaban [] ditolak, status tetap mengerjakan', () => {
    const sesi = studentService.startExam(ulanganData.kode_ujian, NAMA, KELAS);
    const pengerjaanId = sesi.pengerjaanId;

    const result = studentService.submitExam(pengerjaanId, [], 0, false);

    assert.equal(result.success, false, 'Harus gagal');
    assert.equal(result.empty, true, 'Harus ada flag empty=true');
    assert.ok(result.message.length > 0, 'Harus ada pesan error');

    const pengerjaan = db.prepare('SELECT status FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    assert.equal(pengerjaan.status, 'mengerjakan', 'Status harus tetap mengerjakan');
  });

  // ── T-02: Submit manual dengan semua jawaban string kosong ditolak ───────────
  await t.test('T-02: submit manual semua jawaban string kosong ditolak', () => {
    const sesi = studentService.startExam(ulanganData.kode_ujian, NAMA, KELAS);
    const pengerjaanId = sesi.pengerjaanId;

    const result = studentService.submitExam(pengerjaanId, [
      { soal_id: soal1.id, jawaban_siswa: '' },
      { soal_id: soal2.id, jawaban_siswa: '   ' }
    ], 0, false);

    assert.equal(result.success, false, 'Harus gagal');
    assert.equal(result.empty, true, 'Harus ada flag empty=true');

    const pengerjaan = db.prepare('SELECT status FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    assert.equal(pengerjaan.status, 'mengerjakan', 'Status harus tetap mengerjakan');
  });

  // ── T-03: Submit manual dengan minimal 1 jawaban terisi diterima ─────────────
  await t.test('T-03: submit manual dengan 1 jawaban terisi diterima', () => {
    const sesi = studentService.startExam(ulanganData.kode_ujian, NAMA, KELAS);
    const pengerjaanId = sesi.pengerjaanId;

    const result = studentService.submitExam(pengerjaanId, [
      { soal_id: soal1.id, jawaban_siswa: 'Dasar negara' },
      { soal_id: soal2.id, jawaban_siswa: '' }
    ], 0, false);

    assert.equal(result.success, true, 'Harus berhasil');

    const pengerjaan = db.prepare('SELECT status FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    assert.equal(pengerjaan.status, 'submitted', 'Status harus submitted');
  });

  // ── T-04: Auto-submit dengan jawaban kosong tetap diproses (waktu habis) ──────
  await t.test('T-04: auto-submit jawaban kosong tidak ditolak', () => {
    const sesi = studentService.startExam(ulanganData.kode_ujian, NAMA, KELAS);
    const pengerjaanId = sesi.pengerjaanId;

    const result = studentService.submitExam(pengerjaanId, [], 0, true);

    assert.equal(result.success, true, 'Auto-submit harus berhasil meski jawaban kosong');

    const pengerjaan = db.prepare('SELECT status FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    assert.equal(pengerjaan.status, 'submitted', 'Status harus submitted');
  });

  // ── T-05: Submit kosong tapi ada draft tersimpan di server → diterima ────────
  await t.test('T-05: submit kosong tapi ada draft di server diterima', () => {
    const sesi = studentService.startExam(ulanganData.kode_ujian, NAMA, KELAS);
    const pengerjaanId = sesi.pengerjaanId;

    // Simpan draft dulu seolah siswa sudah pernah mengisi dan disimpan otomatis
    studentService.saveDraft(pengerjaanId, [
      { soal_id: soal1.id, jawaban_siswa: 'Dasar negara Indonesia' }
    ]);

    // Submit manual dengan jawaban kosong (form kosong saat buka ulang browser)
    const result = studentService.submitExam(pengerjaanId, [], 0, false);

    // Ada draft di server → boleh submit (pakai data draft)
    assert.equal(result.success, true, 'Harus berhasil karena ada draft di server');

    const pengerjaan = db.prepare('SELECT status FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    assert.equal(pengerjaan.status, 'submitted', 'Status harus submitted');
  });
});
