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
    bobot: 25,
    kunci_jawaban: 'Paru-paru'
  });

  const soal2 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Jelaskan fungsi klorofil!',
    jenis: 'essay',
    bobot: 25,
    kunci_jawaban: 'Menyerap cahaya matahari untuk fotosintesis'
  });

  const soal3 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Manakah organ pernapasan utama manusia?',
    jenis: 'pilihan_ganda',
    bobot: 25,
    opsi_a: 'Paru-paru',
    opsi_b: 'Jantung',
    opsi_c: 'Ginjal',
    opsi_d: 'Lambung',
    opsi_e: 'Hati',
    kunci_pg: 'A'
  });

  const soal4 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Lengkapilah urutan langkah algoritma!',
    jenis: 'koding_game',
    bobot: 25,
    game_data: JSON.stringify({ mode: 'drag_drop', initial_blocks: ['Maju', 'Putar'] }),
    kunci_jawaban: 'Maju,Putar'
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
      { soal_id: soal2.id, jawaban_siswa: 'Menyerap cahaya matahari untuk fotosintesis' },
      { soal_id: soal3.id, jawaban_siswa: 'A' },
      { soal_id: soal4.id, jawaban_siswa: 'Maju,Putar' }
    ];

    const res = studentService.saveDraft(pengerjaanId, draftPayload);
    assert.equal(res.success, true);
    assert.equal(res.savedCount, 4);

    const rows = db.prepare('SELECT soal_id, jawaban_siswa, status_penilaian FROM jawaban WHERE pengerjaan_id = ?').all(pengerjaanId);
    assert.equal(rows.length, 4);
    const map = new Map(rows.map(r => [r.soal_id, r.jawaban_siswa]));
    assert.equal(map.get(soal1.id), 'Paru-paru');
    assert.equal(map.get(soal2.id), 'Menyerap cahaya matahari untuk fotosintesis');
    assert.equal(map.get(soal3.id), 'A');
    assert.equal(map.get(soal4.id), 'Maju,Putar');
  });

  await t.test('3. Simulasi Reload / Refresh di HP: getActiveSession mengembalikan jawaban yang tersimpan & opsi PG lengkap', () => {
    const session = studentService.getActiveSession(pengerjaanId);
    assert.ok(session);
    assert.equal(session.alreadySubmitted, false);
    assert.equal(session.pengerjaanId, pengerjaanId);

    const s1Res = session.soal.find(s => s.id === soal1.id);
    const s2Res = session.soal.find(s => s.id === soal2.id);
    const s3Res = session.soal.find(s => s.id === soal3.id);
    const s4Res = session.soal.find(s => s.id === soal4.id);

    assert.ok(s1Res);
    assert.ok(s2Res);
    assert.ok(s3Res);
    assert.ok(s4Res);

    assert.equal(s1Res.jawaban_siswa, 'Paru-paru');
    assert.equal(s2Res.jawaban_siswa, 'Menyerap cahaya matahari untuk fotosintesis');

    // Verifikasi penting: Teks Opsi A, B, C, D, E tidak boleh kosong setelah refresh
    assert.equal(s3Res.opsi_a, 'Paru-paru');
    assert.equal(s3Res.opsi_b, 'Jantung');
    assert.equal(s3Res.opsi_c, 'Ginjal');
    assert.equal(s3Res.opsi_d, 'Lambung');
    assert.equal(s3Res.opsi_e, 'Hati');
    assert.equal(s3Res.tipe_pg, 'pg_biasa');
    assert.equal(s3Res.jawaban_siswa, 'A');
    // Kunci PG harus disembunyikan dari siswa agar tidak bocor di network tab / inspect element
    assert.equal(s3Res.kunci_pg, undefined);

    // Verifikasi game_data koding tetap utuh setelah refresh
    assert.ok(s4Res.game_data);
    assert.ok(s4Res.game_data.includes('drag_drop'));
    assert.equal(s4Res.jawaban_siswa, 'Maju,Putar');
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
