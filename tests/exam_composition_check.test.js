const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');

test('=== SUITE: PENGECEKAN KESESUAIAN TIPE SOAL & KUOTA TARGET AWAL ===', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  assert.ok(guru, 'Guru harus ada di database');

  // 1. Buat ulangan dengan target kuota spesifik di awal
  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Pengecekan Komposisi Soal Test',
    mata_pelajaran: 'Informatika',
    tingkat_kelas: 'Kelas 8',
    jumlah_soal_tampil: 10,
    jumlah_soal_pg: 5,
    jumlah_soal_pg_kompleks: 3,
    jumlah_soal_isian: 2
  });

  await t.test('1. Status Awal: Mendeteksi seluruh tipe yang belum dibuat (missingTypes)', () => {
    const comp = examService.checkUlanganComposition(ulangan.id, guru.id);
    assert.strictEqual(comp.hasAnyTarget, true);
    assert.strictEqual(comp.isAllComplete, false);
    assert.strictEqual(comp.missingTypes.length, 3);
    assert.strictEqual(comp.actual.total, 0);

    const missingKeys = comp.missingTypes.map(m => m.type);
    assert.ok(missingKeys.includes('pilihan_ganda'));
    assert.ok(missingKeys.includes('pg_kompleks'));
    assert.ok(missingKeys.includes('isian'));
    assert.strictEqual(comp.totalCheck.status, 'insufficient');
  });

  await t.test('2. Menambah sebagian soal: Mendeteksi tipe yang kurang (insufficient)', () => {
    // Tambah 3 butir PG Biasa (target 5, jadi kurang 2)
    for (let i = 1; i <= 3; i++) {
      examService.createSoal(ulangan.id, {
        pertanyaan: `Soal PG Biasa ${i}`,
        jenis: 'pilihan_ganda',
        opsi_a: 'Jawaban A',
        opsi_b: 'Jawaban B',
        opsi_c: 'Jawaban C',
        opsi_d: 'Jawaban D',
        kunci_pg: 'A',
        bobot: 10
      });
    }

    const comp = examService.checkUlanganComposition(ulangan.id, guru.id);
    assert.strictEqual(comp.isAllComplete, false);
    assert.strictEqual(comp.actual.pilihan_ganda, 3);

    // PG Biasa sekarang berstatus 'insufficient' (kurang 2)
    const pgCheck = comp.checks.find(c => c.type === 'pilihan_ganda');
    assert.strictEqual(pgCheck.status, 'insufficient');
    assert.strictEqual(pgCheck.diff, 2);

    // PG Kompleks dan Isian masih 'missing'
    assert.strictEqual(comp.missingTypes.length, 2);
  });

  await t.test('3. Melengkapi seluruh soal hingga 100% sesuai target awal', () => {
    // Lengkapi sisa 2 PG Biasa (total 5)
    for (let i = 4; i <= 5; i++) {
      examService.createSoal(ulangan.id, {
        pertanyaan: `Soal PG Biasa ${i}`,
        jenis: 'pilihan_ganda',
        opsi_a: 'A', opsi_b: 'B', opsi_c: 'C', opsi_d: 'D',
        kunci_pg: 'A',
        bobot: 10
      });
    }

    // Tambah 3 butir PG Kompleks (kunci multi-huruf: 'A, C')
    for (let i = 1; i <= 3; i++) {
      examService.createSoal(ulangan.id, {
        pertanyaan: `Soal PG Kompleks ${i} (Pilihlah lebih dari satu jawaban yang benar)`,
        jenis: 'pilihan_ganda',
        opsi_a: 'A', opsi_b: 'B', opsi_c: 'C', opsi_d: 'D',
        kunci_pg: 'A, C',
        bobot: 10
      });
    }

    // Tambah 2 butir Isian Singkat
    for (let i = 1; i <= 2; i++) {
      examService.createSoal(ulangan.id, {
        pertanyaan: `Soal Isian Singkat ${i}`,
        jenis: 'isian',
        kunci_jawaban: 'Algoritma',
        bobot: 10
      });
    }

    const comp = examService.checkUlanganComposition(ulangan.id, guru.id);
    assert.strictEqual(comp.actual.pilihan_ganda, 5);
    assert.strictEqual(comp.actual.pg_kompleks, 3);
    assert.strictEqual(comp.actual.isian, 2);
    assert.strictEqual(comp.actual.total, 10);

    assert.strictEqual(comp.missingTypes.length, 0);
    assert.strictEqual(comp.insufficientTypes.length, 0);
    assert.strictEqual(comp.totalCheck.status, 'complete');
    assert.strictEqual(comp.isAllComplete, true);
  });

  await t.test('4. Otomatis terlampir di examService.getUlanganById', () => {
    const detail = examService.getUlanganById(ulangan.id, guru.id);
    assert.ok(detail.komposisi_status);
    assert.strictEqual(detail.komposisi_status.isAllComplete, true);
    assert.strictEqual(detail.komposisi_status.actual.total, 10);
  });

  await t.test('5. examService.getUlanganByGuru mendeteksi status ulangan dengan kekurangan soal', () => {
    // Buat ulangan baru dengan target 2 PG tapi belum ada butir soal di bank
    const newExam = examService.createUlangan(guru.id, {
      judul: 'Ulangan Kurang PG Test',
      mata_pelajaran: 'Informatika',
      tingkat_kelas: 'Kelas 7',
      jumlah_soal_tampil: 2,
      jumlah_soal_pg: 2
    });

    const list = examService.getUlanganByGuru(guru.id);
    const found = list.find(x => x.id === newExam.id);
    assert.ok(found, 'Ulangan baru harus ada di daftar guru');
    assert.strictEqual(found.has_missing_soal, true);
    assert.strictEqual(found.missing_quota_summary, '2 PG');

    // Cleanup
    try { examService.deleteUlangan(newExam.id, guru.id); } catch (e) {}
  });

  // Cleanup ulangan test
  try {
    examService.deleteUlangan(ulangan.id, guru.id);
  } catch (e) {}
});
