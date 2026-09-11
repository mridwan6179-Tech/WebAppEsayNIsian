const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');

test('Anti-Refresh and Draft Persistence Test Suite', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();

  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Uji Anti Refresh',
    mata_pelajaran: 'Biologi',
    tingkat_kelas: 'Kelas 10',
    durasi_menit: 60
  });

  const soal1 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Organ pernapasan manusia adalah?',
    jenis: 'isian',
    bobot: 50,
    kunci_jawaban: 'Paru-paru'
  });

  const soal2 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Jelaskan fungsi klorofil!',
    jenis: 'essay',
    bobot: 50,
    kunci_jawaban: 'Menyerap cahaya matahari untuk fotosintesis'
  });

  // Buka ulangan
  examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

  let pengerjaanId = null;

  t.after(() => {
    if (ulangan.id) {
      db.prepare('DELETE FROM ulangan WHERE id = ?').run(ulangan.id);
    }
  });

  await t.test('1. Siswa masuk ujian dan memulai pengerjaan', () => {
    const session = studentService.startExam(ulangan.kode_ujian, 'Budi Refresh', '10 IPA 1');
    assert.ok(session);
    assert.ok(session.pengerjaanId);
    assert.equal(session.alreadySubmitted, false);
    pengerjaanId = session.pengerjaanId;
  });

  await t.test('2. Siswa mengetik jawaban & auto-save draft ke server', () => {
    const draftPayload = [
      { soal_id: soal1.id, jawaban_siswa: 'Paru-paru' },
      { soal_id: soal2.id, jawaban_siswa: 'Menyerap cahaya matahari untuk fotosintesis' }
    ];

    const res = studentService.saveDraft(pengerjaanId, draftPayload);
    assert.equal(res.success, true);
    assert.equal(res.savedCount, 2);

    const rows = db.prepare('SELECT soal_id, jawaban_siswa, status_penilaian FROM jawaban WHERE pengerjaan_id = ?').all(pengerjaanId);
    assert.equal(rows.length, 2);
    const map = new Map(rows.map(r => [r.soal_id, r.jawaban_siswa]));
    assert.equal(map.get(soal1.id), 'Paru-paru');
    assert.equal(map.get(soal2.id), 'Menyerap cahaya matahari untuk fotosintesis');
  });

  await t.test('3. Simulasi Reload / Refresh di HP: getActiveSession mengembalikan jawaban yang tersimpan', () => {
    const session = studentService.getActiveSession(pengerjaanId);
    assert.ok(session);
    assert.equal(session.alreadySubmitted, false);
    assert.equal(session.pengerjaanId, pengerjaanId);

    const s1Res = session.soal.find(s => s.id === soal1.id);
    const s2Res = session.soal.find(s => s.id === soal2.id);
    assert.ok(s1Res);
    assert.ok(s2Res);
    assert.equal(s1Res.jawaban_siswa, 'Paru-paru');
    assert.equal(s2Res.jawaban_siswa, 'Menyerap cahaya matahari untuk fotosintesis');
  });

  await t.test('4. Proteksi submitExam: Jika dipanggil tanpa jawaban baru, draft tersimpan tidak ditimpa string kosong', () => {
    const submitResult = studentService.submitExam(pengerjaanId, [], 0, true);
    assert.ok(submitResult.success);

    const rows = db.prepare('SELECT soal_id, jawaban_siswa FROM jawaban WHERE pengerjaan_id = ?').all(pengerjaanId);
    const map = new Map(rows.map(r => [r.soal_id, r.jawaban_siswa]));
    assert.equal(map.get(soal1.id), 'Paru-paru');
    assert.equal(map.get(soal2.id), 'Menyerap cahaya matahari untuk fotosintesis');

    const p = db.prepare('SELECT status, auto_submitted FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    assert.equal(p.status, 'submitted');
    assert.equal(p.auto_submitted, 1);
  });
});
