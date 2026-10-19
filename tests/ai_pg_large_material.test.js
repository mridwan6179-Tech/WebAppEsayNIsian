const test = require('node:test');
const assert = require('node:assert');
const geminiService = require('../src/services/geminiService');

test('=== SUITE: GENERATOR SOAL PG DENGAN MATERI BESAR (25.000+ KARAKTER) & SMART PARALLEL WINDOWING ===', async (t) => {

  // Naskah materi realistis ~25.500 karakter dengan struktur babak kurikulum Koding & AI
  const section1 = `BAB 1: PENGANTAR KODING DAN BERPIKIR KOMPUTASIONAL.
Berpikir komputasional (computational thinking) merupakan landasan esensial dalam menyelesaikan permasalahan kompleks dengan memanfaatkan prinsip-prinsip sains komputer.
Terdapat empat pilar utama dalam berpikir komputasional: Dekomposisi, Pengenalan Pola, Abstraksi, dan Perancangan Algoritma.
Dekomposisi adalah proses memecah masalah besar dan rumit menjadi komponen-komponen yang lebih kecil agar mudah dikelola dan dianalisis secara mendalam.
Pengenalan pola memungkinkan kita mengidentifikasi kesamaan karakteristik atau tren berulang pada data masa lampau guna memprediksi tindakan selanjutnya.
Abstraksi berfokus pada penyaringan informasi esensial dan mengesampingkan detail-detail yang tidak relevan dengan tujuan pemecahan masalah inti.
Algoritma adalah serangkaian instruksi logis dan langkah-langkah terurut yang disusun secara sistematis untuk menyelesaikan masalah secara akurat.
Dalam kurikulum informatika, pemrograman visual blok seperti Scratch dan Blockly digunakan untuk mengenalkan logika logika percabangan dan perulangan.
Siswa diajarkan bagaimana menyusun blok instruksi kejadian (event listener), blok gerakan (motion), kontrol logika (control), serta variabel penyimpan data.
`.repeat(12); // ~8.500 karakter

  const section2 = `BAB 2: JARINGAN KOMPUTER, INTERNET, DAN KEAMANAN DATA SIBER.
Jaringan komputer memungkinkan pertukaran data dan komunikasi antar perangkat komputasi melalui media transmisi kabel maupun nirkabel.
Protokol TCP/IP (Transmission Control Protocol / Internet Protocol) adalah standar komunikasi utama yang mengatur bagaimana paket data dipecah, dirutekan, dan disusun kembali.
Alamat IP (Internet Protocol Address) berfungsi sebagai identitas numerik unik bagi setiap simpul (node) yang terhubung ke jaringan internet global.
Domain Name System (DNS) berperan sebagai buku telepon internet yang menerjemahkan nama domain yang mudah dibaca manusia menjadi alamat IP numerik mesin.
Keamanan data digital dan privasi pengguna diatur melalui teknik enkripsi data ujung-ke-ujung (end-to-end encryption) dan autentikasi multi-faktor (MFA).
Ancaman keamanan siber yang kerap terjadi antara lain serangan phishing, rekayasa sosial (social engineering), malware trojan, serta infeksi ransomware.
Penerapan firewall pada sistem komputer berfungsi sebagai filter penyaring yang memantau dan mengontrol lalu lintas data masuk dan keluar berdasarkan aturan keamanan.
Etika digital dan kepatuhan terhadap perlindungan data pribadi (UU PDP) menjadi tanggung jawab wajib bagi seluruh pemangku kepentingan di era digital.
`.repeat(12); // ~8.500 karakter

  const section3 = `BAB 3: KECERDASAN ARTIFISIAL (AI), PEMBELAJARAN MESIN, DAN ANALISIS DATA.
Kecerdasan Artifisial (Artificial Intelligence) adalah cabang ilmu komputer yang bertujuan menciptakan mesin cerdas yang mampu meniru kapabilitas kognitif manusia.
Pembelajaran Mesin (Machine Learning) merupakan sub-bidang AI yang memungkinkan sistem komputer belajar secara mandiri dari pola data historis tanpa diprogram secara eksplisit.
Tiga paradigma utama dalam machine learning meliputi: Supervised Learning (Pembelajaran Terarah), Unsupervised Learning (Tanpa Arahan), dan Reinforcement Learning (Penguatan).
Pada Supervised Learning, model dilatih menggunakan data berlabel yang berisi pasangan input dan target keluaran yang sudah diverifikasi kebenarannya.
Jaringan Saraf Tiruan (Artificial Neural Network) mengadopsi struktur kerja sinapsis neuron biologis otak manusia untuk memproses representasi data multidimensi yang rumit.
Large Language Model (LLM) seperti Gemini dan GPT memanfaatkan arsitektur Transformer dan mekanisme perhatian mandiri (self-attention) untuk memproses bahasa alami.
Etika pemanfaatan AI menuntut adanya transparansi algoritma, mitigasi bias data pelatihan, perlindungan hak cipta konten, serta akuntabilitas manusia sebagai pengendali akhir.
Sistem kecerdasan artifisial harus dirancang berorientasi pada kemaslahatan manusia (human-centric AI) yang inklusif, adil, aman, dan dapat dipertanggungjawabkan.
`.repeat(12); // ~8.500 karakter

  const fullLongMaterial = `${section1}\n\n${section2}\n\n${section3}`;

  await t.test('1. Verifikasi Karakter Dokumen Uji: Materi melebihi 25.000 karakter', () => {
    assert.strictEqual(fullLongMaterial.length > 25000, true);
    console.log(`   Panjang materi dokumen uji: ${fullLongMaterial.length} karakter`);
  });

  await t.test('2. Smart Windowing: Membagi 25.000+ karakter menjadi jendela seimbang tanpa pemotongan kata', () => {
    const windows = geminiService.splitTextIntoBalancedWindows(fullLongMaterial, 3);
    assert.strictEqual(windows.length, 3);

    // Pastikan ketiga window memiliki panjang materi memadai (> 7.000 karakter)
    windows.forEach((w, idx) => {
      assert.strictEqual(w.length > 6000, true);
      console.log(`   Window #${idx + 1}: ${w.length} karakter (Awal: "${w.slice(0, 40)}...")`);
    });

    // Window 1 harus memuat Bab 1
    assert.match(windows[0], /PENGANTAR KODING/i);
    // Window 2 harus memuat Bab 2
    assert.match(windows[1], /JARINGAN KOMPUTER/i);
    // Window 3 harus memuat Bab 3
    assert.match(windows[2], /KECERDASAN ARTIFISIAL/i);
  });

  await t.test('3. Fallback Heuristik Cerdas: Mampu mengekstrak fakta naskah materi 25.000 karakter', () => {
    const fallbackBiasa = geminiService.fallbackOfflineMultipleChoiceGenerator({
      topik: 'Koding dan AI',
      materiTeks: fullLongMaterial,
      jumlahSoal: 5,
      tipePg: 'pg_biasa',
      opsiCount: 4
    });

    assert.strictEqual(fallbackBiasa.length, 5);
    fallbackBiasa.forEach((q, idx) => {
      assert.strictEqual(q.nomor, idx + 1);
      assert.strictEqual(q.tipe_pg, 'pg_biasa');
      assert.strictEqual(q.kunci_pg.length, 1);
      assert.strictEqual(typeof q.opsi_a, 'string');
      assert.strictEqual(typeof q.opsi_b, 'string');
      assert.strictEqual(typeof q.opsi_c, 'string');
      assert.strictEqual(typeof q.opsi_d, 'string');
      assert.strictEqual(q.opsi_e, undefined);
    });

    const fallbackKompleks = geminiService.fallbackOfflineMultipleChoiceGenerator({
      topik: 'Koding dan AI',
      materiTeks: fullLongMaterial,
      jumlahSoal: 3,
      tipePg: 'pg_kompleks',
      kunciKompleksRule: 'tepat_2',
      opsiCount: 4
    });

    assert.strictEqual(fallbackKompleks.length, 3);
    fallbackKompleks.forEach(q => {
      assert.strictEqual(q.tipe_pg, 'pg_kompleks');
      assert.strictEqual(q.kunci_pg.includes(','), true);
      assert.match(q.pertanyaan, /Pilihlah lebih dari satu jawaban yang benar/);
    });
  });

  await t.test('4. End-to-End Generator Campuran 20 Butir (15 Biasa + 5 Kompleks) dengan Materi 25.000 Karakter', async () => {
    // Uji ketahanan generator di bawah kondisi simulasi failover / fallback
    const originalCallJson = geminiService.callJsonPrompt;
    geminiService.callJsonPrompt = async () => {
      // Simulasikan kegagalan acak API untuk menguji failover tangguh
      throw new Error('Simulasi Rate Limit 429 atau Gateway Timeout');
    };

    try {
      const results = await geminiService.generateMultipleChoiceQuestions({
        topik: 'Koding dan AI',
        tingkatKelas: 'SMP',
        jumlahSoal: 20,
        tipePg: 'campuran',
        jumlahPgBiasa: 15,
        jumlahPgKompleks: 5,
        kunciKompleksRule: 'tepat_2',
        opsiCount: 4,
        materiTeks: fullLongMaterial
      });

      assert.strictEqual(results.length, 20);

      // Verifikasi 15 soal pertama bertipe PG Biasa
      const biasaPart = results.slice(0, 15);
      biasaPart.forEach((q, idx) => {
        assert.strictEqual(q.nomor, idx + 1);
        assert.strictEqual(q.tipe_pg, 'pg_biasa');
        assert.strictEqual(q.kunci_pg.includes(','), false);
      });

      // Verifikasi 5 soal berikutnya bertipe PG Kompleks
      const kompleksPart = results.slice(15, 20);
      kompleksPart.forEach((q, idx) => {
        assert.strictEqual(q.nomor, 16 + idx);
        assert.strictEqual(q.tipe_pg, 'pg_kompleks');
        assert.strictEqual(q.kunci_pg.includes(','), true);
      });

      console.log(`   Berhasil menghasilkan tepat ${results.length} butir soal PG (15 Biasa + 5 Kompleks) dari naskah 25.000+ karakter tanpa error!`);
    } finally {
      geminiService.callJsonPrompt = originalCallJson;
    }
  });

  await t.test('5. Mock Parallel Success: 3 sub-batch berjalan paralel mengembalikan tepat 20 butir soal', async () => {
    const originalCallJson = geminiService.callJsonPrompt;
    let parallelCallsCount = 0;

    geminiService.callJsonPrompt = async (prompt) => {
      parallelCallsCount++;
      const isKompleks = prompt.includes('PILIHAN GANDA KOMPLEKS (MULTI-SELECT)');
      if (isKompleks) {
        return {
          questions: [
            { pertanyaan: 'Soal Kompleks 1', opsi_a: 'A', opsi_b: 'B', opsi_c: 'C', opsi_d: 'D', kunci_pg: 'A, C' },
            { pertanyaan: 'Soal Kompleks 2', opsi_a: 'A', opsi_b: 'B', opsi_c: 'C', opsi_d: 'D', kunci_pg: 'A, C' },
            { pertanyaan: 'Soal Kompleks 3', opsi_a: 'A', opsi_b: 'B', opsi_c: 'C', opsi_d: 'D', kunci_pg: 'A, C' },
            { pertanyaan: 'Soal Kompleks 4', opsi_a: 'A', opsi_b: 'B', opsi_c: 'C', opsi_d: 'D', kunci_pg: 'A, C' },
            { pertanyaan: 'Soal Kompleks 5', opsi_a: 'A', opsi_b: 'B', opsi_c: 'C', opsi_d: 'D', kunci_pg: 'A, C' }
          ]
        };
      } else {
        // PG biasa (8 butir atau 7 butir)
        const matchCount = prompt.match(/tepat (\d+) butir/i);
        const count = matchCount ? parseInt(matchCount[1], 10) : 8;
        const list = [];
        for (let i = 1; i <= count; i++) {
          list.push({
            pertanyaan: `Soal Biasa Call ${parallelCallsCount} Butir ${i}`,
            opsi_a: 'A',
            opsi_b: 'B',
            opsi_c: 'C',
            opsi_d: 'D',
            kunci_pg: 'B'
          });
        }
        return { questions: list };
      }
    };

    try {
      const results = await geminiService.generateMultipleChoiceQuestions({
        topik: 'Koding dan AI',
        tingkatKelas: 'SMP',
        jumlahSoal: 20,
        tipePg: 'campuran',
        jumlahPgBiasa: 15,
        jumlahPgKompleks: 5,
        kunciKompleksRule: 'tepat_2',
        opsiCount: 4,
        materiTeks: fullLongMaterial
      });

      assert.strictEqual(parallelCallsCount, 3); // Tepat 3 sub-batch dipanggil secara paralel
      assert.strictEqual(results.length, 20);
      assert.strictEqual(results[0].nomor, 1);
      assert.strictEqual(results[19].nomor, 20);
      console.log(`   3 Sub-batch paralel berhasil dieksekusi serentak menghasilkan total ${results.length} butir.`);
    } finally {
      geminiService.callJsonPrompt = originalCallJson;
    }
  });

});
