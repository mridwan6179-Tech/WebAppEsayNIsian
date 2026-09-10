const test = require('node:test');
const assert = require('node:assert');
const authService = require('../src/services/authService');
const adminService = require('../src/services/adminService');
const geminiService = require('../src/services/geminiService');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const db = require('../src/config/database');

test('T-13: Portal Admin, Manajemen Akun Guru, API Key Dinamis, & Dukungan Gambar Soal', async (t) => {
  let createdGuruId = null;
  const testGuruEmail = `guru.test.${Date.now()}@sekolah.id`;

  await t.test('1. Autentikasi Admin: Login, verifikasi sesi token, dan logout', () => {
    // Login gagal kredensial salah
    const fail1 = authService.loginAdmin('wrongadmin', 'admin123');
    assert.strictEqual(fail1.success, false);

    const fail2 = authService.loginAdmin('admin', 'wrongpass');
    assert.strictEqual(fail2.success, false);

    // Login sukses
    const success = authService.loginAdmin('admin', 'admin123');
    assert.strictEqual(success.success, true);
    assert.ok(success.token);
    assert.strictEqual(success.admin.username, 'admin');

    // Verifikasi token admin
    const adminSession = authService.verifyToken(success.token);
    assert.ok(adminSession);
    assert.strictEqual(adminSession.username, 'admin');
    assert.strictEqual(adminSession.role, 'admin');

    // Token palsu ditolak
    assert.strictEqual(authService.verifyToken('fake-token-123'), null);

    // Logout
    authService.logout(success.token);
    assert.strictEqual(authService.verifyToken(success.token), null);
  });

  await t.test('2. CRUD Guru oleh Admin: Buat guru baru, validasi duplikat, dan login guru', () => {
    // Buat guru
    const newGuru = adminService.createGuru('Ibu Siti Rahmawati', testGuruEmail, 'siti123');
    assert.ok(newGuru.id);
    assert.strictEqual(newGuru.email, testGuruEmail);
    createdGuruId = newGuru.id;

    // Tolak pembuatan dengan email duplikat
    assert.throws(() => {
      adminService.createGuru('Siti Duplikat', testGuruEmail, 'pass123');
    }, /Email guru sudah terdaftar/);

    // Login guru dengan password database baru
    const loginRes = authService.login(testGuruEmail, 'siti123');
    assert.strictEqual(loginRes.success, true);
    assert.strictEqual(loginRes.guru.nama, 'Ibu Siti Rahmawati');
    authService.logout(loginRes.token);
  });

  await t.test('3. Reset Password & Update Profil Guru oleh Admin', () => {
    assert.ok(createdGuruId);

    // Update nama dan ubah password
    const updated = adminService.updateGuru(createdGuruId, {
      nama: 'Dr. Siti Rahmawati, M.Pd',
      password: 'passwordBaruSiti456'
    });
    assert.strictEqual(updated.nama, 'Dr. Siti Rahmawati, M.Pd');

    // Login dengan password lama harus gagal
    const failOld = authService.login(testGuruEmail, 'siti123');
    assert.strictEqual(failOld.success, false);

    // Login dengan password baru harus sukses
    const successNew = authService.login(testGuruEmail, 'passwordBaruSiti456');
    assert.strictEqual(successNew.success, true);
    assert.strictEqual(successNew.guru.nama, 'Dr. Siti Rahmawati, M.Pd');
    authService.logout(successNew.token);
  });

  await t.test('4. Konfigurasi API Key Gemini Dinamis via Admin', () => {
    // Simpan API key asli saat ini untuk dikembalikan nanti
    const originalRow = db.prepare("SELECT value FROM app_settings WHERE key = 'gemini_api_key'").get();
    const originalKey = originalRow ? originalRow.value : '';

    try {
      // Dapatkan config AI (masked)
      const config = adminService.getAiConfig();
      assert.ok('has_key' in config);
      assert.ok('masked_key' in config);

      // Admin memasukkan API key baru
      const testDynamicKey = 'AIzaSy_TEST_KEY_DYNAMIC_1234567890';
      const updateResult = adminService.updateAiConfig(testDynamicKey);
      assert.strictEqual(updateResult.success, true);

      const updatedConfig = adminService.getAiConfig();
      assert.strictEqual(updatedConfig.has_key, true);
      assert.match(updatedConfig.masked_key, /AIzaSy.*7890/);

      // Verifikasi geminiService.getActiveApiKey() mengambil key baru dari database seketika
      const activeKey = geminiService.getActiveApiKey();
      assert.strictEqual(activeKey, testDynamicKey);
    } finally {
      // Kembalikan ke key original
      if (originalKey) {
        adminService.updateAiConfig(originalKey);
      }
    }
  });

  await t.test('5. Dukungan Gambar Soal (Manual URL / Base64 Data URL) dan KaTeX Formula', () => {
    // Buat ulangan oleh guru
    const ulangan = examService.createUlangan(createdGuruId, {
      judul: 'Ulangan Matematika & IPA Bergambar',
      mata_pelajaran: 'Matematika IPA',
      tingkat_kelas: 'Kelas 9',
      waktu_mulai: new Date(Date.now() - 60000).toISOString(),
      waktu_selesai: new Date(Date.now() + 3600000).toISOString()
    });

    // Tambahkan soal dengan gambar_url dan LaTeX math formula
    const mathFormula = 'Hitung nilai $x$ jika diketahui persamaan kuadrat $x^2 - 5x + 6 = 0$!';
    const testImageUrl = 'https://example.com/images/segitiga-siku-siku.png';

    const soal = examService.createSoal(ulangan.id, {
      jenis: 'isian',
      bobot: 25,
      pertanyaan: mathFormula,
      kunci_jawaban: 'x = 2 atau x = 3',
      rubrik: 'Nilai penuh jika menyebutkan kedua akar',
      gambar_url: testImageUrl
    });

    assert.ok(soal.id);
    assert.strictEqual(soal.gambar_url, testImageUrl);
    assert.strictEqual(soal.pertanyaan, mathFormula);

    // Ambil detail ulangan untuk verifikasi guru
    const detailGuru = examService.getUlanganById(ulangan.id, createdGuruId);
    const soalInExam = detailGuru.soal.find(s => s.id === soal.id);
    assert.ok(soalInExam);
    assert.strictEqual(soalInExam.gambar_url, testImageUrl);

    // Publikasikan ulangan agar bisa diakses siswa ('dibuka')
    examService.updateUlangan(ulangan.id, createdGuruId, { status: 'dibuka' });

    // Siswa memulai ujian dan menerima gambar_url pada soal
    const studentExam = studentService.startExam(ulangan.kode_ujian, 'Budi Santoso', 'Kelas 9');
    assert.ok(studentExam);
    const studentSoal = studentExam.soal.find(s => s.id === soal.id);
    assert.ok(studentSoal);
    assert.strictEqual(studentSoal.gambar_url, testImageUrl);
    assert.strictEqual(studentSoal.pertanyaan, mathFormula);

    // Update soal: ganti gambar dan pertanyaan
    const updatedImageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const updatedSoal = examService.updateSoal(soal.id, {
      gambar_url: updatedImageUrl
    });
    assert.strictEqual(updatedSoal.gambar_url, updatedImageUrl);
  });

  await t.test('6. Hapus Guru oleh Admin', () => {
    assert.ok(createdGuruId);
    const delRes = adminService.deleteGuru(createdGuruId);
    assert.strictEqual(delRes.success, true);

    // Guru tidak ditemukan lagi di database
    const guruCheck = db.prepare('SELECT id FROM guru WHERE id = ?').get(createdGuruId);
    assert.strictEqual(guruCheck, undefined);
  });
});
