const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');

test('T-02: CRUD Ulangan dan Soal, Normalisasi Nilai (FR-02 - FR-05)', async (t) => {
  // Setup guru dummy
  const guru1 = db.prepare('SELECT id FROM guru LIMIT 1').get();
  assert.ok(guru1, 'Guru harus ada di database');

  let ulanganId = null;
  let soal1Id = null;
  let soal2Id = null;

  await t.test('FR-03: Membuat ulangan baru', () => {
    const data = {
      judul: 'Ulangan Harian Biologi Sel',
      mata_pelajaran: 'Biologi',
      tingkat_kelas: 'Kelas 11',
      deskripsi: 'Materi bab struktur dan fungsi sel'
    };
    const ulangan = examService.createUlangan(guru1.id, data);
    assert.ok(ulangan.id);
    assert.strictEqual(ulangan.judul, data.judul);
    assert.strictEqual(ulangan.status, 'draft');
    assert.strictEqual(typeof ulangan.kode_ujian, 'string');
    assert.strictEqual(ulangan.kode_ujian.length, 6);
    ulanganId = ulangan.id;
  });

  await t.test('FR-02: Satu guru dapat memiliki banyak ulangan & melihat daftarnya', () => {
    const ulangan2 = examService.createUlangan(guru1.id, {
      judul: 'Ulangan Kimia Unsur',
      mata_pelajaran: 'Kimia',
      tingkat_kelas: 'Kelas 10'
    });
    const list = examService.getUlanganByGuru(guru1.id);
    assert.ok(list.length >= 2);
    assert.notStrictEqual(ulanganId, ulangan2.id);
    assert.notStrictEqual(list.find(u => u.id === ulanganId).kode_ujian, ulangan2.kode_ujian);
  });

  await t.test('FR-04: Menolak pembuatan soal dengan bobot <= 0 atau jenis tidak valid', () => {
    assert.throws(() => {
      examService.createSoal(ulanganId, {
        pertanyaan: 'Apa itu mitokondria?',
        jenis: 'pilihan_ganda', // Tidak valid
        bobot: 10
      });
    }, /Jenis soal harus isian atau essay/);

    assert.throws(() => {
      examService.createSoal(ulanganId, {
        pertanyaan: 'Apa itu mitokondria?',
        jenis: 'isian',
        bobot: 0 // Tidak valid
      });
    }, /Bobot soal harus berupa angka lebih besar dari 0/);
  });

  await t.test('FR-04: Membuat soal isian dan essay dengan kunci jawaban & rubrik', () => {
    const soal1 = examService.createSoal(ulanganId, {
      pertanyaan: 'Sebutkan organel sel yang berfungsi menghasilkan energi!',
      jenis: 'isian',
      bobot: 20,
      kunci_jawaban: 'Mitokondria',
      tingkat_kelas: 'Kelas 11',
      tingkat_kesulitan: 'mudah'
    });
    assert.ok(soal1.id);
    assert.strictEqual(soal1.bobot, 20);
    soal1Id = soal1.id;

    const soal2 = examService.createSoal(ulanganId, {
      pertanyaan: 'Jelaskan perbedaan mendasar antara sel hewan dan sel tumbuhan!',
      jenis: 'essay',
      bobot: 30,
      kunci_jawaban: 'Sel tumbuhan memiliki dinding sel, kloroplas, dan vakuola besar. Sel hewan tidak memiliki dinding sel dan kloroplas.',
      rubrik: 'Skor 30 jika menyebutkan dinding sel dan kloroplas. Skor 15 jika hanya menyebutkan salah satu.',
      tingkat_kelas: 'Kelas 11',
      tingkat_kesulitan: 'sedang'
    });
    assert.ok(soal2.id);
    assert.strictEqual(soal2.bobot, 30);
    soal2Id = soal2.id;

    const soalList = examService.getSoalByUlangan(ulanganId);
    assert.strictEqual(soalList.length, 2);
  });

  await t.test('Update dan Hapus Soal', () => {
    const updated = examService.updateSoal(soal1Id, { bobot: 25 });
    assert.strictEqual(updated.bobot, 25);

    // Kembalikan bobot ke 20 untuk tes normalisasi
    examService.updateSoal(soal1Id, { bobot: 20 });
  });

  await t.test('FR-05: Normalisasi Nilai ke Skala 0-100', () => {
    // Total bobot = 20 + 30 = 50. Siswa dapat 20 di soal 1, dan 15 di soal 2 -> total 35/50 = 70/100
    const scoredItems = [
      { bobot: 20, skor_final: 20 },
      { bobot: 30, skor_final: 15 }
    ];
    const normalized = examService.calculateNormalizedScore(scoredItems);
    assert.strictEqual(normalized, 70);

    // Kasus total bobot 120, siswa dapat 90 -> 90/120 * 100 = 75
    const scoredItems2 = [
      { bobot: 60, skor_final: 45 },
      { bobot: 60, skor_final: 45 }
    ];
    assert.strictEqual(examService.calculateNormalizedScore(scoredItems2), 75);

    // Kasus skor melebihi bobot (clamping protection NFR-08)
    const overScore = [
      { bobot: 50, skor_final: 60 }, // Clamp ke 50
      { bobot: 50, skor_final: 50 }
    ];
    assert.strictEqual(examService.calculateNormalizedScore(overScore), 100);

    // Kasus kosong
    assert.strictEqual(examService.calculateNormalizedScore([]), 0);
  });
});
