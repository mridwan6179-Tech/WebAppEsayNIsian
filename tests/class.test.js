const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const classService = require('../src/services/classService');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');

test('Fitur Master Kelas dan Pilihan Kelas Siswa', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();

  const suffix = Date.now();
  const cName1 = `10 RPL ${suffix}`;
  const cName2 = `10 TKJ ${suffix}`;

  let k1, k2;

  await t.test('Guru dapat membuat kelas baru', () => {
    k1 = classService.createKelas(guru.id, cName1);
    assert.ok(k1.id);
    assert.strictEqual(k1.nama_kelas, cName1);

    k2 = classService.createKelas(guru.id, cName2);
    assert.ok(k2.id);

    // Tolak duplikasi nama kelas
    assert.throws(() => {
      classService.createKelas(guru.id, cName1);
    }, /sudah ada/);
  });

  await t.test('Guru dapat melihat daftar kelas miliknya', () => {
    const list = classService.getKelasByGuru(guru.id);
    assert.ok(list.length >= 2);
    assert.ok(list.some(k => k.nama_kelas === cName1));
  });

  let ulanganId, ulanganKode;

  await t.test('Guru membuat ulangan dengan kelas pilihan tertentu', () => {
    const ulangan = examService.createUlangan(guru.id, {
      judul: 'Ulangan Basis Data',
      mata_pelajaran: 'Informatika',
      kelas_ids: [k1.id, k2.id]
    });
    examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

    assert.ok(ulangan.id);
    assert.strictEqual(ulangan.kelas.length, 2);
    ulanganId = ulangan.id;
    ulanganKode = ulangan.kode_ujian;
  });

  await t.test('Siswa memvalidasi kode dan menerima pilihan kelas yang tersedia', () => {
    const check = studentService.validateExamCode(ulanganKode);
    assert.strictEqual(check.valid, true);
    assert.ok(Array.isArray(check.ulangan.available_classes));
    assert.strictEqual(check.ulangan.available_classes.length, 2);
    assert.ok(check.ulangan.available_classes.includes(cName1));
    assert.ok(check.ulangan.available_classes.includes(cName2));
  });

  await t.test('Siswa memulai pengerjaan dengan kelas yang dipilih dari dropdown', () => {
    const st = studentService.startExam(ulanganKode, 'Reza Rahadian', cName1);
    assert.ok(st.pengerjaanId);
    assert.strictEqual(st.peserta.kelas, cName1);
  });

  await t.test('Guru dapat menghapus kelas', () => {
    const kTemp = classService.createKelas(guru.id, `Kelas Hapus ${suffix}`);
    assert.ok(kTemp.id);
    const del = classService.deleteKelas(kTemp.id, guru.id);
    assert.strictEqual(del, true);
  });
});
