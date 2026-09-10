const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const app = require('../server');
const geminiService = require('../src/services/geminiService');
const authService = require('../src/services/authService');

test('=== PENGUJIAN CUSTOM GENERATE JUMLAH SOAL PER TIPE (ISIAN & ESSAY) ===', async (t) => {
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

  await t.test('1. buildGenerateQuestionsPrompt menyusun rincian kuota eksak isian dan essay', () => {
    const prompt = geminiService.buildGenerateQuestionsPrompt({
      mode: 'topik',
      input_sumber: 'Hukum Newton & Gravitasi',
      jenjang_kelas: 'Kelas 10 SMA',
      jumlah_isian: 8,
      jumlah_essay: 5,
      target_total_bobot: 100
    });

    // Harus menyebutkan total soal 13
    assert.match(prompt, /Tepat 13 butir soal/);
    // Harus memuat instruksi eksplisit 8 isian dan 5 essay
    assert.match(prompt, /8 butir.*isian/i);
    assert.match(prompt, /5 butir.*essay/i);
    assert.match(prompt, /Target Total Akumulasi Bobot: 100/);
  });

  await t.test('2. fallbackOfflineQuestionGenerator menghasilkan tepat 8 soal isian dan 5 soal essay', () => {
    const res = geminiService.fallbackOfflineQuestionGenerator({
      mode: 'topik',
      input_sumber: 'Termodinamika Kimia',
      jumlah_isian: 8,
      jumlah_essay: 5,
      target_total_bobot: 100
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.soal.length, 13, 'Total soal harus tepat 13 (8 isian + 5 essay)');

    const isianList = res.soal.filter(s => s.jenis === 'isian');
    const essayList = res.soal.filter(s => s.jenis === 'essay');

    assert.strictEqual(isianList.length, 8, 'Harus menghasilkan tepat 8 butir soal isian');
    assert.strictEqual(essayList.length, 5, 'Harus menghasilkan tepat 5 butir soal essay');

    const totalBobot = res.soal.reduce((sum, s) => sum + s.bobot, 0);
    assert.strictEqual(totalBobot, 100, 'Total akumulasi bobot harus terdistribusi tepat 100');
  });

  await t.test('3. Generator mendukung opsi tipe tunggal spesifik via jumlah_isian atau jumlah_essay', () => {
    // Kasus hanya 7 isian (0 essay)
    const resHanyaIsian = geminiService.fallbackOfflineQuestionGenerator({
      input_sumber: 'Kosakata Bahasa Arab',
      jumlah_isian: 7,
      jumlah_essay: 0,
      target_total_bobot: 70
    });
    assert.strictEqual(resHanyaIsian.soal.length, 7);
    assert.ok(resHanyaIsian.soal.every(s => s.jenis === 'isian'));

    // Kasus hanya 4 essay (0 isian)
    const resHanyaEssay = geminiService.fallbackOfflineQuestionGenerator({
      input_sumber: 'Sejarah Perang Dunia',
      jumlah_isian: 0,
      jumlah_essay: 4,
      target_total_bobot: 80
    });
    assert.strictEqual(resHanyaEssay.soal.length, 4);
    assert.ok(resHanyaEssay.soal.every(s => s.jenis === 'essay'));
  });

  await t.test('4. HTTP API POST /api/guru/generate-soal menerima jumlah_isian & jumlah_essay', async () => {
    const teacherToken = authService.login('guru@sekolah.id', 'guru123').token;

    const response = await fetch(`${baseUrl}/api/guru/generate-soal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${teacherToken}`
      },
      body: JSON.stringify({
        mode: 'topik',
        input_sumber: 'Biologi Ekosistem dan Rantai Makanan',
        jenjang_kelas: 'Kelas 10',
        jumlah_isian: 8,
        jumlah_essay: 5,
        tingkat_kesulitan: 'sedang',
        target_total_bobot: 100
      })
    });

    const body = await response.json();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.success, true);
    assert.ok(Array.isArray(body.soal));
    assert.strictEqual(body.soal.length, 13, 'API harus mengembalikan tepat 13 soal');

    const countIsian = body.soal.filter(s => s.jenis === 'isian').length;
    const countEssay = body.soal.filter(s => s.jenis === 'essay').length;
    assert.strictEqual(countIsian, 8, 'API harus mengembalikan 8 soal isian');
    assert.strictEqual(countEssay, 5, 'API harus mengembalikan 5 soal essay');
  });
});
