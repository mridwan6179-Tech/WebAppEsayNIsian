const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const pinService = require('../src/services/pinService');

test('=== SUITE: SISTEM PIN SEKALI PAKAI & TOKEN KUOTA PESERTA LIVE ===', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();

  // 1. Setup ulangan dengan PIN aktif dan token ujian
  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Biologi Anti-Joki',
    mata_pelajaran: 'Biologi',
    tingkat_kelas: 'Kelas 8',
    pin_aktif: 1,
    token_ujian: 2 // Batas 2 peserta
  });

  examService.createSoal(ulangan.id, {
    pertanyaan: 'Fungsi klorofil pada tumbuhan adalah?',
    jenis: 'isian',
    bobot: 50,
    kunci_jawaban: 'Fotosintesis'
  });

  examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

  await t.test('1. Validasi Kode: Menyertakan status pin_aktif dan token_ujian', () => {
    const val = studentService.validateExamCode(ulangan.kode_ujian);
    assert.strictEqual(val.valid, true);
    assert.strictEqual(val.ulangan.pin_aktif, 1);
    assert.strictEqual(val.ulangan.token_ujian, 2);
  });

  await t.test('2. Generate Pool PIN: Guru dapat membuat pool PIN 6-digit', () => {
    const gen = pinService.generatePoolPins(ulangan.id, guru.id, 5);
    assert.strictEqual(gen.success, true);
    assert.strictEqual(gen.count, 5);
    assert.strictEqual(gen.pins.length, 5);
    gen.pins.forEach(p => {
      assert.strictEqual(p.length, 6);
      assert.match(p, /^[0-9]{6}$/);
    });

    const summary = pinService.getAllPins(ulangan.id, guru.id);
    assert.strictEqual(summary.total, 5);
    assert.strictEqual(summary.available, 5);
    assert.strictEqual(summary.used, 0);
  });

  let pinSiswa1 = null;
  let pinSiswa2 = null;

  await t.test('3. Validasi PIN Siswa: Siswa 1 mengklaim PIN dari pool', () => {
    const pins = pinService.getAllPins(ulangan.id, guru.id).data;
    pinSiswa1 = pins[0].pin;
    pinSiswa2 = pins[1].pin;

    // PIN salah / tidak ada di database ditolak
    const wrongCheck = pinService.validatePin(ulangan.id, 'Budi Santoso', '8A', '999999');
    assert.strictEqual(wrongCheck.valid, false);
    assert.match(wrongCheck.message, /tidak terdaftar/i);

    // PIN valid diklaim oleh Budi
    const budiCheck = pinService.validatePin(ulangan.id, 'Budi Santoso', '8A', pinSiswa1, 'dev_budi_phone');
    assert.strictEqual(budiCheck.valid, true);
    assert.strictEqual(budiCheck.reconnect, false);

    // PIN siswa 1 sekarang berstatus used
    const summary = pinService.getAllPins(ulangan.id, guru.id);
    assert.strictEqual(summary.used, 1);
    assert.strictEqual(summary.available, 4);

    // Budi sekarang bisa start exam
    const startBudi = studentService.startExam(ulangan.kode_ujian, 'Budi Santoso', '8A');
    assert.ok(startBudi.pengerjaanId);
  });

  await t.test('4. Anti-Joki / Sekali Pakai: Siswa lain ditolak memakai PIN yang sama', () => {
    // Siswa Siti mencoba memasukkan PIN yang sudah diklaim Budi
    const sitiCheck = pinService.validatePin(ulangan.id, 'Siti Aminah', '8A', pinSiswa1, 'dev_siti_laptop');
    assert.strictEqual(sitiCheck.valid, false);
    assert.strictEqual(sitiCheck.alreadyUsed, true);
    assert.match(sitiCheck.message, /sudah digunakan oleh Budi/i);
  });

  await t.test('5. Reconnect / Refresh: Siswa yang sama diizinkan lanjut dengan PIN yang sama', () => {
    // Budi reload browser dan memasukkan PIN yang sama
    const budiResume = pinService.validatePin(ulangan.id, 'Budi Santoso', '8A', pinSiswa1, 'dev_budi_phone');
    assert.strictEqual(budiResume.valid, true);
    assert.strictEqual(budiResume.reconnect, true);
  });

  await t.test('6. Start Exam Guard: Siswa ditolak startExam jika belum memasukkan PIN sah', () => {
    assert.throws(() => {
      studentService.startExam(ulangan.kode_ujian, 'Doni Tanpa PIN', '8A');
    }, /mewajibkan PIN/i);
  });

  await t.test('7. Token Limit & Live Token Addition: Guru dapat menambah token saat ujian live', () => {
    // Siswa 2 (Siti) klaim PIN 2
    const sitiCheck = pinService.validatePin(ulangan.id, 'Siti Aminah', '8A', pinSiswa2, 'dev_siti');
    assert.strictEqual(sitiCheck.valid, true);
    const startSiti = studentService.startExam(ulangan.kode_ujian, 'Siti Aminah', '8A');
    assert.ok(startSiti.pengerjaanId);

    // Sekarang sudah ada 2 peserta masuk (Budi & Siti). Batas token_ujian = 2!
    // Ambil PIN ke-3 untuk Siswa 3 (Eko)
    const pins = pinService.getAllPins(ulangan.id, guru.id).data;
    const pinSiswa3 = pins.find(p => !p.is_used).pin;

    // Siswa 3 klaim PIN tapi kuota token ujian (2) sudah penuh!
    const ekoCheck = pinService.validatePin(ulangan.id, 'Eko Prasetyo', '8A', pinSiswa3);
    assert.strictEqual(ekoCheck.valid, false);
    assert.match(ekoCheck.message, /kuota token.*penuh/i);

    // Guru menambah +5 token secara live saat ujian berlangsung!
    const addToken = pinService.addTokenUjian(ulangan.id, guru.id, 5);
    assert.strictEqual(addToken.success, true);
    assert.strictEqual(addToken.ditambah, 5);

    // Sekarang kuota sudah bertambah, Eko mencoba klaim PIN lagi -> Berhasil!
    const ekoRetry = pinService.validatePin(ulangan.id, 'Eko Prasetyo', '8A', pinSiswa3, 'dev_eko');
    assert.strictEqual(ekoRetry.valid, true);
    const startEko = studentService.startExam(ulangan.kode_ujian, 'Eko Prasetyo', '8A');
    assert.ok(startEko.pengerjaanId);
  });

  await t.test('8. Reset PIN & Device: Guru dapat mereset sesi jika siswa ganti HP', () => {
    const list = pinService.getAllPins(ulangan.id, guru.id).data;
    const budiPinRow = list.find(p => p.nama === 'Budi Santoso');
    assert.ok(budiPinRow);

    // Reset perangkat Budi
    const resetDev = pinService.resetPin(ulangan.id, budiPinRow.id, guru.id, 'device_only');
    assert.strictEqual(resetDev.success, true);

    // Reset penuh kembalikan ke pool
    const resetPool = pinService.resetPin(ulangan.id, budiPinRow.id, guru.id, 'unclaim');
    assert.strictEqual(resetPool.success, true);

    const recheck = pinService.getAllPins(ulangan.id, guru.id).data.find(p => p.id === budiPinRow.id);
    assert.strictEqual(recheck.is_used, false);
    assert.strictEqual(recheck.nama, '-');
  });

  await t.test('9. Format Sebaran WhatsApp: Format teks rapi siap dibagikan ke siswa', () => {
    const bc = pinService.formatBroadcastText(ulangan.id, guru.id);
    assert.strictEqual(bc.success, true);
    assert.match(bc.text, /DAFTAR PIN SEKALI PAKAI UJIAN/);
    assert.match(bc.text, /Biologi/);
  });
});
