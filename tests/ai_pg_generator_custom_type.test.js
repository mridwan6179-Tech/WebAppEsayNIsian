const test = require('node:test');
const assert = require('node:assert');
const geminiService = require('../src/services/geminiService');
const examService = require('../src/services/examService');
const db = require('../src/config/database');

test('=== SUITE: AI GENERATOR PG BIASA & PG KOMPLEKS (CUSTOM KOMPOSISI & JUMLAH KUNCI BENAR) ===', async (t) => {

  await t.test('1. Prompt Builder: Menghasilkan instruksi PG Biasa murni (1 Kunci Jawaban)', () => {
    const prompt = geminiService.buildMultipleChoicePrompt({
      topik: 'Algoritma Pemrograman SMP',
      jumlahSoal: 20,
      tipePg: 'pg_biasa',
      opsiCount: 4,
      bahasa: 'Bahasa Indonesia'
    });

    assert.match(prompt, /tepat 20 butir soal/i);
    assert.match(prompt, /Pilihan Ganda Tunggal standar \(hanya 1 opsi jawaban benar\)/);
    assert.match(prompt, /"jenis_pg": "pilihan_ganda"/);
  });

  await t.test('2. Prompt Builder: Menghasilkan instruksi PG Kompleks dengan TEPAT 2 Kunci Benar', () => {
    const prompt = geminiService.buildMultipleChoicePrompt({
      topik: 'Jaringan Komputer dan Internet',
      jumlahSoal: 5,
      tipePg: 'pg_kompleks',
      kunciKompleksRule: 'tepat_2',
      opsiCount: 4
    });

    assert.match(prompt, /PILIHAN GANDA KOMPLEKS \(MULTI-SELECT\)/);
    assert.match(prompt, /TEPAT 2 OPSI JAWABAN BENAR/);
    assert.match(prompt, /"jenis_pg": "pg_kompleks"/);
    assert.match(prompt, /\(Pilihlah lebih dari satu jawaban yang benar\)/);
  });

  await t.test('3. Prompt Builder: Menghasilkan instruksi PG Kompleks dengan TEPAT 3 Kunci Benar', () => {
    const prompt = geminiService.buildMultipleChoicePrompt({
      topik: 'Dampak Sosial Informatika',
      jumlahSoal: 5,
      tipePg: 'pg_kompleks',
      kunciKompleksRule: 'tepat_3',
      opsiCount: 5
    });

    assert.match(prompt, /TEPAT 3 OPSI JAWABAN BENAR/);
    assert.match(prompt, /A, B, C, D, dan E/);
  });

  await t.test('4. Prompt Builder: Menghasilkan instruksi Campuran (20 PG Biasa + 5 PG Kompleks)', () => {
    const prompt = geminiService.buildMultipleChoicePrompt({
      topik: 'Berpikir Komputasional & Koding',
      jumlahSoal: 25,
      tipePg: 'campuran',
      jumlahPgBiasa: 20,
      jumlahPgKompleks: 5,
      kunciKompleksRule: 'tepat_2',
      opsiCount: 4
    });

    assert.match(prompt, /KOMBINASI CAMPURAN \(20 PG Biasa \+ 5 PG Kompleks\)/);
    assert.match(prompt, /Tepat 20 butir soal PERTAMA/);
    assert.match(prompt, /Tepat 5 butir soal BERIKUTNYA/);
    assert.match(prompt, /TEPAT 2 OPSI JAWABAN BENAR/);
  });

  await t.test('5. Bulk Create Soal: Guru dapat menyimpan 25 butir soal (20 Biasa + 5 Kompleks) sekaligus', () => {
    // Buat ulangan dummy untuk pengetesan bulk insert
    const ulangan = examService.createUlangan(1, {
      judul: 'Uji Coba AI PG Campuran 25 Soal',
      mata_pelajaran: 'Informatika',
      tingkat_kelas: '8 SMP',
      durasi_menit: 60
    });

    const dummySoalList = [];
    // 20 soal PG Biasa
    for (let i = 1; i <= 20; i++) {
      dummySoalList.push({
        jenis: 'pilihan_ganda',
        tipe_pg: 'pg_biasa',
        pertanyaan: `Soal PG Biasa #${i}: Apa kepanjangan dari CPU?`,
        opsi_a: 'Central Processing Unit',
        opsi_b: 'Computer Personal Unit',
        opsi_c: 'Control Program Unit',
        opsi_d: 'Central Performance Utility',
        kunci_pg: 'A',
        bobot: 4,
        pembahasan: 'CPU adalah Central Processing Unit.'
      });
    }
    // 5 soal PG Kompleks (tepat 2 kunci benar)
    for (let i = 21; i <= 25; i++) {
      dummySoalList.push({
        jenis: 'pilihan_ganda',
        tipe_pg: 'pg_kompleks',
        pertanyaan: `Soal PG Kompleks #${i}: Manakah yang termasuk perangkat output? (Pilihlah lebih dari satu jawaban yang benar)`,
        opsi_a: 'Monitor',
        opsi_b: 'Keyboard',
        opsi_c: 'Speaker',
        opsi_d: 'Mouse',
        kunci_pg: 'A, C',
        bobot: 4,
        pembahasan: 'Monitor dan Speaker adalah perangkat output.'
      });
    }

    const inserted = examService.createSoalBulk(ulangan.id, dummySoalList);
    assert.strictEqual(inserted.length, 25);

    const checkList = examService.getSoalByUlangan(ulangan.id);
    assert.strictEqual(checkList.length, 25);

    // Cek butir pertama (biasa)
    assert.strictEqual(checkList[0].kunci_pg, 'A');
    assert.strictEqual(checkList[0].kunci_pg.includes(','), false);

    // Cek butir ke-21 (kompleks)
    assert.strictEqual(checkList[20].kunci_pg, 'A, C');
    assert.strictEqual(checkList[20].kunci_pg.includes(','), true);

    // Cleanup ulangan dummy
    examService.deleteUlangan(ulangan.id, 1);
  });

  await t.test('6. Mock AI Execution: Generate Campuran 20 Biasa + 5 Kompleks via Mock Engine', async () => {
    const originalCallJsonPrompt = geminiService.callJsonPrompt;

    // Mock response cerdas sesuai parameter prompt
    geminiService.callJsonPrompt = async (prompt) => {
      const isKompleks = prompt.includes('PILIHAN GANDA KOMPLEKS (MULTI-SELECT)');
      if (isKompleks) {
        return {
          questions: [
            {
              pertanyaan: 'Manakah fondasi Computational Thinking? (Pilihlah lebih dari satu jawaban yang benar)',
              opsi_a: 'Dekomposisi',
              opsi_b: 'Abstraksi',
              opsi_c: 'Spekulasi',
              opsi_d: 'Manipulasi',
              kunci_pg: 'A, B',
              jenis_pg: 'pg_kompleks',
              pembahasan: 'Fondasi CT adalah Dekomposisi, Pola, Abstraksi, Algoritma.'
            },
            {
              pertanyaan: 'Manakah bahasa pemrograman visual blok?',
              opsi_a: 'Scratch',
              opsi_b: 'Blockly',
              opsi_c: 'Assembly',
              opsi_d: 'Binary',
              kunci_pg: 'A, B',
              jenis_pg: 'pg_kompleks',
              pembahasan: 'Scratch dan Blockly adalah visual blok.'
            }
          ]
        };
      } else {
        return {
          questions: [
            {
              pertanyaan: 'Simbol flow chart untuk keputusan (decision) adalah...',
              opsi_a: 'Belah ketupat',
              opsi_b: 'Persegi panjang',
              opsi_c: 'Oval',
              opsi_d: 'Jajar genjang',
              kunci_pg: 'A',
              jenis_pg: 'pilihan_ganda',
              pembahasan: 'Belah ketupat melambangkan decision.'
            },
            {
              pertanyaan: 'Penulisan logika langkah demi langkah disebut...',
              opsi_a: 'Algoritma',
              opsi_b: 'Hardware',
              opsi_c: 'Kompiler',
              opsi_d: 'Sistem Operasi',
              kunci_pg: 'A',
              jenis_pg: 'pilihan_ganda',
              pembahasan: 'Langkah terurut adalah algoritma.'
            }
          ]
        };
      }
    };

    try {
      const results = await geminiService.generateMultipleChoiceQuestions({
        topik: 'Informatika SMP',
        tipePg: 'campuran',
        jumlahPgBiasa: 2,
        jumlahPgKompleks: 2,
        kunciKompleksRule: 'tepat_2',
        opsiCount: 4
      });

      assert.strictEqual(results.length, 4);
      // 2 soal pertama bertipe biasa
      assert.strictEqual(results[0].tipe_pg, 'pg_biasa');
      assert.strictEqual(results[0].kunci_pg, 'A');
      assert.strictEqual(results[1].tipe_pg, 'pg_biasa');

      // 2 soal berikutnya bertipe kompleks
      assert.strictEqual(results[2].tipe_pg, 'pg_kompleks');
      assert.strictEqual(results[2].kunci_pg, 'A, B');
      assert.match(results[2].pertanyaan, /Pilihlah lebih dari satu jawaban yang benar/);
      assert.strictEqual(results[3].tipe_pg, 'pg_kompleks');
      assert.strictEqual(results[3].kunci_pg, 'A, B');
    } finally {
      geminiService.callJsonPrompt = originalCallJsonPrompt;
    }
  });

});
