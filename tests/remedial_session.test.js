const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const reviewService = require('../src/services/reviewService');
const studentService = require('../src/services/studentService');

test('remedial mengelompokkan nama dan kelas ganda dengan nilai tertinggi', () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: `Remedial duplicate ${Date.now()}`,
    mata_pelajaran: 'Matematika',
    tingkat_kelas: '7A, 7B',
    kkm: 80,
    maksimal_percobaan: 0
  });

  const insertPeserta = db.prepare('INSERT INTO peserta (ulangan_id, nama, kelas) VALUES (?, ?, ?)');
  const insertAttempt = db.prepare(`
    INSERT INTO pengerjaan (ulangan_id, peserta_id, status, started_at, submitted_at, nilai_ai, nilai_final, attempt_ke)
    VALUES (?, ?, 'submitted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?)
  `);
  const andi1 = insertPeserta.run(exam.id, 'Andi Saputra', '7A').lastInsertRowid;
  const andi2 = insertPeserta.run(exam.id, 'Andi Saputra', '7A').lastInsertRowid;
  const budi = insertPeserta.run(exam.id, 'Budi Saputra', '7A').lastInsertRowid;
  insertAttempt.run(exam.id, andi1, 65, 65, 1);
  insertAttempt.run(exam.id, andi2, 85, 85, 2);
  insertAttempt.run(exam.id, budi, 70, 70, 1);

  const result = reviewService.getRemedialCandidates(exam.id, guru.id);
  assert.deepEqual(result.candidates.map(item => item.nama_siswa), ['Budi Saputra']);
  assert.equal(result.candidates[0].nilai_tertinggi, 70);
  assert.equal(result.tuntas.find(item => item.nama_siswa === 'Andi Saputra').nilai_tertinggi, 85);
});

test('remedial membuat satu sesi bertoken tiga karakter dan menyimpan daftar pengecualian', () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: `Remedial link ${Date.now()}`,
    mata_pelajaran: 'IPA',
    tingkat_kelas: '8A',
    kkm: 80,
    maksimal_percobaan: 0
  });
  examService.createSoal(exam.id, {
    nomor: 1,
    jenis: 'pilihan_ganda',
    pertanyaan: 'Satu tambah satu?',
    opsi_a: '1',
    opsi_b: '2',
    opsi_c: '3',
    opsi_d: '4',
    kunci_pg: 'B',
    bobot: 100
  });
  examService.updateUlangan(exam.id, guru.id, { status: 'dibuka' });

  const insertPeserta = db.prepare('INSERT INTO peserta (ulangan_id, nama, kelas) VALUES (?, ?, ?)');
  const insertAttempt = db.prepare(`
    INSERT INTO pengerjaan (ulangan_id, peserta_id, status, started_at, submitted_at, nilai_ai, nilai_final, attempt_ke)
    VALUES (?, ?, 'submitted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, 1)
  `);
  const tuntas = insertPeserta.run(exam.id, 'Tuntas Siswa', '8A').lastInsertRowid;
  const remedial = insertPeserta.run(exam.id, 'Remedial Siswa', '8A').lastInsertRowid;
  insertAttempt.run(exam.id, tuntas, 90, 90);
  insertAttempt.run(exam.id, remedial, 60, 60);

  const created = reviewService.createRemedialSession(exam.id, guru.id, {
    classes: ['8A'],
    baseUrl: 'https://contoh.test'
  });
  assert.match(created.session.kode_sesi, /^[A-Z0-9]{3}$/);
  assert.equal(created.link, `https://contoh.test/?kode=${created.session.kode_sesi}`);
  assert.match(created.whatsapp_text, new RegExp(created.session.kode_sesi));

  examService.updateUlangan(exam.id, guru.id, { status: 'selesai' });
  assert.equal(studentService.validateExamCode(created.session.kode_sesi).valid, true);

  assert.throws(
    () => studentService.startExam(created.session.kode_sesi, 'Tuntas Siswa', '8A'),
    /tidak perlu mengulang/i
  );
  const resumed = studentService.startExam(created.session.kode_sesi, 'Remedial Siswa', '8A');
  assert.ok(resumed.pengerjaanId);

  const again = reviewService.createRemedialSession(exam.id, guru.id, {
    classes: ['8A'],
    baseUrl: 'https://contoh.test'
  });
  assert.equal(again.session.id, created.session.id);
  assert.equal(again.session.kode_sesi, created.session.kode_sesi);
});

test('sesi remedial tetap bisa dimulai walau batas percobaan ulangan utama sudah tercapai', () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: `Remedial max attempt ${Date.now()}`,
    mata_pelajaran: 'Bahasa Indonesia',
    tingkat_kelas: '9A',
    kkm: 75
  });
  examService.createSoal(exam.id, {
    nomor: 1,
    jenis: 'pilihan_ganda',
    pertanyaan: 'Satu tambah satu?',
    opsi_a: '1',
    opsi_b: '2',
    kunci_pg: 'B',
    bobot: 100
  });
  examService.updateUlangan(exam.id, guru.id, { status: 'dibuka' });

  const pesertaId = db.prepare('INSERT INTO peserta (ulangan_id, nama, kelas) VALUES (?, ?, ?)').run(exam.id, 'Nilai Rendah', '9A').lastInsertRowid;
  db.prepare(`
    INSERT INTO pengerjaan (ulangan_id, peserta_id, status, started_at, submitted_at, nilai_ai, nilai_final, attempt_ke)
    VALUES (?, ?, 'submitted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 50, 50, 1)
  `).run(exam.id, pesertaId);

  const remedial = reviewService.createRemedialSession(exam.id, guru.id, {
    classes: ['9A'],
    baseUrl: 'https://contoh.test'
  });
  const started = studentService.startExam(remedial.session.kode_sesi, 'Nilai Rendah', '9A');

  assert.notEqual(started.alreadySubmitted, true);
  assert.ok(started.pengerjaanId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pengerjaan WHERE peserta_id = ?').get(pesertaId).count, 2);
});

test('pembuatan ulang sesi remedial memakai sesi aktif yang sama meski urutan kelas berubah', () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: `Remedial class order ${Date.now()}`,
    mata_pelajaran: 'IPA',
    tingkat_kelas: '7A, 7B',
    kkm: 80,
    maksimal_percobaan: 0
  });
  const insertPeserta = db.prepare('INSERT INTO peserta (ulangan_id, nama, kelas) VALUES (?, ?, ?)');
  const insertAttempt = db.prepare(`
    INSERT INTO pengerjaan (ulangan_id, peserta_id, status, started_at, submitted_at, nilai_ai, nilai_final, attempt_ke)
    VALUES (?, ?, 'submitted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 40, 40, 1)
  `);
  for (const kelas of ['7A', '7B']) {
    const pesertaId = insertPeserta.run(exam.id, `Siswa ${kelas}`, kelas).lastInsertRowid;
    insertAttempt.run(exam.id, pesertaId);
  }

  const first = reviewService.createRemedialSession(exam.id, guru.id, {
    classes: ['7A', '7B'],
    baseUrl: 'https://contoh.test'
  });
  const second = reviewService.createRemedialSession(exam.id, guru.id, {
    classes: ['7b', '7a'],
    baseUrl: 'https://contoh.test'
  });

  assert.equal(second.session.id, first.session.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ulangan_sesi WHERE ulangan_id = ? AND LOWER(nama_sesi) LIKE 'remedial%'").get(exam.id).count, 1);
});

test('siswa yang belum dinilai belum dihitung sebagai peserta remedial', () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: `Remedial ungraded ${Date.now()}`,
    mata_pelajaran: 'IPS',
    tingkat_kelas: '10A',
    kkm: 75
  });
  const pesertaId = db.prepare('INSERT INTO peserta (ulangan_id, nama, kelas) VALUES (?, ?, ?)').run(exam.id, 'Belum Dinilai', '10A').lastInsertRowid;
  db.prepare(`
    INSERT INTO pengerjaan (ulangan_id, peserta_id, status, started_at, submitted_at, nilai_ai, nilai_final, attempt_ke)
    VALUES (?, ?, 'submitted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, 1)
  `).run(exam.id, pesertaId);

  const laporan = reviewService.getLaporanNilai(exam.id, guru.id);
  assert.equal(laporan.statistik.belum_tuntas_count, 0);
  assert.equal(reviewService.getRemedialCandidates(exam.id, guru.id).candidates.length, 0);
});

test('sesi remedial tetap dapat dibuat untuk kelas tanpa riwayat ulangan', () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: `Remedial new class ${Date.now()}`,
    mata_pelajaran: 'IPA',
    tingkat_kelas: '12A',
    kkm: 75
  });
  examService.createSoal(exam.id, {
    nomor: 1,
    jenis: 'pilihan_ganda',
    pertanyaan: 'Satu tambah satu?',
    opsi_a: '1',
    opsi_b: '2',
    kunci_pg: 'B',
    bobot: 100
  });

  try {
    const remedial = reviewService.createRemedialSession(exam.id, guru.id, {
      classes: ['12A'],
      baseUrl: 'https://contoh.test'
    });
    const started = studentService.startExam(remedial.session.kode_sesi, 'Siswa Baru', '12A');
    assert.ok(started.pengerjaanId);
  } finally {
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(exam.id);
  }
});

test('sesi remedial tidak memakai tanggal selesai ulangan utama yang sudah lewat', () => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  const exam = examService.createUlangan(guru.id, {
    judul: `Remedial past deadline ${Date.now()}`,
    mata_pelajaran: 'Matematika',
    tingkat_kelas: '11A',
    kkm: 75,
    durasi_menit: 30,
    tanggal_selesai: new Date(Date.now() - 60_000).toISOString()
  });
  examService.createSoal(exam.id, {
    nomor: 1,
    jenis: 'pilihan_ganda',
    pertanyaan: 'Dua tambah dua?',
    opsi_a: '3',
    opsi_b: '4',
    kunci_pg: 'B',
    bobot: 100
  });
  const pesertaId = db.prepare('INSERT INTO peserta (ulangan_id, nama, kelas) VALUES (?, ?, ?)').run(exam.id, 'Remedial Lewat Jadwal', '11A').lastInsertRowid;
  db.prepare(`
    INSERT INTO pengerjaan (ulangan_id, peserta_id, status, started_at, submitted_at, nilai_ai, nilai_final, attempt_ke)
    VALUES (?, ?, 'submitted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 30, 30, 1)
  `).run(exam.id, pesertaId);

  const remedial = reviewService.createRemedialSession(exam.id, guru.id, {
    classes: ['11A'],
    baseUrl: 'https://contoh.test'
  });
  const started = studentService.startExam(remedial.session.kode_sesi, 'Remedial Lewat Jadwal', '11A');
  assert.ok(started.deadline_at);
  assert.ok(new Date(started.deadline_at).getTime() > Date.now());
});
