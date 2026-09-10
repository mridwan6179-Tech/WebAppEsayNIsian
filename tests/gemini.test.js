const test = require('node:test');
const assert = require('node:assert');
const geminiService = require('../src/services/geminiService');

test('T-05: Integrasi Gemini AI Dinamis & Evaluasi Semantik (FR-14 - FR-19)', async (t) => {
  await t.test('FR-18: Mendapatkan kandidat model secara dinamis', async () => {
    const model = await geminiService.getAvailableModel();
    assert.ok(model);
    assert.ok(typeof model === 'string');
    assert.match(model, /gemini/);
  });

  await t.test('FR-19 & FR-17: Pembentukan prompt memuat data soal, konteks kelas & rubrik', () => {
    const item = {
      pertanyaan: 'Apa ibukota Indonesia?',
      jenis: 'isian',
      bobot: 10,
      kunci_jawaban: 'IKN Nusantara',
      rubrik: 'Jawaban harus menyebutkan Nusantara atau IKN',
      tingkat_kelas: 'Kelas 8',
      tingkat_kesulitan: 'Mudah',
      jawaban_siswa: 'Nusantara'
    };

    const prompt = geminiService.buildPrompt(item);
    assert.match(prompt, /Apa ibukota Indonesia\?/);
    assert.match(prompt, /IKN Nusantara/);
    assert.match(prompt, /Kelas 8/);
    assert.match(prompt, /Nusantara/);
    assert.match(prompt, /TOLERANSI TYPO & SINONIM/);
    assert.match(prompt, /PENILAIAN MAKNA/);
  });

  await t.test('FR-14, FR-15, FR-16: Evaluasi Semantik - Jawaban Benar, Parsial, dan Salah', async () => {
    const baseItem = {
      pertanyaan: 'Sebutkan 3 bagian sel penyusun tumbuhan!',
      bobot: 15,
      kunci_jawaban: 'Dinding sel, kloroplas, membran sel',
      skor_maksimum: 15
    };

    // 1. Jawaban Benar
    const resBenar = await geminiService.gradeAnswer({
      ...baseItem,
      jawaban_siswa: 'Dinding sel, kloroplas, membran sel'
    }, '');
    assert.strictEqual(resBenar.status_jawaban, 'benar');
    assert.strictEqual(resBenar.skor_rekomendasi, 15);

    // 2. Jawaban Parsial
    const resParsial = await geminiService.gradeAnswer({
      ...baseItem,
      jawaban_siswa: 'Hanya ada dinding sel dan membran'
    }, '');
    assert.strictEqual(resParsial.status_jawaban, 'parsial');
    assert.ok(resParsial.skor_rekomendasi > 0 && resParsial.skor_rekomendasi < 15);

    // 3. Jawaban Salah / Kosong
    const resSalah = await geminiService.gradeAnswer({
      ...baseItem,
      jawaban_siswa: ''
    }, '');
    assert.strictEqual(resSalah.status_jawaban, 'salah');
    assert.strictEqual(resSalah.skor_rekomendasi, 0);

    // 4. Jawaban Salah total tidak relevan
    const resNgawur = await geminiService.gradeAnswer({
      ...baseItem,
      jawaban_siswa: 'Saya suka bermain game mobil-mobilan'
    }, '');
    assert.strictEqual(resNgawur.status_jawaban, 'salah');
    assert.strictEqual(resNgawur.skor_rekomendasi, 0);
  });

  await t.test('NFR-08: Nilai dibatasi tidak boleh melebihi bobot atau kurang dari 0', async () => {
    const item = {
      pertanyaan: 'Tes batas nilai',
      bobot: 20,
      kunci_jawaban: 'jawaban tepat',
      jawaban_siswa: 'jawaban tepat'
    };

    const res = await geminiService.gradeAnswer(item, '');
    assert.ok(res.skor_rekomendasi >= 0);
    assert.ok(res.skor_rekomendasi <= 20);
  });

  await t.test('Urutan kandidat model dan otomatis beralih jika model gagal/error', async () => {
    geminiService.clearModelCooldowns();

    // 1. Urutan kandidat model terurut Flash-Lite (teringan) versi terbaru
    const ordered = await geminiService.getOrderedCandidateModels();
    assert.ok(Array.isArray(ordered));
    assert.ok(ordered.length > 1);
    // Model pertama adalah varian lite
    assert.match(ordered[0], /lite/i);

    // 2. Simulasikan jika model pertama gagal (misal 503 atau 429), sistem mencoba model kedua
    const originalFetch = global.fetch;
    let attempts = [];

    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes(ordered[0])) {
        attempts.push(ordered[0]);
        // Model 1 error 503 High Demand
        return {
          ok: false,
          status: 503,
          text: async () => 'Model is overloaded'
        };
      }
      if (urlStr.includes(ordered[1])) {
        attempts.push(ordered[1]);
        // Model 2 berhasil
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{ text: JSON.stringify({ skor_rekomendasi: 10, status_jawaban: 'benar', alasan_ai: 'Bagus' }) }]
              }
            }]
          })
        };
      }
      return originalFetch(url, options);
    };

    try {
      const res = await geminiService.gradeAnswer({
        pertanyaan: 'Soal uji failover',
        bobot: 10,
        jawaban_siswa: 'Jawaban'
      }, 'fake-key-for-test');

      // Memastikan dicoba secara berurutan: model 1 dicoba lalu model 2 dicoba
      assert.strictEqual(attempts.length, 2);
      assert.strictEqual(attempts[0], ordered[0]);
      assert.strictEqual(attempts[1], ordered[1]);
      assert.strictEqual(res.model_ai, ordered[1]);
      assert.strictEqual(res.skor_rekomendasi, 10);

      // Model 1 yang baru saja gagal otomatis digeser ke akhir urutan untuk panggilan selanjutnya
      const nextOrdered = await geminiService.getOrderedCandidateModels('fake-key-for-test');
      assert.strictEqual(nextOrdered[0], ordered[1]);
      assert.strictEqual(nextOrdered[nextOrdered.length - 1], ordered[0]);
    } finally {
      global.fetch = originalFetch;
      geminiService.clearModelCooldowns();
    }
  });
});
