const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const app = require('../server');
const db = require('../src/config/database');
const authService = require('../src/services/authService');
const adminService = require('../src/services/adminService');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const geminiService = require('../src/services/geminiService');

test('=== MULTI-KEY GEMINI, ARABIC & REMEDIAL SUITE ===', async (t) => {
  let server;
  let baseUrl;

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  t.after(() => {
    server.close();
  });

  // ----------------------------------------------------
  // TEST 1: Multi-Key Gemini Management & Failover Data
  // ----------------------------------------------------
  await t.test('Admin can add, list, toggle, and delete backup Gemini keys', () => {
    // Tambah Kunci Baru (Priority 2)
    const key1 = adminService.addAiKey('Akun Cadangan 1', 'AIzaSyTestKey_Backup_1234567890', 2);
    assert.ok(key1.id, 'Key harus memiliki ID');
    assert.strictEqual(key1.label, 'Akun Cadangan 1');
    assert.strictEqual(key1.priority, 2);
    assert.ok(key1.masked_key.startsWith('AIzaSy'), 'Masked key harus diformat');

    // List seluruh kunci
    const allKeys = adminService.getAllAiKeys();
    const found = allKeys.find(k => k.id === key1.id);
    assert.ok(found, 'Kunci cadangan harus muncul di daftar');

    // Update status aktif/nonaktif
    const updated = adminService.updateAiKey(key1.id, { is_active: 0 });
    assert.strictEqual(updated.success, true);
    const keyAfterUpdate = db.prepare('SELECT is_active FROM gemini_api_keys WHERE id = ?').get(key1.id);
    assert.strictEqual(keyAfterUpdate.is_active, 0);

    // Aktifkan kembali
    adminService.updateAiKey(key1.id, { is_active: 1, priority: 3 });
    const keyActive = db.prepare('SELECT is_active, priority FROM gemini_api_keys WHERE id = ?').get(key1.id);
    assert.strictEqual(keyActive.is_active, 1);
    assert.strictEqual(keyActive.priority, 3);

    // Hapus kunci
    const delRes = adminService.deleteAiKey(key1.id);
    assert.strictEqual(delRes.success, true);
    const checkDeleted = db.prepare('SELECT id FROM gemini_api_keys WHERE id = ?').get(key1.id);
    assert.strictEqual(checkDeleted, undefined, 'Kunci harus terhapus dari database');
  });

  // ----------------------------------------------------
  // TEST 2: Cascade Deletion Guru
  // ----------------------------------------------------
  await t.test('Deleting a teacher cleanly cascades and removes all exams, questions, and submissions', () => {
    // 1. Buat guru temporer
    const newGuru = adminService.createGuru('Ustadz Ahmad Fauzi', `ahmad.fauzi.${Date.now()}@madrasah.id`, 'pass12345');
    const guruId = newGuru.id;

    // 2. Buat ulangan milik guru ini
    const ulangan = examService.createUlangan(guruId, {
      judul: 'Ulangan Bahasa Arab & Nahwu',
      mata_pelajaran: 'Bahasa Arab',
      kelas_ids: [],
      kkm: 80,
      instruksi_remedial: 'Hafalkan tashrif lughawi fiil madhi bab 1',
      link_remedial: 'https://classroom.google.com/remedial-arab'
    });
    const ulanganId = ulangan.id;

    // 3. Tambah butir soal
    const soal1 = examService.addSoal(ulanganId, {
      pertanyaan: 'مَا مَعْنَى كَلِمَةُ "كِتَابٌ"؟',
      jenis: 'isian',
      bobot: 50,
      kunci_jawaban: 'Buku bacaan',
      rubrik: 'Menjawab buku'
    });

    const soal2 = examService.addSoal(ulanganId, {
      pertanyaan: 'Tuliskan contoh kalimat ismiyah dalam bahasa Arab!',
      jenis: 'essay',
      bobot: 50,
      kunci_jawaban: 'العِلْمُ نُوْرٌ',
      rubrik: 'Mubtada dan khabar marfu'
    });

    // 4. Buka ulangan dan ada siswa mengerjakan
    examService.updateStatusUlangan(ulanganId, 'dibuka');
    const startRes = studentService.startExam(ulangan.kode_ujian, 'Muhammad Ridwan', '10 MIPA 1');
    const pengerjaanId = startRes.pengerjaanId;

    studentService.submitExam(pengerjaanId, [
      { soal_id: soal1.id, jawaban_siswa: 'Buku' },
      { soal_id: soal2.id, jawaban_siswa: 'العلم نور' }
    ]);

    // Verifikasi data ada sebelum dihapus
    assert.ok(db.prepare('SELECT id FROM ulangan WHERE id = ?').get(ulanganId));
    assert.ok(db.prepare('SELECT id FROM soal WHERE ulangan_id = ?').get(ulanganId));
    assert.ok(db.prepare('SELECT id FROM pengerjaan WHERE ulangan_id = ?').get(ulanganId));

    // Eksekusi Cascade Delete Guru
    const deleteResult = adminService.deleteGuru(guruId);
    assert.strictEqual(deleteResult.success, true);

    // Verifikasi semua data bersih tanpa constraint violation
    assert.strictEqual(db.prepare('SELECT id FROM guru WHERE id = ?').get(guruId), undefined, 'Guru terhapus');
    assert.strictEqual(db.prepare('SELECT id FROM ulangan WHERE id = ?').get(ulanganId), undefined, 'Ulangan terhapus');
    assert.strictEqual(db.prepare('SELECT id FROM soal WHERE ulangan_id = ?').get(ulanganId), undefined, 'Soal terhapus');
    assert.strictEqual(db.prepare('SELECT id FROM pengerjaan WHERE ulangan_id = ?').get(ulanganId), undefined, 'Pengerjaan terhapus');
    assert.strictEqual(db.prepare('SELECT id FROM jawaban WHERE pengerjaan_id = ?').get(pengerjaanId), undefined, 'Jawaban terhapus');
  });

  // ----------------------------------------------------
  // TEST 3: Arabic Normalization & Tolerant Evaluation
  // ----------------------------------------------------
  await t.test('Arabic normalization standardizes harakat, hamzah, ta marbuthah, and alif maqshurah', () => {
    // 1. Uji pembersihan harakat (vowel signs)
    const withTashkeel = 'الْعِلْمُ نُوْرٌ وَالْجَهْلُ ظَلَامٌ';
    const normalized = geminiService.normalizeArabic(withTashkeel);
    assert.strictEqual(normalized, 'العلم نور والجهل ظلام', 'Harakat harus bersih total');

    // 2. Uji variasi Hamzah
    const hamzah1 = 'أَحْمَدُ إِبْرَاهِيمُ آكِلٌ';
    assert.strictEqual(geminiService.normalizeArabic(hamzah1), 'احمد ابراهيم اكل');

    // 3. Uji Ta Marbuthah dan Alif Maqshurah
    const taMarbuthah = 'مَدْرَسَةٌ';
    assert.strictEqual(geminiService.normalizeArabic(taMarbuthah), 'مدرسه');

    const alifMaqshurah = 'مُسْتَشْفَى';
    assert.strictEqual(geminiService.normalizeArabic(alifMaqshurah), 'مستشفي');
  });

  await t.test('Offline evaluation correctly grades Arabic answers even with differing vocalization', () => {
    // Kunci berharakat lengkap, siswa menjawab gundul tanpa harakat
    const evalResult = geminiService.fallbackOfflineEvaluation(
      'مَا هُوَ عُنْوَانُ الدَّرْسِ؟',
      'كِتَابُ اللُّغَةِ الْعَرَبِيَّةِ', // Kunci acuan guru
      'كتاب اللغة العربية',             // Jawaban siswa (tanpa harakat)
      10,
      'isian'
    );

    assert.strictEqual(evalResult.skor, 10, 'Jawaban harus bernilai penuh karena makna dan lafazh identik');
    assert.strictEqual(evalResult.status, 'sesuai');
    assert.match(evalResult.alasan, /identik|sesuai/i);
  });

  await t.test('Offline evaluation supports English grammar and reading comprehension', () => {
    const evalResult = geminiService.fallbackOfflineEvaluation(
      'What is the main function of the mitochondria?',
      'Powerhouse of the cell that produces ATP energy through cellular respiration',
      'It is the powerhouse of the cell producing ATP energy',
      10,
      'essay'
    );

    assert.ok(evalResult.skor >= 7, 'Skor elaborasi bahasa Inggris harus tinggi jika kata kunci terpenuhi');
    assert.ok(evalResult.status === 'sesuai' || evalResult.status === 'sebagian');
  });

  // ----------------------------------------------------
  // TEST 4: "Remember Me" (Ingat Saya) Authentication
  // ----------------------------------------------------
  await t.test('Teacher login with Remember Me sets 30-day expiration token and payload', () => {
    const email = process.env.TEACHER_EMAIL || 'guru@sekolah.id';
    const password = process.env.TEACHER_PASSWORD || 'guru123';

    // Login biasa (1 hari)
    const res1 = authService.login(email, password, false);
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.rememberMe, false);
    assert.strictEqual(res1.expiresInDays, 1);

    // Login dengan Remember Me (30 hari)
    const res30 = authService.login(email, password, true);
    assert.strictEqual(res30.success, true);
    assert.strictEqual(res30.rememberMe, true);
    assert.strictEqual(res30.expiresInDays, 30);

    const session = authService.verifyToken(res30.token);
    assert.ok(session);
    assert.strictEqual(session.rememberMe, true);
    // Masa berlaku harus sekitar 30 hari ke depan
    const diffDays = Math.round((session.expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
    assert.strictEqual(diffDays, 30);
  });

  await t.test('Admin login with Remember Me sets 30-day expiration', () => {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';

    const res = authService.loginAdmin(username, password, true);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.rememberMe, true);
    assert.strictEqual(res.expiresInDays, 30);

    const session = authService.verifyToken(res.token);
    assert.ok(session);
    assert.strictEqual(session.role, 'admin');
    const diffDays = Math.round((session.expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
    assert.strictEqual(diffDays, 30);
  });

  // ----------------------------------------------------
  // TEST 5: Remedial Direct Instructions & Custom Link
  // ----------------------------------------------------
  await t.test('Exam supports custom remedial instructions and external task link', () => {
    const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
    const guruId = guru.id;

    // Buat ulangan dengan instruksi remedial dan link tugas
    const ulangan = examService.createUlangan(guruId, {
      judul: 'Ujian Fiqih & Bahasa Arab',
      mata_pelajaran: 'PAI & Bahasa Asing',
      kelas_ids: [],
      kkm: 75,
      instruksi_remedial: 'Baca materi wudhu halaman 20 dan kerjakan latihan 5 soal di Google Classroom',
      link_remedial: 'https://forms.gle/ContohRemedial123'
    });

    assert.strictEqual(ulangan.instruksi_remedial, 'Baca materi wudhu halaman 20 dan kerjakan latihan 5 soal di Google Classroom');
    assert.strictEqual(ulangan.link_remedial, 'https://forms.gle/ContohRemedial123');

    // Update instruksi remedial
    const updatedUlangan = examService.updateUlangan(ulangan.id, {
      instruksi_remedial: 'Perbaikan: Kerjakan lembar remedial yang dibagikan guru di meja kelas',
      link_remedial: 'https://quizizz.com/join?gc=998877'
    });

    assert.strictEqual(updatedUlangan.instruksi_remedial, 'Perbaikan: Kerjakan lembar remedial yang dibagikan guru di meja kelas');
    assert.strictEqual(updatedUlangan.link_remedial, 'https://quizizz.com/join?gc=998877');

    // Tambahkan soal dan kerjakan dengan nilai di bawah KKM (Remedial)
    const soal = examService.addSoal(ulangan.id, {
      pertanyaan: 'Sebutkan rukun wudhu yang pertama!',
      jenis: 'isian',
      bobot: 100,
      kunci_jawaban: 'Niat'
    });

    examService.updateStatusUlangan(ulangan.id, 'dibuka');
    const start = studentService.startExam(ulangan.kode_ujian, 'Siti Nurhaliza', '10 MIPA 2');
    const pId = start.pengerjaanId;

    // Siswa jawab salah
    studentService.submitExam(pId, [{ soal_id: soal.id, jawaban_siswa: 'Membasuh kaki' }]);

    // Beri nilai 0 dan rilis nilai
    const jawaban = db.prepare('SELECT id FROM jawaban WHERE pengerjaan_id = ?').get(pId);
    examService.reviewJawaban(jawaban.id, 0, 'Jawaban belum tepat, rukun pertama adalah niat');
    examService.releaseNilai(ulangan.id, true);

    // Cek status pengerjaan siswa
    const status = studentService.getPengerjaanStatus(pId);
    assert.strictEqual(status.isReleased, true);
    assert.strictEqual(status.nilaiFinal, 0);
    assert.strictEqual(status.isRemedial, true);
    assert.strictEqual(status.instruksi_remedial, 'Perbaikan: Kerjakan lembar remedial yang dibagikan guru di meja kelas');
    assert.strictEqual(status.link_remedial, 'https://quizizz.com/join?gc=998877');

    // Cek riwayat ulangan siswa
    const history = studentService.getStudentExamHistory(pId);
    const item = history.find(h => h.pengerjaanId === pId);
    assert.ok(item, 'Riwayat ulangan harus ditemukan');
    assert.strictEqual(item.isRemedial, true);
    assert.strictEqual(item.instruksi_remedial, 'Perbaikan: Kerjakan lembar remedial yang dibagikan guru di meja kelas');
    assert.strictEqual(item.link_remedial, 'https://quizizz.com/join?gc=998877');
  });

  // ----------------------------------------------------
  // TEST 6: HTTP Endpoints (Remember Me & AI Keys API)
  // ----------------------------------------------------
  await t.test('HTTP API: Teacher and Admin login routes honor remember_me cookies', async () => {
    // 1. Login Guru dengan remember_me
    const resGuru = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.TEACHER_EMAIL || 'guru@sekolah.id',
        password: process.env.TEACHER_PASSWORD || 'guru123',
        remember_me: true
      })
    });

    const bodyGuru = await resGuru.json();
    assert.strictEqual(resGuru.status, 200);
    assert.strictEqual(bodyGuru.rememberMe, true);
    assert.strictEqual(bodyGuru.expiresInDays, 30);
    const cookieGuru = resGuru.headers.get('set-cookie');
    assert.ok(cookieGuru, 'Cookie auth_token harus ada');
    assert.ok(cookieGuru.includes('Max-Age=2592000'), 'Cookie Max-Age harus 30 hari (2592000 detik)');

    // 2. Login Admin dengan remember_me
    const resAdmin = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: process.env.ADMIN_USERNAME || 'admin',
        password: process.env.ADMIN_PASSWORD || 'admin123',
        remember_me: true
      })
    });

    const bodyAdmin = await resAdmin.json();
    assert.strictEqual(resAdmin.status, 200);
    assert.strictEqual(bodyAdmin.rememberMe, true);
    assert.strictEqual(bodyAdmin.expiresInDays, 30);
    const cookieAdmin = resAdmin.headers.get('set-cookie');
    assert.ok(cookieAdmin, 'Cookie admin_token harus ada');
    assert.ok(cookieAdmin.includes('Max-Age=2592000'), 'Cookie Max-Age harus 30 hari');
  });

  await t.test('HTTP API: Multi-Key Gemini CRUD endpoints are secured and functioning', async () => {
    const adminToken = authService.loginAdmin('admin', 'admin123').token;

    // 1. GET /api/admin/ai-keys
    const getRes = await fetch(`${baseUrl}/api/admin/ai-keys`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const getBody = await getRes.json();
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getBody.success, true);
    assert.ok(Array.isArray(getBody.data));

    // 2. POST /api/admin/ai-keys
    const postRes = await fetch(`${baseUrl}/api/admin/ai-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        label: 'Kunci Cadangan HTTP API',
        api_key: 'AIzaSySampleEndpointBackupKey_12345',
        priority: 2
      })
    });
    const postBody = await postRes.json();
    assert.strictEqual(postRes.status, 201);
    assert.strictEqual(postBody.success, true);
    const newKeyId = postBody.data.id;
    assert.ok(newKeyId);

    // 3. PUT /api/admin/ai-keys/:id
    const putRes = await fetch(`${baseUrl}/api/admin/ai-keys/${newKeyId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ is_active: 0, priority: 5 })
    });
    const putBody = await putRes.json();
    assert.strictEqual(putRes.status, 200);
    assert.strictEqual(putBody.success, true);

    // 4. DELETE /api/admin/ai-keys/:id
    const delRes = await fetch(`${baseUrl}/api/admin/ai-keys/${newKeyId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const delBody = await delRes.json();
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual(delBody.success, true);
  });
});
