const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');

test('=== SUITE: BULK DELETE SESI UJIAN (CENTANG HAPUS MASSAL) ===', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  assert.ok(guru, 'Guru harus ada di database');

  // Buat ulangan test
  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Sesi Bulk Delete Test',
    mata_pelajaran: 'Teknologi Informasi',
    tingkat_kelas: 'Kelas 9'
  });

  // Buat 4 sesi
  const sesi1 = examService.createSesi(ulangan.id, guru.id, { nama_sesi: 'Sesi Pagi A', kuota: 30 });
  const sesi2 = examService.createSesi(ulangan.id, guru.id, { nama_sesi: 'Sesi Pagi B', kuota: 30 });
  const sesi3 = examService.createSesi(ulangan.id, guru.id, { nama_sesi: 'Sesi Siang A', kuota: 30 });
  const sesi4 = examService.createSesi(ulangan.id, guru.id, { nama_sesi: 'Sesi Siang B', kuota: 30 });

  assert.ok(sesi1.id && sesi2.id && sesi3.id && sesi4.id);

  await t.test('1. Menangani input kosong atau bukan array dengan aman', () => {
    const res1 = examService.deleteSesiBulk([], guru.id);
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.count, 0);

    const res2 = examService.deleteSesiBulk(null, guru.id);
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.count, 0);
  });

  await t.test('2. Hapus sebagian sesi terpilih (bulk delete checkbox)', () => {
    // Hapus sesi1 dan sesi3
    const res = examService.deleteSesiBulk([sesi1.id, sesi3.id], guru.id);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.count, 2);

    const remaining = examService.getSesiByUlangan(ulangan.id, guru.id);
    const remainingIds = remaining.map(s => s.id);

    assert.strictEqual(remaining.length, 2);
    assert.ok(remainingIds.includes(sesi2.id));
    assert.ok(remainingIds.includes(sesi4.id));
    assert.ok(!remainingIds.includes(sesi1.id));
    assert.ok(!remainingIds.includes(sesi3.id));
  });

  await t.test('3. Memastikan relasi pengerjaan siswa dilepas (sesi_id = NULL) saat sesi dihapus', () => {
    // Buat peserta dummy
    const insPeserta = db.prepare(`
      INSERT INTO peserta (ulangan_id, nama, kelas)
      VALUES (?, 'Peserta Uji Sesi', '9-A')
    `).run(ulangan.id);
    const pesertaId = insPeserta.lastInsertRowid;
    
    // Insert dummy pengerjaan
    const ins = db.prepare(`
      INSERT INTO pengerjaan (ulangan_id, peserta_id, sesi_id, status)
      VALUES (?, ?, ?, 'submitted')
    `).run(ulangan.id, pesertaId, sesi2.id);

    const pengerjaanId = ins.lastInsertRowid;

    // Hapus sesi2
    const res = examService.deleteSesiBulk([sesi2.id], guru.id);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.count, 1);

    // Cek pengerjaan tetap ada, namun sesi_id menjadi NULL
    const checkPengerjaan = db.prepare('SELECT id, sesi_id FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    assert.ok(checkPengerjaan);
    assert.strictEqual(checkPengerjaan.sesi_id, null);

    // Cleanup pengerjaan dan peserta test
    db.prepare('DELETE FROM pengerjaan WHERE id = ?').run(pengerjaanId);
    db.prepare('DELETE FROM peserta WHERE id = ?').run(pesertaId);
  });

  await t.test('4. Hapus seluruh sisa sesi', () => {
    const res = examService.deleteSesiBulk([sesi4.id], guru.id);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.count, 1);

    const remaining = examService.getSesiByUlangan(ulangan.id, guru.id);
    assert.strictEqual(remaining.length, 0);
  });

  // Cleanup ulangan test
  try {
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(ulangan.id);
  } catch (e) {}
});
