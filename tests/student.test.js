const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');

test('T-03: Alur Siswa Masuk sampai Submit (FR-06 - FR-08, NFR-01)', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();

  // Setup ulangan untuk tes siswa
  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Harian Fisika',
    mata_pelajaran: 'Fisika',
    tingkat_kelas: 'Kelas 10'
  });

  const soal1 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Sebutkan satuan dari gaya dalam SI!',
    jenis: 'isian',
    bobot: 20,
    kunci_jawaban: 'Newton'
  });

  const soal2 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Jelaskan Hukum I Newton tentang kelembaman!',
    jenis: 'essay',
    bobot: 30,
    kunci_jawaban: 'Benda akan tetap diam atau bergerak lurus beraturan jika resultan gaya yang bekerja sama dengan nol.'
  });

  await t.test('FR-06: Ulangan berstatus draft ditolak saat siswa memasukkan kode', () => {
    const check = studentService.validateExamCode(ulangan.kode_ujian);
    assert.strictEqual(check.valid, false);
    assert.match(check.message, /belum dibuka/);
  });

  await t.test('FR-06: Membuka ulangan dan validasi kode berhasil', () => {
    examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });
    const check = studentService.validateExamCode(ulangan.kode_ujian);
    assert.strictEqual(check.valid, true);
    assert.strictEqual(check.ulangan.judul, 'Ulangan Harian Fisika');
    assert.strictEqual(check.ulangan.total_soal, 2);
  });

  let pengerjaanSession = null;

  await t.test('FR-07: Memulai pengerjaan - Nama dan kelas wajib, kunci jawaban tidak dibocorkan', () => {
    assert.throws(() => {
      studentService.startExam(ulangan.kode_ujian, '', 'X MIPA 1');
    }, /Nama siswa wajib diisi/);

    assert.throws(() => {
      studentService.startExam(ulangan.kode_ujian, 'Ahmad Fadhil', '');
    }, /Kelas siswa wajib diisi/);

    pengerjaanSession = studentService.startExam(ulangan.kode_ujian, 'Ahmad Fadhil', 'X MIPA 1');
    assert.ok(pengerjaanSession.pengerjaanId);
    assert.strictEqual(pengerjaanSession.alreadySubmitted, false);
    assert.strictEqual(pengerjaanSession.soal.length, 2);

    // Pastikan kunci_jawaban & rubrik TIDAK dibocorkan ke siswa
    for (const s of pengerjaanSession.soal) {
      assert.strictEqual(s.kunci_jawaban, undefined);
      assert.strictEqual(s.rubrik, undefined);
    }
  });

  await t.test('FR-08 & NFR-01: Submit jawaban tersimpan seketika tanpa koneksi AI', () => {
    const answers = [
      { soal_id: soal1.id, jawaban_siswa: 'Newton (N)' },
      { soal_id: soal2.id, jawaban_siswa: 'Jika tidak ada gaya luar yang bekerja, benda diam akan tetap diam dan yang bergerak akan tetap bergerak konstan.' }
    ];

    const submitResult = studentService.submitExam(pengerjaanSession.pengerjaanId, answers);
    assert.strictEqual(submitResult.success, true);
    assert.ok(submitResult.submitted_at);

    // Verifikasi di database bahwa status pengerjaan adalah submitted
    const pengerjaanDb = db.prepare('SELECT status, submitted_at FROM pengerjaan WHERE id = ?').get(pengerjaanSession.pengerjaanId);
    assert.strictEqual(pengerjaanDb.status, 'submitted');
    assert.ok(pengerjaanDb.submitted_at);

    // Verifikasi bahwa kedua jawaban tersimpan dengan status 'menunggu'
    const jawabanList = db.prepare('SELECT * FROM jawaban WHERE pengerjaan_id = ?').all(pengerjaanSession.pengerjaanId);
    assert.strictEqual(jawabanList.length, 2);
    for (const j of jawabanList) {
      assert.strictEqual(j.status_penilaian, 'menunggu');
      assert.ok(j.skor_maksimum > 0);
    }
  });

  await t.test('FR-07: Siswa yang sudah submit tidak dapat memulai ulang ujian', () => {
    const reStart = studentService.startExam(ulangan.kode_ujian, 'Ahmad Fadhil', 'X MIPA 1');
    assert.strictEqual(reStart.alreadySubmitted, true);
    assert.ok(reStart.submittedAt);
  });

  await t.test('FR-09: Log tanda terima pengumpulan jawaban (tanpa membocorkan nilai)', () => {
    const log = studentService.getSubmissionLogByExamCode(ulangan.kode_ujian, 1, 10);
    assert.strictEqual(log.success, true);
    assert.ok(log.data.total >= 1);
    assert.strictEqual(log.data.page, 1);
    assert.strictEqual(log.data.limit, 10);

    const firstItem = log.data.items[0];
    assert.strictEqual(firstItem.nama, 'Ahmad Fadhil');
    assert.ok(firstItem.nama_sensor);
    assert.strictEqual(firstItem.kelas, 'X MIPA 1');
    assert.strictEqual(firstItem.status, 'Diterima');
    assert.ok(firstItem.waktu);
    // Pastikan tidak ada nilai_final atau skor di log publik
    assert.strictEqual(firstItem.nilai, undefined);
    assert.strictEqual(firstItem.nilai_final, undefined);
  });

  await t.test('FR-10: Monitor siswa sedang mengerjakan, sensor nama, dan hitungan mundur DC', () => {
    // Verifikasi helper sensor nama
    assert.strictEqual(studentService.maskStudentName('Budi Santoso'), 'Bu** San****');
    assert.strictEqual(studentService.maskStudentName('Muhammad Ridwan'), 'Muh***** Rid***');

    // Buat siswa aktif baru
    const activeSession = studentService.startExam(ulangan.kode_ujian, 'Budi Santoso', 'X MIPA 2');
    assert.ok(activeSession.pengerjaanId);

    // Ambil monitor siswa aktif
    let monitor = studentService.getActiveStudentsByExamCode(ulangan.kode_ujian, 1, 10);
    assert.strictEqual(monitor.success, true);
    assert.ok(monitor.data.total >= 1);
    assert.ok(monitor.data.total_aktif >= 1);

    const activeItem = monitor.data.items.find(i => i.pengerjaan_id === activeSession.pengerjaanId);
    assert.ok(activeItem);
    assert.strictEqual(activeItem.nama_sensor, 'Bu** San****');
    assert.strictEqual(activeItem.kelas, 'X MIPA 2');
    assert.strictEqual(activeItem.status, 'aktif');
    assert.strictEqual(activeItem.sisa_toleransi_detik, null);

    // Simulasikan siswa mengalami DC (terputus 10 menit lalu)
    db.prepare(`UPDATE pengerjaan SET last_active_at = datetime('now', '-600 seconds') WHERE id = ?`).run(activeSession.pengerjaanId);

    monitor = studentService.getActiveStudentsByExamCode(ulangan.kode_ujian, 1, 10);
    const dcItem = monitor.data.items.find(i => i.pengerjaan_id === activeSession.pengerjaanId);
    assert.ok(dcItem);
    assert.strictEqual(dcItem.status, 'dc');
    assert.strictEqual(dcItem.status_label, 'Terputus (DC)');
    assert.ok(dcItem.detik_inaktif >= 590);
    // Sisa toleransi harus berkurang sekitar 10 menit (3600 - 600 = ~3000 detik)
    assert.ok(dcItem.sisa_toleransi_detik > 0);
    assert.ok(dcItem.sisa_toleransi_detik <= 3010);
  });

  await t.test('FR-11: Masuk kembali me-reset batas toleransi DC ke 1 jam penuh', () => {
    // Siswa Budi Santoso yang sebelumnya DC masuk kembali ke lembar ujian
    const reEntry = studentService.startExam(ulangan.kode_ujian, 'Budi Santoso', 'X MIPA 2');
    assert.strictEqual(reEntry.alreadySubmitted, false);

    // Ambil monitor siswa aktif lagi
    const monitor = studentService.getActiveStudentsByExamCode(ulangan.kode_ujian, 1, 10);
    const item = monitor.data.items.find(i => i.pengerjaan_id === reEntry.pengerjaanId);
    assert.ok(item);
    // Batas DC harus kembali aktif (detik_inaktif <= 5 detik)
    assert.strictEqual(item.status, 'aktif');
    assert.strictEqual(item.status_label, 'Aktif');
    assert.ok(item.detik_inaktif <= 5);
    assert.strictEqual(item.sisa_toleransi_detik, null);
  });

  await t.test('FR-12: Jawaban lengkap tidak dihitung sebagai DC terancam hangus, dan auto-submit saat DC > 1 jam', () => {
    // Buat siswa baru dengan jawaban terisi lengkap
    const sLengkap = studentService.startExam(ulangan.kode_ujian, 'Citra Lestari', 'X MIPA 3');
    studentService.saveDraft(sLengkap.pengerjaanId, [
      { soal_id: soal1.id, jawaban_siswa: 'Newton' },
      { soal_id: soal2.id, jawaban_siswa: 'Jawaban lengkap soal 2' }
    ]);

    // Simulasikan terputus koneksi (10 menit lalu)
    db.prepare(`UPDATE pengerjaan SET last_active_at = datetime('now', '-600 seconds') WHERE id = ?`).run(sLengkap.pengerjaanId);

    let monitor = studentService.getActiveStudentsByExamCode(ulangan.kode_ujian, 1, 10);
    const itemLengkap = monitor.data.items.find(i => i.pengerjaan_id === sLengkap.pengerjaanId);
    assert.ok(itemLengkap);
    // Karena jawaban sudah lengkap, status bukan DC yang terancam hangus
    assert.strictEqual(itemLengkap.status, 'lengkap');
    assert.strictEqual(itemLengkap.status_label, '🟢 Jawaban Lengkap');
    assert.strictEqual(itemLengkap.draft_lengkap, true);
    assert.ok(itemLengkap.sisa_toleransi_detik > 0);

    // Simulasikan DC melebihi 1 jam penuh (sesi dimulai 70 menit lalu, inaktif 62 menit lalu)
    db.prepare(`UPDATE pengerjaan SET started_at = datetime('now', '-4200 seconds'), last_active_at = datetime('now', '-3700 seconds') WHERE id = ?`).run(sLengkap.pengerjaanId);

    // Jalankan cleanAbandonedSessions
    const cleanRes = studentService.cleanAbandonedSessions(ulangan.id);
    assert.strictEqual(cleanRes.success, true);
    const autoSub = cleanRes.autoSubmitted.find(s => s.pengerjaan_id === sLengkap.pengerjaanId);
    assert.ok(autoSub, 'Pengerjaan berjawaban lengkap harus masuk daftar autoSubmitted');

    // Cek di database: status harus 'submitted' dan auto_submitted = 1, TIDAK dihapus
    const pDb = db.prepare('SELECT status, auto_submitted, submitted_at FROM pengerjaan WHERE id = ?').get(sLengkap.pengerjaanId);
    assert.ok(pDb, 'Pengerjaan jawaban lengkap tidak boleh dihapus');
    assert.strictEqual(pDb.status, 'submitted');
    assert.strictEqual(pDb.auto_submitted, 1);
    assert.ok(pDb.submitted_at);
  });

  await t.test('FR-13: Jawaban belum lengkap yang DC > 1 jam dihapus otomatis (reset) agar bisa mengulang', () => {
    // Buat siswa baru tanpa mengisi jawaban (jawaban kosong / belum lengkap)
    const sKosong = studentService.startExam(ulangan.kode_ujian, 'Deni Kosong', 'X MIPA 3');
    assert.ok(sKosong.pengerjaanId);

    // Simulasikan DC melebihi 1 jam (sesi dimulai 70 menit lalu, inaktif 62 menit lalu)
    db.prepare(`UPDATE pengerjaan SET started_at = datetime('now', '-4200 seconds'), last_active_at = datetime('now', '-3700 seconds') WHERE id = ?`).run(sKosong.pengerjaanId);

    // Jalankan cleanAbandonedSessions
    const cleanRes = studentService.cleanAbandonedSessions(ulangan.id);
    assert.strictEqual(cleanRes.success, true);
    const deleted = cleanRes.deleted.find(s => s.pengerjaan_id === sKosong.pengerjaanId);
    assert.ok(deleted, 'Pengerjaan yang belum lengkap harus dihapus/direset');

    // Cek di database: data pengerjaan harus sudah bersih/dihapus
    const pDb = db.prepare('SELECT id FROM pengerjaan WHERE id = ?').get(sKosong.pengerjaanId);
    assert.strictEqual(pDb, undefined, 'Pengerjaan harus sudah terhapus dari database');

    // Siswa Deni Kosong dapat login kembali dan memulai ujian dari awal
    const reStart = studentService.startExam(ulangan.kode_ujian, 'Deni Kosong', 'X MIPA 3');
    assert.strictEqual(reStart.alreadySubmitted, false);
    assert.ok(reStart.pengerjaanId);
  });
});


