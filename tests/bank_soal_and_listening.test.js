const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const db = require('../src/config/database');
const examService = require('../src/services/examService');
const bankSoalService = require('../src/services/bankSoalService');
const geminiService = require('../src/services/geminiService');
const studentService = require('../src/services/studentService');
const authService = require('../src/services/authService');
const app = require('../server');

test('=== SUITE: BANK SOAL, LISTENING, AUDIO & EKSPOR EXCEL ===', async (t) => {
  let server;
  let baseUrl;
  let guruId = 1;
  let tokenGuru;
  let testUlanganId;
  let testSoalId;

  // Setup data guru pengujian
  const loginRes = authService.login('guru@sekolah.id', 'guru123');
  guruId = loginRes.guru.id;
  tokenGuru = loginRes.token;

  // Bersihkan bank_soal untuk akun guru pengujian sebelum suite berjalan
  db.prepare('DELETE FROM bank_soal WHERE guru_id = ?').run(guruId);

  // Buat 1 ulangan pengujian
  const testUlangan = examService.createUlangan(guruId, {
    judul: 'Ulangan Pengujian Fitur Baru',
    mata_pelajaran: 'Bahasa Inggris',
    tingkat_kelas: '8A'
  });
  testUlanganId = testUlangan.id;

  const testSoal = examService.createSoal(testUlanganId, {
    pertanyaan: 'What is the main topic of the conversation?',
    jenis: 'isian',
    bobot: 15,
    kunci_jawaban: 'Holiday trip',
    rubrik: 'Menyebutkan holiday trip dengan tepat',
    pembahasan: 'Topik utama percakapan adalah rencana liburan sekolah ke pantai.',
    is_listening: 1,
    bahasa: 'Bahasa Inggris',
    audio_script: 'Speaker A: Where are we going this holiday? Speaker B: We are going to the beach for a holiday trip.'
  });
  testSoalId = testSoal.id;

  await t.test('1. Bank Soal Service: CRUD dan filter kategori berfungsi sempurna', async () => {
    // 1.1 Buat soal baru di Bank Soal
    const created = bankSoalService.create(guruId, {
      kategori: 'Bahasa Inggris - Listening',
      sub_topik: 'Daily Vacation',
      tingkat_kelas: '8',
      jenis: 'essay',
      pertanyaan: 'Explain why the speaker decided to cancel the flight?',
      kunci_jawaban: 'Because of severe storm',
      rubrik: 'Menjelaskan alasan badai petir / cuaca buruk',
      pembahasan: 'Pada naskah audio menit 00:15, pembicara B menyatakan penerbangan dibatalkan karena badai cuaca ekstrem.',
      tingkat_kesulitan: 'sedang',
      bobot_standar: 20,
      is_listening: 1,
      bahasa: 'Bahasa Inggris',
      audio_script: 'Captain: Attention passengers, due to a severe storm over the island, all flights are postponed.'
    });

    assert.ok(created.id, 'ID Bank Soal harus terbuat');
    assert.equal(created.kategori, 'Bahasa Inggris - Listening');
    assert.equal(created.is_listening, 1);
    assert.equal(created.bahasa, 'Bahasa Inggris');
    assert.ok(created.audio_script.includes('severe storm'));

    // 1.2 Ambil daftar kategori
    const categories = bankSoalService.getCategories(guruId);
    assert.ok(categories.includes('Bahasa Inggris - Listening'));

    // 1.3 Ambil dengan filter kategori dan listening
    const listFiltered = bankSoalService.getAll(guruId, {
      kategori: 'Bahasa Inggris - Listening',
      is_listening: 1
    });
    assert.ok(listFiltered.length >= 1);
    assert.equal(listFiltered[0].kategori, 'Bahasa Inggris - Listening');

    // 1.4 Update Bank Soal
    const updated = bankSoalService.update(created.id, guruId, {
      sub_topik: 'Airport Announcements Updated',
      bobot_standar: 25
    });
    assert.equal(updated.sub_topik, 'Airport Announcements Updated');
    assert.equal(updated.bobot_standar, 25);

    // 1.5 Detail getById
    const detail = bankSoalService.getById(created.id, guruId);
    assert.equal(detail.id, created.id);
  });

  await t.test('2. Salin Soal dari Ulangan ke Bank Soal & Impor Soal dari Bank ke Ulangan', async () => {
    // 2.1 Copy from Exam to Bank Soal
    const copiedToBank = bankSoalService.copyFromExamSoal(testSoalId, guruId, 'Koleksi Soal Listening Semester 1');
    assert.ok(copiedToBank.id);
    assert.equal(copiedToBank.kategori, 'Koleksi Soal Listening Semester 1');
    assert.equal(copiedToBank.is_listening, 1);
    assert.ok(copiedToBank.audio_script.includes('holiday trip'));
    assert.ok(copiedToBank.pembahasan.includes('liburan sekolah'));

    // 2.2 Buat ulangan baru untuk tempat impor
    const ulanganTarget = examService.createUlangan(guruId, {
      judul: 'Ulangan Impor dari Bank Soal',
      mata_pelajaran: 'Bahasa Inggris',
      tingkat_kelas: '8B'
    });

    // 2.3 Import to Exam
    const importedList = bankSoalService.importToExam(ulanganTarget.id, guruId, [copiedToBank.id]);
    assert.equal(importedList.length, 1);
    assert.equal(importedList[0].ulangan_id, ulanganTarget.id);
    assert.equal(importedList[0].is_listening, 1);
    assert.equal(importedList[0].bahasa, 'Bahasa Inggris');
    assert.equal(importedList[0].pertanyaan, testSoal.pertanyaan);

    // 2.4 Salin Massal (copyBatchFromExam) dari Ulangan ke Bank Soal
    const soalTambahan1 = examService.createSoal(testUlanganId, {
      pertanyaan: 'Sebutkan 3 macam pembelahan sel!',
      jenis: 'isian',
      bobot: 15,
      kunci_jawaban: 'Amitosis, mitosis, meiosis',
      pembahasan: 'Tiga macam pembelahan sel pada makhluk hidup adalah amitosis, mitosis, dan meiosis.'
    });
    const soalTambahan2 = examService.createSoal(testUlanganId, {
      pertanyaan: 'Jelaskan perbedaan sitokinesis pada sel hewan dan tumbuhan!',
      jenis: 'essay',
      bobot: 25,
      kunci_jawaban: 'Sel hewan membentuk cleavage furrow, sedangkan sel tumbuhan membentuk cell plate.',
      pembahasan: 'Dinding sel tumbuhan yang kaku menghalangi pembentukan alur pembelahan, sehingga terbentuk pelat sel baru.'
    });

    const batchCopied = bankSoalService.copyBatchFromExam(
      testUlanganId,
      [soalTambahan1.id, soalTambahan2.id],
      guruId,
      'Biologi - Pembelahan Sel'
    );
    assert.equal(batchCopied.length, 2);
    assert.equal(batchCopied[0].kategori, 'Biologi - Pembelahan Sel');
    assert.equal(batchCopied[1].kategori, 'Biologi - Pembelahan Sel');
    assert.equal(batchCopied[0].pertanyaan, 'Sebutkan 3 macam pembelahan sel!');
    assert.equal(batchCopied[1].pertanyaan, 'Jelaskan perbedaan sitokinesis pada sel hewan dan tumbuhan!');

    // 2.5 Verifikasi Anti-Duplikasi: Salin ulang soal yang sama ke kategori yang sama
    const countBefore = db.prepare('SELECT COUNT(*) as c FROM bank_soal WHERE guru_id = ?').get(guruId).c;
    const reCopied = bankSoalService.copyBatchFromExam(
      testUlanganId,
      [soalTambahan1.id, soalTambahan2.id],
      guruId,
      'Biologi - Pembelahan Sel'
    );
    const countAfter = db.prepare('SELECT COUNT(*) as c FROM bank_soal WHERE guru_id = ?').get(guruId).c;
    assert.equal(countAfter, countBefore, 'Jumlah baris bank_soal tidak boleh bertambah (anti-duplikasi aktif)');
    assert.equal(reCopied.length, 2, 'Mengembalikan referensi bank_soal yang sudah ada');

    // 2.6 Verifikasi Anti-Duplikasi: Impor ulang soal yang sudah ada di paket ulangan target
    const examCountBefore = db.prepare('SELECT COUNT(*) as c FROM soal WHERE ulangan_id = ?').get(ulanganTarget.id).c;
    const reImported = bankSoalService.importToExam(ulanganTarget.id, guruId, [copiedToBank.id]);
    const examCountAfter = db.prepare('SELECT COUNT(*) as c FROM soal WHERE ulangan_id = ?').get(ulanganTarget.id).c;
    assert.equal(examCountAfter, examCountBefore, 'Soal duplikat tidak boleh masuk ke ulangan');
    assert.equal(reImported.length, 0, 'Soal yang sudah ada dilewati (skipped)');
  });

  await t.test('3. AI Cerdas Pemilih Soal dari Bank Soal (Smart Pick)', async () => {
    // Tambah 2 soal lagi di Bank Soal
    bankSoalService.create(guruId, {
      kategori: 'Bahasa Inggris - Grammar',
      jenis: 'isian',
      pertanyaan: 'Fill in the blank with correct past tense: She ___ (go) yesterday.',
      kunci_jawaban: 'went',
      rubrik: 'Tepat menulis went',
      pembahasan: 'Bentuk lampau past tense dari go adalah went.'
    });

    bankSoalService.create(guruId, {
      kategori: 'Bahasa Inggris - Grammar',
      jenis: 'essay',
      pertanyaan: 'Explain the difference between Present Perfect and Simple Past!',
      kunci_jawaban: 'Simple past focuses on specific finished time, while present perfect connects past with present.',
      rubrik: 'Menjelaskan perbedaan waktu spesifik vs hasil sekarang',
      pembahasan: 'Simple past menggunakan time signal jelas (yesterday, last night). Present perfect menggunakan has/have + V3.'
    });

    const smartPickRes = bankSoalService.aiSmartPick(guruId, testUlanganId, {
      kategori: 'Bahasa Inggris - Grammar',
      jumlah_isian: 1,
      jumlah_essay: 1
    });

    assert.equal(smartPickRes.success, true);
    assert.ok(smartPickRes.total_dipilih >= 2);
    const hasIsian = smartPickRes.selected_soal.some(s => s.jenis === 'isian');
    const hasEssay = smartPickRes.selected_soal.some(s => s.jenis === 'essay');
    assert.equal(hasIsian, true);
    assert.equal(hasEssay, true);
  });

  await t.test('4. Generator Soal AI dengan Parameter Listening & Pembahasan', async () => {
    const aiResult = await geminiService.generateQuestions({
      mode: 'topik',
      input_sumber: 'Percakapan di Restoran',
      jenjang_kelas: 'Kelas 8',
      jumlah_soal: 2,
      tipe_soal: 'campuran',
      is_listening: 1,
      bahasa: 'Bahasa Inggris',
      deskripsi_audio: 'Pelanggan memesan sup ayam dan teh lemon kepada pelayan'
    });

    assert.equal(aiResult.success, true);
    assert.ok(aiResult.soal.length >= 1);
    const item = aiResult.soal[0];
    assert.equal(item.is_listening, 1);
    assert.ok(item.pembahasan, 'Soal harus memiliki pembahasan konsep');
    assert.ok(item.audio_script, 'Soal listening harus memiliki audio_script');
  });

  await t.test('4.2 Generator Soal AI dengan Kuota Parsial Listening vs Teks Biasa', async () => {
    const aiResult = await geminiService.generateQuestions({
      mode: 'topik',
      input_sumber: 'Airport Announcements and Travel',
      jenjang_kelas: 'Kelas 8',
      jumlah_soal: 5,
      tipe_soal: 'campuran',
      is_listening: 1,
      jumlah_listening: 2, // 2 soal listening, 3 soal teks biasa
      bahasa: 'Bahasa Inggris',
      deskripsi_audio: 'Flight boarding announcements'
    });

    assert.equal(aiResult.success, true);
    assert.equal(aiResult.soal.length, 5);
    const listeningQuestions = aiResult.soal.filter(q => q.is_listening === 1);
    const regularQuestions = aiResult.soal.filter(q => !q.is_listening);
    assert.equal(listeningQuestions.length, 2, 'Harus ada tepat 2 butir soal listening');
    assert.equal(regularQuestions.length, 3, 'Harus ada tepat 3 butir soal teks biasa');
    listeningQuestions.forEach(q => {
      assert.ok(q.audio_script, 'Soal listening harus memiliki audio_script');
    });
    regularQuestions.forEach(q => {
      assert.equal(q.audio_script, null, 'Soal teks biasa audio_script harus null');
    });
  });

  await t.test('4.3 Generator Soal AI dengan Kuota Per Tipe (Isian & Essay Terpisah)', async () => {
    const aiResult = await geminiService.generateQuestions({
      mode: 'topik',
      input_sumber: 'Job Interviews and Professional Career',
      jenjang_kelas: 'Kelas 9',
      jumlah_soal: 7,
      tipe_soal: 'kustom',
      jumlah_isian: 4,
      jumlah_essay: 3,
      is_listening: 1,
      jumlah_isian_listening: 2, // 2 isian audio, 2 isian teks
      jumlah_essay_listening: 1, // 1 essay audio, 2 essay teks
      bahasa: 'Bahasa Inggris',
      deskripsi_audio: 'Job interview dialogues'
    });

    assert.equal(aiResult.success, true);
    assert.equal(aiResult.soal.length, 7);

    const isianItems = aiResult.soal.filter(q => q.jenis === 'isian');
    const essayItems = aiResult.soal.filter(q => q.jenis === 'essay');
    assert.equal(isianItems.length, 4, 'Total butir isian harus tepat 4');
    assert.equal(essayItems.length, 3, 'Total butir essay harus tepat 3');

    const isianListening = isianItems.filter(q => q.is_listening === 1);
    const isianTeks = isianItems.filter(q => !q.is_listening);
    assert.equal(isianListening.length, 2, 'Harus ada tepat 2 isian listening');
    assert.equal(isianTeks.length, 2, 'Harus ada tepat 2 isian teks');

    const essayListening = essayItems.filter(q => q.is_listening === 1);
    const essayTeks = essayItems.filter(q => !q.is_listening);
    assert.equal(essayListening.length, 1, 'Harus ada tepat 1 essay listening');
    assert.equal(essayTeks.length, 2, 'Harus ada tepat 2 essay teks');

    // Pastikan integritas audio_script
    isianListening.forEach(q => assert.ok(q.audio_script));
    essayListening.forEach(q => assert.ok(q.audio_script));
    isianTeks.forEach(q => assert.equal(q.audio_script, null));
    essayTeks.forEach(q => assert.equal(q.audio_script, null));
  });

  await t.test('5. Prompt Builder AI Penilai mengikutsertakan Data Listening & Audio Script', async () => {
    const prompt = geminiService.buildPrompt({
      pertanyaan: 'What drink did the customer order?',
      jenis: 'isian',
      bobot: 10,
      kunci_jawaban: 'Lemon tea',
      rubrik: 'Jawaban lemon tea',
      pembahasan: 'Pelanggan memesan lemon tea dingin.',
      is_listening: 1,
      bahasa: 'Bahasa Inggris',
      audio_script: 'Waiter: What would you like to drink? Customer: A glass of cold lemon tea, please.',
      jawaban_siswa: 'lemon tea'
    });

    assert.ok(prompt.includes('Tipe Soal Menyimak / Listening: YA'));
    assert.ok(prompt.includes('Bahasa Pengantar / Pelajaran: Bahasa Inggris'));
    assert.ok(prompt.includes('Waiter: What would you like to drink?'));
    assert.ok(prompt.includes('PEDOMAN KHUSUS SOAL MENYIMAK'));
  });

  await t.test('6. Student Service menyajikan info listening dan audio tanpa bocorkan kunci/pembahasan', async () => {
    // Buka ulangan
    examService.updateStatusUlangan(testUlanganId, 'dibuka');

    const kodeUjian = db.prepare('SELECT kode_ujian FROM ulangan WHERE id = ?').get(testUlanganId).kode_ujian;
    const studentExam = studentService.startExam(kodeUjian, 'Ahmad Siswa Test', '8A');

    assert.equal(studentExam.alreadySubmitted, false);
    assert.ok(studentExam.soal.length >= 1);
    const s = studentExam.soal.find(x => x.id === testSoalId);
    assert.ok(s);
    assert.equal(s.is_listening, 1);
    assert.equal(s.bahasa, 'Bahasa Inggris');
    assert.ok(s.audio_script);
    // Kunci dan pembahasan tidak boleh bocor ke siswa!
    assert.equal(s.kunci_jawaban, undefined);
    assert.equal(s.pembahasan, undefined);
    assert.equal(s.rubrik, undefined);
  });

  await t.test('7. HTTP API Integrasi: Rute Bank Soal & Generate Soal Listening', async () => {
    await new Promise((resolve) => {
      server = http.createServer(app).listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // 7.1 GET /api/guru/bank-soal
    const authHeaders = {
      'Authorization': `Bearer ${tokenGuru}`,
      'Cookie': `auth_token=${tokenGuru}`
    };
    const resGet = await fetch(`${baseUrl}/api/guru/bank-soal`, {
      headers: authHeaders
    });
    const dataGet = await resGet.json();
    assert.equal(resGet.status, 200);
    assert.equal(dataGet.success, true);
    assert.ok(Array.isArray(dataGet.data));

    // 7.2 POST /api/guru/bank-soal
    const resPost = await fetch(`${baseUrl}/api/guru/bank-soal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify({
        kategori: 'Tes API Bank Soal',
        pertanyaan: 'Sebutkan 3 komponen utama CPU komputer!',
        jenis: 'isian',
        bobot_standar: 15,
        pembahasan: 'Komponen utama: ALU, CU, dan Register.'
      })
    });
    const dataPost = await resPost.json();
    assert.equal(resPost.status, 201);
    assert.equal(dataPost.success, true);
    const createdBankId = dataPost.data.id;

    // 7.3 POST /api/guru/bank-soal/ai-pick
    const resAiPick = await fetch(`${baseUrl}/api/guru/bank-soal/ai-pick`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify({
        ulangan_id: testUlanganId,
        kategori: 'Tes API Bank Soal',
        jumlah_soal: 1
      })
    });
    const dataAiPick = await resAiPick.json();
    assert.equal(resAiPick.status, 200);
    assert.equal(dataAiPick.success, true);
    assert.equal(dataAiPick.total_dipilih, 1);

    // 7.4 DELETE /api/guru/bank-soal/:id
    const resDel = await fetch(`${baseUrl}/api/guru/bank-soal/${createdBankId}`, {
      method: 'DELETE',
      headers: authHeaders
    });
    const dataDel = await resDel.json();
    assert.equal(resDel.status, 200);
    assert.equal(dataDel.success, true);

    // 7.5 POST /api/guru/bank-soal/bulk (Direct AI Batch to Bank Soal)
    const resBulk = await fetch(`${baseUrl}/api/guru/bank-soal/bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify({
        soal: [
          {
            kategori: 'Biologi - Fotosintesis',
            sub_topik: 'Reaksi Gelap',
            pertanyaan: 'Di mana terjadinya siklus Calvin?',
            jenis: 'isian',
            bobot_standar: 10,
            pembahasan: 'Siklus Calvin terjadi di stroma kloroplas.'
          },
          {
            kategori: 'Biologi - Fotosintesis',
            sub_topik: 'Reaksi Terang',
            pertanyaan: 'Jelaskan peran klorofil dalam fotolisis air!',
            jenis: 'essay',
            bobot_standar: 20,
            pembahasan: 'Klorofil menyerap foton untuk mengeksitasi elektron yang menguraikan H2O menjadi ion hidrogen dan O2.'
          }
        ]
      })
    });
    const dataBulk = await resBulk.json();
    assert.equal(resBulk.status, 201);
    assert.equal(dataBulk.success, true);
    assert.equal(dataBulk.data.length, 2);
    assert.equal(dataBulk.data[0].kategori, 'Biologi - Fotosintesis');
    assert.equal(dataBulk.data[1].sub_topik, 'Reaksi Terang');

    // Bersihkan data bulk
    for (const b of dataBulk.data) {
      await fetch(`${baseUrl}/api/guru/bank-soal/${b.id}`, { method: 'DELETE', headers: authHeaders });
    }

    // 7.6 POST /api/guru/bank-soal/copy-batch-from-exam (Salin Massal dari Ulangan Aktif)
    const resCopyBatch = await fetch(`${baseUrl}/api/guru/bank-soal/copy-batch-from-exam`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify({
        ulangan_id: testUlanganId,
        soal_ids: [testSoalId],
        kategori: 'Bahasa Inggris - Ulangan Harian'
      })
    });
    const dataCopyBatch = await resCopyBatch.json();
    assert.equal(resCopyBatch.status, 200);
    assert.equal(dataCopyBatch.success, true);
    assert.equal(dataCopyBatch.data.length, 1);
    assert.equal(dataCopyBatch.data[0].kategori, 'Bahasa Inggris - Ulangan Harian');

    // Bersihkan data hasil copy batch
    for (const b of dataCopyBatch.data) {
      await fetch(`${baseUrl}/api/guru/bank-soal/${b.id}`, { method: 'DELETE', headers: authHeaders });
    }

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('8. Pengaturan tampilkan_simbol (Toolbar Simbol Khusus) pada Ulangan & Siswa', async () => {
    // 1. Buat ulangan dengan tampilkan_simbol: 0 (disembunyikan)
    const examNoSymbol = examService.createUlangan(guruId, {
      judul: 'Ulangan Bahasa Indonesia Tanpa Simbol',
      mata_pelajaran: 'Bahasa Indonesia',
      tingkat_kelas: 'Kelas 8',
      tampilkan_simbol: 0
    });
    assert.equal(examNoSymbol.tampilkan_simbol, 0);

    // Tambahkan 1 butir soal
    examService.createSoal(examNoSymbol.id, {
      pertanyaan: 'Apa makna peribahasa air tenang menghanyutkan?',
      jenis: 'isian',
      bobot: 10,
      kunci_jawaban: 'Orang yang pendiam namun berilmu'
    });

    // Buka ulangan dan mulai ujian sebagai siswa
    examService.updateUlangan(examNoSymbol.id, guruId, { status: 'dibuka' });
    const studentVal = studentService.validateExamCode(examNoSymbol.kode_ujian);
    assert.equal(studentVal.valid, true);
    assert.equal(studentVal.ulangan.tampilkan_simbol, 0, 'Siswa harus menerima tampilkan_simbol = 0');

    const started = studentService.startExam(examNoSymbol.kode_ujian, 'Siswa Uji Simbol', '8A');
    assert.equal(started.ulangan.tampilkan_simbol, 0);

    // 2. Update ulangan agar menampilkan simbol kembali (tampilkan_simbol: 1)
    examService.updateUlangan(examNoSymbol.id, guruId, {
      tampilkan_simbol: 1
    });
    const updatedVal = studentService.validateExamCode(examNoSymbol.kode_ujian);
    assert.equal(updatedVal.ulangan.tampilkan_simbol, 1, 'Siswa harus menerima tampilkan_simbol = 1 setelah diupdate guru');

    // 3. Buat ulangan tanpa menyertakan tampilkan_simbol (harus default 1)
    const examDefault = examService.createUlangan(guruId, {
      judul: 'Ulangan Matematika Default Simbol',
      mata_pelajaran: 'Matematika',
      tingkat_kelas: 'Kelas 9'
    });
    assert.equal(examDefault.tampilkan_simbol, 1, 'Default tampilkan_simbol harus bernilai 1');
  });

  await t.test('9. Riwayat Mata Pelajaran Guru & Endpoint /api/guru/mata-pelajaran', async () => {
    // 1. Cek langsung via examService
    const mapelList = examService.getMataPelajaranByGuru(guruId);
    assert.ok(Array.isArray(mapelList), 'Harus mengembalikan array');
    assert.ok(mapelList.includes('Matematika'), 'Harus menyertakan Matematika yang baru dibuat');
    assert.ok(mapelList.includes('Bahasa Inggris'), 'Harus menyertakan Bahasa Inggris');

    // 2. Cek via endpoint HTTP GET & PUT /api/guru/mata-pelajaran
    const srv = http.createServer(app);
    await new Promise((resolve) => srv.listen(0, resolve));
    const port = srv.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/guru/mata-pelajaran`, {
        headers: { 'Authorization': `Bearer ${tokenGuru}` }
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(Array.isArray(json.data));
      assert.ok(json.data.includes('Matematika'));
      assert.ok(json.data.includes('Bahasa Inggris'));

      // 3. Test Rename Mata Pelajaran via API (misal perbaiki typo: Matematika -> Matematika Wajib)
      const resRename = await fetch(`http://127.0.0.1:${port}/api/guru/mata-pelajaran/rename`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenGuru}`
        },
        body: JSON.stringify({
          oldName: 'Matematika',
          newName: 'Matematika Wajib'
        })
      });
      assert.equal(resRename.status, 200);
      const jsonRename = await resRename.json();
      assert.equal(jsonRename.success, true);
      assert.ok(jsonRename.count >= 1);

      // Verifikasi daftar mata pelajaran setelah rename
      const resAfter = await fetch(`http://127.0.0.1:${port}/api/guru/mata-pelajaran`, {
        headers: { 'Authorization': `Bearer ${tokenGuru}` }
      });
      const jsonAfter = await resAfter.json();
      assert.ok(jsonAfter.data.includes('Matematika Wajib'));
      assert.ok(!jsonAfter.data.includes('Matematika'));
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });
});
