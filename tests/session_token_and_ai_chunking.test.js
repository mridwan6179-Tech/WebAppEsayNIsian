const test = require('node:test');
const assert = require('node:assert');
const geminiService = require('../src/services/geminiService');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const db = require('../src/config/database');

test('=== SUITE: AI CHUNKING, TRUNCATED JSON REPAIR & ISOLASI TOKEN SESI VS MASTER ===', async (t) => {

  await t.test('1. JSON Repair: Memulihkan JSON Gemini yang terpotong di tengah jalan (Truncated Output)', () => {
    // Simulasi respons JSON terpotong saat menulis pertanyaan ke-3
    const truncatedQuestions = `{
      "questions": [
        {
          "pertanyaan": "Soal 1: Pengertian hardware",
          "opsi_a": "Perangkat keras",
          "opsi_b": "Perangkat lunak",
          "opsi_c": "Pengguna",
          "opsi_d": "Jaringan",
          "kunci_pg": "A",
          "pembahasan": "Hardware adalah perangkat keras komputer."
        },
        {
          "pertanyaan": "Soal 2: Contoh input device",
          "opsi_a": "Monitor",
          "opsi_b": "Keyboard",
          "opsi_c": "Printer",
          "opsi_d": "Speaker",
          "kunci_pg": "B",
          "pembahasan": "Keyboard digunakan untuk memasukkan data teks."
        },
        {
          "pertanyaan": "Soal 3: Fungsi RAM adal`;

    const repaired = geminiService.repairTruncatedJson(truncatedQuestions);
    assert.ok(repaired, 'repaired object should not be null');
    assert.ok(Array.isArray(repaired.questions), 'repaired.questions should be an array');
    assert.strictEqual(repaired.questions.length, 2, 'Should recover 2 complete questions');
    assert.strictEqual(repaired.questions[0].kunci_pg, 'A');
    assert.strictEqual(repaired.questions[1].kunci_pg, 'B');
  });

  await t.test('2. JSON Repair: Memulihkan array langsung yang terpotong di tengah jalan', () => {
    const truncatedArray = `[
      {"pertanyaan": "Soal A", "opsi_a": "1", "opsi_b": "2", "kunci": "A"},
      {"pertanyaan": "Soal B", "opsi_a": "3", "opsi_b": "4", "kunci": "B"},
      {"pertanyaan": "Soal C", "opsi_a`;

    const repaired = geminiService.repairTruncatedJson(truncatedArray);
    assert.ok(Array.isArray(repaired), 'repaired should be an array');
    assert.strictEqual(repaired.length, 2);
    assert.strictEqual(repaired[1].pertanyaan, 'Soal B');
  });

  await t.test('3. Robust Extractor: Mengekstrak format JSON objek bernomor { "1": {...}, "2": {...} }', () => {
    const objectNumbered = {
      "1": {
        pertanyaan: "Apa kepanjangan dari CPU?",
        opsi_a: "Central Processing Unit",
        opsi_b: "Computer Personal Unit",
        kunci_pg: "A"
      },
      "2": {
        pertanyaan: "Apa fungsi dari RAM?",
        opsi_a: "Memori sementara",
        opsi_b: "Penyimpanan permanen",
        kunci_pg: "A"
      }
    };

    const extracted = geminiService.extractQuestionsArray(objectNumbered);
    assert.ok(Array.isArray(extracted), 'Harus berhasil diekstrak menjadi array');
    assert.strictEqual(extracted.length, 2);
    assert.strictEqual(extracted[0].pertanyaan, 'Apa kepanjangan dari CPU?');
    assert.strictEqual(extracted[1].pertanyaan, 'Apa fungsi dari RAM?');
  });

  await t.test('4. Anti-Duplikasi: Mendeteksi kemiripan soal dan menyaring soal yang berulang', () => {
    const q1 = "Apa pengertian dari berpikir komputasional dalam ilmu informatika?";
    const q2 = "Manakah yang merupakan definisi berpikir komputasional dalam informatika?"; // Duplikat konsep
    const q3 = "Apa fungsi utama dari Random Access Memory (RAM) pada komputer?"; // Berbeda

    assert.strictEqual(geminiService.isDuplicateQuestion(q1, q2), true, 'Harus mendeteksi q1 dan q2 sebagai duplikat konsep');
    assert.strictEqual(geminiService.isDuplicateQuestion(q1, q3), false, 'q1 dan q3 bukan duplikat');

    const rawList = [
      { pertanyaan: q1, kunci_pg: 'A' },
      { pertanyaan: q2, kunci_pg: 'B' },
      { pertanyaan: q3, kunci_pg: 'C' }
    ];

    const deduplicated = geminiService.deduplicateQuestions(rawList);
    assert.strictEqual(deduplicated.length, 2, 'Soal duplikat harus dieliminasi');
    assert.strictEqual(deduplicated[0].pertanyaan, q1);
    assert.strictEqual(deduplicated[1].pertanyaan, q3);
  });

  await t.test('5. Anti-Duplikasi Prompt: Prompt PG Kompleks menerima daftar soal PG Biasa sebagai larangan', () => {
    const prompt = geminiService.buildMultipleChoicePrompt({
      topik: 'Informatika',
      jumlahSoal: 5,
      tipePg: 'pg_kompleks',
      soalSudahAda: [
        { pertanyaan: 'Apa pengertian dari dekomposisi dalam berpikir komputasional?' },
        { pertanyaan: 'Sebutkan fungsi dari ALU pada processor komputer!' }
      ]
    });

    assert.match(prompt, /PANDUAN ANTI-DUPLIKASI|INSTRUKSI PENTING ANTI-DUPLIKASI/i);
    assert.match(prompt, /DILARANG KERAS membuat soal yang sama/i);
    assert.match(prompt, /dekomposisi dalam berpikir komputasional/i);
    assert.match(prompt, /ALU pada processor/i);
  });

  await t.test('6. AI Generator: Auto-chunking untuk permintaan soal > 10 butir (misal 20 soal PG Biasa)', async () => {
    const originalCallJsonPrompt = geminiService.callJsonPrompt;
    let callCount = 0;
    const requestedAmounts = [];

    // Mock callJsonPrompt untuk memverifikasi bahwa 20 soal dipecah menjadi sub-batch <= 10
    geminiService.callJsonPrompt = async (prompt) => {
      callCount++;
      const match = prompt.match(/tepat (\d+) butir soal/i);
      const count = match ? parseInt(match[1], 10) : 10;
      requestedAmounts.push(count);

      const items = [];
      for (let i = 1; i <= count; i++) {
        items.push({
          pertanyaan: `Pertanyaan butir #${callCount}-${i}`,
          opsi_a: 'Opsi A',
          opsi_b: 'Opsi B',
          opsi_c: 'Opsi C',
          opsi_d: 'Opsi D',
          kunci_pg: 'A',
          jenis_pg: 'pilihan_ganda',
          pembahasan: 'Pembahasan butir ini.'
        });
      }
      return { questions: items };
    };

    try {
      const result = await geminiService.generateMultipleChoiceQuestions({
        topik: 'Sistem Komputer',
        jumlahSoal: 20,
        tipePg: 'pg_biasa'
      });

      assert.strictEqual(callCount, 2, 'Should invoke 2 sub-batch calls for 20 questions');
      assert.deepStrictEqual(requestedAmounts.sort((a, b) => a - b), [10, 10], 'Should split 20 questions into 10 and 10');
      assert.strictEqual(result.length, 20, 'Total merged questions should be 20');
      assert.strictEqual(result[0].nomor, 1);
      assert.strictEqual(result[19].nomor, 20);
    } finally {
      geminiService.callJsonPrompt = originalCallJsonPrompt;
    }
  });

  await t.test('7. AI Generator: Permintaan 22 soal (15 Biasa + 7 Kompleks) anti-duplikasi & tanpa timeout', async () => {
    const originalCallJsonPrompt = geminiService.callJsonPrompt;
    const batchSizes = [];
    const receivedBans = [];

    geminiService.callJsonPrompt = async (prompt) => {
      const match = prompt.match(/tepat (\d+) butir soal/i);
      const count = match ? parseInt(match[1], 10) : 7;
      batchSizes.push(count);

      const hasBan = prompt.includes('INSTRUKSI PENTING ANTI-DUPLIKASI');
      receivedBans.push(hasBan);

      const isKompleks = prompt.includes('PILIHAN GANDA KOMPLEKS');
      const items = [];
      for (let i = 1; i <= count; i++) {
        items.push({
          pertanyaan: `Soal #${batchSizes.length}-${i} (${isKompleks ? 'Kompleks' : 'Biasa'})`,
          opsi_a: 'Opsi 1',
          opsi_b: 'Opsi 2',
          opsi_c: 'Opsi 3',
          opsi_d: 'Opsi 4',
          kunci_pg: isKompleks ? 'A, C' : 'B',
          jenis_pg: isKompleks ? 'pg_kompleks' : 'pilihan_ganda',
          pembahasan: 'Pembahasan'
        });
      }
      return { questions: items };
    };

    try {
      const result = await geminiService.generateMultipleChoiceQuestions({
        topik: 'Algoritma & Pemrograman',
        jumlahSoal: 22,
        tipePg: 'campuran',
        jumlahPgBiasa: 15,
        jumlahPgKompleks: 7,
        kunciKompleksRule: 'tepat_2'
      });

      assert.strictEqual(result.length, 22, 'Total 22 questions generated');
      // 15 biasa dipecah jadi 8 + 7, lalu 7 kompleks -> total 3 sub-panggilan
      assert.strictEqual(batchSizes.length, 3);
      assert.deepStrictEqual(batchSizes.sort((a, b) => a - b), [7, 7, 8]);

      // Verifikasi bahwa panggilan ke-2 dan ke-3 menerima instruksi anti-duplikasi
      assert.strictEqual(receivedBans[1], true, 'Sub-batch 2 harus menerima daftar larangan soal sub-batch 1');
      assert.strictEqual(receivedBans[2], true, 'PG Kompleks harus menerima daftar larangan seluruh soal PG Biasa');

      const biasaItems = result.filter(q => q.tipe_pg === 'pg_biasa');
      const kompleksItems = result.filter(q => q.tipe_pg === 'pg_kompleks');
      assert.strictEqual(biasaItems.length, 15);
      assert.strictEqual(kompleksItems.length, 7);
      assert.strictEqual(result[21].nomor, 22);
    } finally {
      geminiService.callJsonPrompt = originalCallJsonPrompt;
    }
  });

  await t.test('8. Keamanan Token: Mencegah duplikasi dan bentrok token antara kode ujian induk dan sesi', () => {
    const rand = Math.floor(Math.random() * 8999 + 1000);
    const ulangan = examService.createUlangan(1, {
      judul: `Ujian Uji Token dan Sesi ${rand}`,
      mata_pelajaran: 'Informatika',
      tingkat_kelas: '7A, 7B',
      durasi_menit: 90
    });
    const masterCode = ulangan.kode_ujian;
    assert.ok(masterCode, 'Master code must exist');

    // 1. Coba buat sesi dengan token yang SAMA dengan master code -> HARUS GAGAL
    assert.throws(() => {
      examService.createSesi(ulangan.id, 1, {
        nama_sesi: 'Sesi Uji Duplikat Master',
        kode_sesi: masterCode,
        kelas: '7A'
      });
    }, /sama dengan kode ujian utama/i);

    // 2. Buat sesi valid dengan kode unik
    const codeSesiA = `S7A-${rand}`;
    const sesiA = examService.createSesi(ulangan.id, 1, {
      nama_sesi: 'Sesi 1 Kelas 7A',
      kode_sesi: codeSesiA,
      kelas: '7A'
    });
    assert.strictEqual(sesiA.kode_sesi, codeSesiA);

    // 3. Coba ubah master code ulangan menjadi kode sesi -> HARUS GAGAL
    assert.throws(() => {
      examService.updateUlangan(ulangan.id, 1, {
        kode_ujian: codeSesiA
      });
    }, /sudah digunakan oleh salah satu sesi/i);

    // 4. Coba ubah kode sesi menjadi kode master -> HARUS GAGAL
    assert.throws(() => {
      examService.updateSesi(sesiA.id, 1, {
        kode_sesi: masterCode
      });
    }, /sama dengan kode ujian utama/i);
  });

  await t.test('9. Validasi Portal Siswa: Token Bawaan (Master) dan Token Sesi berfungsi independen tanpa tumpang tindih', () => {
    const rand = Math.floor(Math.random() * 8999 + 1000);
    const ulangan = examService.createUlangan(1, {
      judul: `Ulangan Semester Genap Informatika ${rand}`,
      mata_pelajaran: 'Informatika',
      tingkat_kelas: '8A, 8B',
      durasi_menit: 60
    });
    examService.updateUlangan(ulangan.id, 1, { status: 'dibuka' });

    const codePagi = `PAGI-${rand}`;
    const codeSiang = `SIANG-${rand}`;

    const sesi1 = examService.createSesi(ulangan.id, 1, {
      nama_sesi: 'Sesi Pagi - Kelas 8A',
      kode_sesi: codePagi,
      kelas: '8A'
    });
    const sesi2 = examService.createSesi(ulangan.id, 1, {
      nama_sesi: 'Sesi Siang - Kelas 8B',
      kode_sesi: codeSiang,
      kelas: '8B'
    });

    // Kasus A: Siswa memasukkan Token Bawaan (Master)
    const resMaster = studentService.validateExamCode(ulangan.kode_ujian);
    assert.strictEqual(resMaster.valid, true);
    assert.strictEqual(resMaster.sesi, null, 'Tidak terkunci ke sesi tertentu');
    assert.ok(Array.isArray(resMaster.daftar_sesi), 'Daftar sesi harus disertakan untuk pemilih sesi');
    assert.ok(resMaster.daftar_sesi.some(s => s.kode_sesi === codePagi));
    assert.ok(resMaster.daftar_sesi.some(s => s.kode_sesi === codeSiang));

    // Kasus B: Siswa membuka Link Sesi 1 (misal via link /?kode=PAGI-XXXX)
    const resSesi1 = studentService.validateExamCode(codePagi);
    assert.strictEqual(resSesi1.valid, true);
    assert.ok(resSesi1.sesi, 'Terkunci langsung ke sesi 1');
    assert.strictEqual(resSesi1.sesi.nama_sesi, 'Sesi Pagi - Kelas 8A');
    assert.deepStrictEqual(resSesi1.available_classes, ['8A'], 'Pilihan kelas dibatasi khusus 8A');

    // Kasus C: Siswa membuka Link Sesi 2 (misal via link /?kode=SIANG-XXXX)
    const resSesi2 = studentService.validateExamCode(codeSiang);
    assert.strictEqual(resSesi2.valid, true);
    assert.ok(resSesi2.sesi, 'Terkunci langsung ke sesi 2');
    assert.strictEqual(resSesi2.sesi.nama_sesi, 'Sesi Siang - Kelas 8B');
    assert.deepStrictEqual(resSesi2.available_classes, ['8B'], 'Pilihan kelas dibatasi khusus 8B');
  });

});
