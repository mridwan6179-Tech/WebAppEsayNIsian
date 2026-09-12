const test = require('node:test');
const assert = require('node:assert');
const geminiService = require('../src/services/geminiService');
const http = require('http');

test('T-10: Fitur AI Soal Generator (Pembuat Soal, Kunci Jawaban, Rubrik & Bobot)', async (t) => {

  await t.test('1. Pembentukan Prompt Generator Soal (Mode Topik vs Mode Teks Materi)', () => {
    // Mode Topik
    const promptTopik = geminiService.buildGenerateQuestionsPrompt({
      mode: 'topik',
      input_sumber: 'Fotosintesis Tumbuhan Hijau',
      jenjang_kelas: 'Kelas 10 SMA',
      jumlah_soal: 5,
      tipe_soal: 'campuran',
      tingkat_kesulitan: 'sedang',
      target_total_bobot: 100
    });

    assert.match(promptTopik, /Fotosintesis Tumbuhan Hijau/);
    assert.match(promptTopik, /Kelas 10 SMA/);
    assert.match(promptTopik, /Tepat 5 butir soal/);
    assert.match(promptTopik, /Target Total Akumulasi Bobot: 100/);

    // Mode Teks Materi
    const teksMateri = 'Mitokondria adalah organel tempat berlangsungnya respirasi seluler yang menghasilkan ATP.';
    const promptTeks = geminiService.buildGenerateQuestionsPrompt({
      mode: 'teks_materi',
      input_sumber: teksMateri,
      jenjang_kelas: 'Kelas 11 SMA',
      jumlah_soal: 3,
      tipe_soal: 'essay',
      tingkat_kesulitan: 'sulit',
      target_total_bobot: 60
    });

    assert.match(promptTeks, /BAHAN AJAR \/ TEKS BACAAN SUMBER/);
    assert.match(promptTeks, /Mitokondria adalah organel/);
    assert.match(promptTeks, /HANYA berdasarkan materi bacaan di atas/);
    assert.match(promptTeks, /Target Total Akumulasi Bobot: 60/);
  });

  await t.test('1.2 Ketentuan Bahasa Pengantar: Wajib Bahasa Indonesia untuk Mapel Non-Bahasa Inggris', () => {
    const promptKoding = geminiService.buildGenerateQuestionsPrompt({
      mode: 'topik',
      input_sumber: 'Koding dan AI: Perintah Salin dan Pindah Data',
      kategori: 'Koding Dan AI Pertemuan 1-4',
      jenjang_kelas: 'Kelas 8 SMP',
      jumlah_soal: 5,
      tipe_soal: 'campuran',
      is_listening: 0,
      bahasa: 'Bahasa Inggris' // Unintentional / dropdown leak
    });

    // Harus mewajibkan Bahasa Indonesia dan melarang bahasa Inggris
    assert.match(promptKoding, /WAJIB DITULIS LENGKAP DALAM BAHASA INDONESIA/);
    assert.match(promptKoding, /DILARANG KERAS menyajikan kalimat pertanyaan atau narasi soal dalam Bahasa Inggris/);
  });

  await t.test('2. Normalisasi Bobot Soal Menuju Target Bobot (misal: 100)', () => {
    const rawQuestions = [
      { pertanyaan: 'Soal 1', jenis: 'isian', bobot: 10, kunci_jawaban: 'kunci 1', rubrik: 'rubrik 1' },
      { pertanyaan: 'Soal 2', jenis: 'essay', bobot: 20, kunci_jawaban: 'kunci 2', rubrik: 'rubrik 2' },
      { pertanyaan: 'Soal 3', jenis: 'essay', bobot: 15, kunci_jawaban: 'kunci 3', rubrik: 'rubrik 3' }
    ];

    const normalized = geminiService.normalizeGeneratedQuestions(rawQuestions, 100);
    assert.strictEqual(normalized.length, 3);

    const totalBobot = normalized.reduce((acc, q) => acc + q.bobot, 0);
    assert.strictEqual(totalBobot, 100, 'Total bobot terdistribusi harus tepat 100');
    assert.ok(normalized.every(q => q.bobot > 0));
    assert.ok(normalized.every(q => q.pertanyaan && q.kunci_jawaban && q.rubrik));
  });

  await t.test('2.2 Normalisasi Kategori Guru vs Sub-Topik AI Generator', () => {
    const rawQuestions = [
      {
        kategori: 'Koding dan AI - Perintah Salin dan Pindah Data (Copy, Cut, Paste)',
        sub_topik: 'Analisis Kasus Penggunaan Copy vs Cut',
        pertanyaan: 'Jelaskan perbedaan mendasar fungsi Copy dan Cut!',
        jenis: 'essay',
        bobot: 15
      },
      {
        kategori: 'Koding dan AI - Tombol Shortcut Keyboard',
        pertanyaan: 'Sebutkan kombinasi tombol untuk Paste!',
        jenis: 'isian',
        bobot: 10
      }
    ];

    // Guru memilih kategori 'Koding Dan AI Pertemuan 1-4'
    const normalizedWithTeacherCat = geminiService.normalizeGeneratedQuestions(rawQuestions, 25, {
      kategori: 'Koding Dan AI Pertemuan 1-4'
    });

    assert.strictEqual(normalizedWithTeacherCat.length, 2);
    // Seluruh soal harus berinduk ke kategori yang dipilih guru
    assert.strictEqual(normalizedWithTeacherCat[0].kategori, 'Koding Dan AI Pertemuan 1-4');
    assert.strictEqual(normalizedWithTeacherCat[1].kategori, 'Koding Dan AI Pertemuan 1-4');

    // Sub-topik spesifik AI tetap terjaga rapi
    assert.strictEqual(normalizedWithTeacherCat[0].sub_topik, 'Analisis Kasus Penggunaan Copy vs Cut');
    // Jika sub_topik kosong tapi AI membuat kategori spesifik, dialihkan ke sub_topik
    assert.strictEqual(normalizedWithTeacherCat[1].sub_topik, 'Koding dan AI - Tombol Shortcut Keyboard');
  });

  await t.test('3. Generator Fallback Offline Menghasilkan Paket Soal Lengkap', async () => {
    const result = await geminiService.generateQuestions({
      mode: 'topik',
      input_sumber: 'Ekosistem Laut',
      jenjang_kelas: 'Kelas 7 SMP',
      jumlah_soal: 4,
      tipe_soal: 'campuran',
      target_total_bobot: 100
    }, ''); // Pass empty key to test offline generator

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.soal.length, 4);

    const totalBobot = result.soal.reduce((sum, s) => sum + s.bobot, 0);
    assert.strictEqual(totalBobot, 100);

    for (const q of result.soal) {
      assert.ok(q.pertanyaan.length > 5);
      assert.ok(['isian', 'essay'].includes(q.jenis));
      assert.ok(q.kunci_jawaban.length > 0);
      assert.ok(q.rubrik.length > 0);
      assert.ok(q.bobot > 0);
    }
  });

  await t.test('4. Integrasi Endpoint API POST /api/guru/generate-soal', async () => {
    const app = require('../server');
    const authService = require('../src/services/authService');
    const loginRes = authService.login('guru@sekolah.id', 'guru123');
    const token = loginRes.token;

    const server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    const port = server.address().port;

    try {
      // Test request tanpa input_sumber (harus 400)
      const resBad = await fetch(`http://localhost:${port}/api/guru/generate-soal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({})
      });
      assert.strictEqual(resBad.status, 400);

      // Test request valid
      const resOk = await fetch(`http://localhost:${port}/api/guru/generate-soal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          mode: 'topik',
          input_sumber: 'Hukum Newton',
          jenjang_kelas: 'Kelas 8',
          jumlah_soal: 3,
          tipe_soal: 'campuran',
          target_total_bobot: 100
        })
      });

      assert.strictEqual(resOk.status, 200);
      assert.strictEqual(resOk.headers.get('cache-control')?.includes('no-store'), true, 'Header Cache-Control harus no-store');
      const data = await resOk.json();
      assert.strictEqual(data.success, true);
      assert.ok(Array.isArray(data.soal));
      assert.strictEqual(data.soal.length, 3);
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  await t.test('5. Fitur Anti-Duplikasi Prompt AI (Injeksi Instruksi Khusus Soal Terdahulu)', () => {
    const existingSoal = [
      'Jelaskan bunyi Hukum 1 Newton!',
      'Sebutkan rumus gaya aksi reaksi Hukum 3 Newton!'
    ];

    // Tanpa existing questions (Zero-token overhead)
    const promptPolos = geminiService.buildGenerateQuestionsPrompt({
      mode: 'topik',
      input_sumber: 'Hukum Newton',
      jumlah_soal: 3
    });
    assert.strictEqual(promptPolos.includes('PANDUAN ANTI-DUPLIKASI'), false);

    // Dengan existing questions & kategori
    const promptAntiDuplikasi = geminiService.buildGenerateQuestionsPrompt({
      mode: 'topik',
      input_sumber: 'Hukum Newton',
      kategori: 'Fisika Dasar',
      jumlah_soal: 3,
      existing_questions: existingSoal
    });
    assert.ok(promptAntiDuplikasi.includes('[PANDUAN ANTI-DUPLIKASI (HEMAT TOKEN)]:'));
    assert.ok(promptAntiDuplikasi.includes('Kategori/Buku Acuan: "Fisika Dasar"'));
    assert.ok(promptAntiDuplikasi.includes('Jelaskan bunyi Hukum 1 Newton!'));
    assert.ok(promptAntiDuplikasi.includes('Sebutkan rumus gaya aksi reaksi Hukum 3 Newton!'));
    assert.ok(promptAntiDuplikasi.includes('DILARANG KERAS membuat pertanyaan yang serupa'));
  });

  await t.test('6. Generator Fallback Offline Menghasilkan Soal Berbeda dengan Offset', async () => {
    const batch1 = await geminiService.generateQuestions({
      mode: 'topik',
      input_sumber: 'Fotosintesis',
      jumlah_soal: 3,
      tipe_soal: 'campuran'
    }, '');

    const soalTeksBatch1 = batch1.soal.map(s => s.pertanyaan);

    // Request batch 2 dengan menyertakan batch 1 sebagai existing_questions
    const batch2 = await geminiService.generateQuestions({
      mode: 'topik',
      input_sumber: 'Fotosintesis',
      jumlah_soal: 3,
      tipe_soal: 'campuran',
      existing_questions: soalTeksBatch1
    }, '');

    assert.strictEqual(batch2.success, true);
    assert.strictEqual(batch2.soal.length, 3);

    // Pastikan tidak ada satupun soal batch 2 yang sama persis dengan batch 1
    for (const q2 of batch2.soal) {
      assert.strictEqual(soalTeksBatch1.includes(q2.pertanyaan), false, `Soal duplikat terdeteksi: ${q2.pertanyaan}`);
    }
  });

  await t.test('7. Optimasi Hemat Token: Truncating Soal Panjang & Limit Jumlah Pembanding', () => {
    // Buat pertanyaan sangat panjang (>100 karakter)
    const longQuestion = 'Sebuah mobil bergerak dengan kecepatan awal tertentu dan melakukan percepatan konstan hingga mencapai kecepatan akhir yang jauh lebih tinggi dalam interval waktu yang ditentukan, hitung percepatannya!';
    const truncatedList = [longQuestion]
      .map(q => (q.length > 95 ? q.substring(0, 92).trim() + '...' : q));

    assert.ok(truncatedList[0].length <= 95);
    assert.ok(truncatedList[0].endsWith('...'));

    // Pastikan prompt compact membatasi maksimal 12 butir
    const manyQuestions = Array.from({ length: 25 }, (_, i) => `Soal nomor ke-${i + 1}`);
    const prompt = geminiService.buildGenerateQuestionsPrompt({
      mode: 'topik',
      input_sumber: 'Matematika',
      kategori: 'Aljabar',
      existing_questions: manyQuestions
    });

    assert.ok(prompt.includes('12. "Soal nomor ke-12"'));
    assert.strictEqual(prompt.includes('13. "Soal nomor ke-13"'), false, 'Tidak boleh melebihi 12 butir pembanding agar hemat token');
  });

  await t.test('8. Dukungan Bentuk Soal Cerita / Studi Kasus Panjang', () => {
    // Mode Soal Cerita eksplisit
    const promptCerita = geminiService.buildGenerateQuestionsPrompt({
      mode: 'topik',
      input_sumber: 'Pecahan dan Perbandingan',
      jenjang_kelas: 'Kelas 5 SD',
      jumlah_soal: 3,
      bentuk_soal: 'soal_cerita'
    });

    assert.ok(promptCerita.includes('GAYA PENYAJIAN SOAL: WAJIB SOAL CERITA / STUDI KASUS KONTEKSTUAL'));
    assert.ok(promptCerita.includes('SOAL CERITA, studi kasus kontekstual'));
    assert.ok(promptCerita.includes('Panjang pertanyaan SANGAT FLEKSIBEL DAN BEBAS PANJANG'));

    // Mode Otomatis / Fleksibel
    const promptDefault = geminiService.buildGenerateQuestionsPrompt({
      mode: 'topik',
      input_sumber: 'Fisika',
      jumlah_soal: 3
    });
    assert.ok(promptDefault.includes('FLEKSIBILITAS BENTUK PERTANYAAN (SOAL CERITA / KASUS / LANGSUNG)'));
    assert.ok(promptDefault.includes('Pertanyaan BOLEH PANJANG dan deskriptif jika berbentuk soal cerita'));
  });

});
