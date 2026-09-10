const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const reviewService = require('../src/services/reviewService');

test('T-14: Fitur Jadwal Buka/Tutup, Batas Waktu Auto-Submit & Laporan Cetak Nilai', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  assert.ok(guru, 'Guru harus tersedia di database');

  let ulanganFuture;
  let ulanganPast;
  let ulanganActive;

  await t.test('1. Pembuatan ulangan dengan parameter jadwal dan durasi', () => {
    const now = new Date();
    const futureStart = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(); // +2 jam
    const futureEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // +24 jam

    ulanganFuture = examService.createUlangan(guru.id, {
      judul: 'Ujian Jadwal Masa Depan',
      mata_pelajaran: 'Fisika Kuantum',
      tingkat_kelas: 'Kelas 12',
      tanggal_mulai: futureStart,
      tanggal_selesai: futureEnd,
      durasi_menit: 45
    });

    assert.strictEqual(ulanganFuture.durasi_menit, 45);
    assert.strictEqual(ulanganFuture.tanggal_mulai, futureStart);
    assert.strictEqual(ulanganFuture.tanggal_selesai, futureEnd);

    // Buka status ulangan
    examService.updateUlangan(ulanganFuture.id, guru.id, { status: 'dibuka' });
  });

  await t.test('2. Siswa ditolak jika ulangan belum memasuki waktu buka (status: belum_buka)', () => {
    const val = studentService.validateExamCode(ulanganFuture.kode_ujian);
    assert.strictEqual(val.valid, false);
    assert.strictEqual(val.status, 'belum_buka');
    assert.match(val.message, /belum dibuka/i);

    // Pastikan startExam juga melempar error
    assert.throws(() => {
      studentService.startExam(ulanganFuture.kode_ujian, 'Siswa Satu', '12 MIPA 1');
    }, /belum dibuka/i);
  });

  await t.test('3. Siswa ditolak jika ulangan sudah melewati waktu tutup (status: sudah_tutup)', () => {
    const now = new Date();
    const pastStart = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(); // -48 jam
    const pastEnd = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(); // -2 jam

    ulanganPast = examService.createUlangan(guru.id, {
      judul: 'Ujian Sudah Berakhir Kemarin',
      mata_pelajaran: 'Kimia Organik',
      tingkat_kelas: 'Kelas 11',
      tanggal_mulai: pastStart,
      tanggal_selesai: pastEnd,
      durasi_menit: 60
    });
    examService.updateUlangan(ulanganPast.id, guru.id, { status: 'dibuka' });

    const val = studentService.validateExamCode(ulanganPast.kode_ujian);
    assert.strictEqual(val.valid, false);
    assert.strictEqual(val.status, 'sudah_tutup');
    assert.match(val.message, /ditutup/i);

    assert.throws(() => {
      studentService.startExam(ulanganPast.kode_ujian, 'Siswa Terlambat', '11 MIPA 2');
    }, /ditutup/i);
  });

  await t.test('4. Siswa dapat memulai ulangan dalam jadwal aktif & deadline_at dihitung akurat', () => {
    const now = new Date();
    const openStart = new Date(now.getTime() - 10 * 60 * 1000).toISOString(); // 10 menit lalu
    const openEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // Besok (+24 jam)

    ulanganActive = examService.createUlangan(guru.id, {
      judul: 'Ulangan Harian Matematika Diskrit',
      mata_pelajaran: 'Matematika',
      tingkat_kelas: 'Kelas 10',
      tanggal_mulai: openStart,
      tanggal_selesai: openEnd,
      durasi_menit: 30 // Durasi 30 menit
    });

    // Tambahkan 2 butir soal
    examService.createSoal(ulanganActive.id, {
      nomor: 1,
      jenis: 'isian',
      pertanyaan: 'Berapa 5 + 7?',
      kunci_jawaban: '12',
      bobot: 50
    });
    examService.createSoal(ulanganActive.id, {
      nomor: 2,
      jenis: 'essay',
      pertanyaan: 'Jelaskan sifat komutatif pada penjumlahan?',
      kunci_jawaban: 'a + b = b + a',
      bobot: 50
    });

    examService.updateUlangan(ulanganActive.id, guru.id, { status: 'dibuka' });

    const session = studentService.startExam(ulanganActive.kode_ujian, 'Budi Santoso', '10 RPL 1');
    assert.strictEqual(session.alreadySubmitted, false);
    assert.ok(session.pengerjaanId);
    assert.ok(session.deadline_at, 'Deadline harus dihitung');
    assert.ok(session.server_time, 'Server time harus disertakan');

    const deadlineDate = new Date(session.deadline_at);
    const serverDate = new Date(session.server_time);
    const diffMinutes = Math.round((deadlineDate.getTime() - serverDate.getTime()) / (60 * 1000));
    assert.strictEqual(diffMinutes, 30, 'Batas pengerjaan harus tepat 30 menit dari waktu mulai');
  });

  let pengerjaanAutoId;
  let pengerjaanManualId;

  await t.test('5. Pengumpulan jawaban via Auto-Submit mencatat auto_submitted = 1 di database', () => {
    // Siswa Budi mengumpulkan via auto-submit (waktu habis)
    const sessionBudi = studentService.startExam(ulanganActive.kode_ujian, 'Budi Santoso', '10 RPL 1');
    pengerjaanAutoId = sessionBudi.pengerjaanId;

    const autoResult = studentService.submitExam(
      pengerjaanAutoId,
      [
        { soal_id: sessionBudi.soal[0].id, teks_jawaban: '12' },
        { soal_id: sessionBudi.soal[1].id, teks_jawaban: 'Urutan tidak mengubah hasil' }
      ],
      0,
      true // isAutoSubmit = true
    );
    assert.strictEqual(autoResult.success, true);

    const checkPengerjaan = db.prepare('SELECT auto_submitted, status FROM pengerjaan WHERE id = ?').get(pengerjaanAutoId);
    assert.strictEqual(checkPengerjaan.status, 'submitted');
    assert.strictEqual(checkPengerjaan.auto_submitted, 1, 'Harus tersimpan auto_submitted = 1');
  });

  await t.test('6. Pengumpulan jawaban manual mencatat auto_submitted = 0', () => {
    const sessionSiti = studentService.startExam(ulanganActive.kode_ujian, 'Siti Nurhaliza', '10 TKJ 2');
    pengerjaanManualId = sessionSiti.pengerjaanId;

    const manualResult = studentService.submitExam(
      pengerjaanManualId,
      [
        { soal_id: sessionSiti.soal[0].id, teks_jawaban: '12' },
        { soal_id: sessionSiti.soal[1].id, teks_jawaban: 'Nilai tetap sama bila posisi ditukar' }
      ],
      0,
      false // isAutoSubmit = false
    );
    assert.strictEqual(manualResult.success, true);

    const checkPengerjaan = db.prepare('SELECT auto_submitted, status FROM pengerjaan WHERE id = ?').get(pengerjaanManualId);
    assert.strictEqual(checkPengerjaan.status, 'submitted');
    assert.strictEqual(checkPengerjaan.auto_submitted, 0, 'Pengumpulan manual harus auto_submitted = 0');
  });

  await t.test('7. Guru dapat mengambil Laporan Rekapitulasi Nilai per Ulangan & per Kelas dengan statistik lengkap', () => {
    // Berikan nilai review guru untuk kedua siswa agar statistik terhitung
    db.prepare('UPDATE pengerjaan SET nilai_ai = 80, nilai_final = 85 WHERE id = ?').run(pengerjaanAutoId); // Budi: 85 (Tuntas >= 75)
    db.prepare('UPDATE pengerjaan SET nilai_ai = 60, nilai_final = 65 WHERE id = ?').run(pengerjaanManualId); // Siti: 65 (Belum tuntas < 75)

    // 7.1 Ambil Laporan Semua Kelas
    const laporanAll = reviewService.getLaporanNilai(ulanganActive.id, guru.id, 'all');
    assert.strictEqual(laporanAll.ulangan.judul, 'Ulangan Harian Matematika Diskrit');
    assert.strictEqual(laporanAll.filter_kelas, 'all');
    assert.strictEqual(laporanAll.peserta.length, 2);
    assert.strictEqual(laporanAll.statistik.total_peserta, 2);
    assert.strictEqual(laporanAll.statistik.total_submitted, 2);
    assert.strictEqual(laporanAll.statistik.nilai_tertinggi, 85);
    assert.strictEqual(laporanAll.statistik.nilai_terendah, 65);
    assert.strictEqual(laporanAll.statistik.rata_rata, 75); // (85 + 65) / 2 = 75
    assert.strictEqual(laporanAll.statistik.tuntas_count, 1);
    assert.strictEqual(laporanAll.statistik.belum_tuntas_count, 1);

    // Periksa daftar kelas yang tersedia
    assert.ok(laporanAll.available_classes.includes('10 RPL 1'));
    assert.ok(laporanAll.available_classes.includes('10 TKJ 2'));

    // 7.2 Ambil Laporan Khusus Kelas '10 RPL 1'
    const laporanRPL = reviewService.getLaporanNilai(ulanganActive.id, guru.id, '10 RPL 1');
    assert.strictEqual(laporanRPL.filter_kelas, '10 RPL 1');
    assert.strictEqual(laporanRPL.peserta.length, 1);
    assert.strictEqual(laporanRPL.peserta[0].nama_siswa, 'Budi Santoso');
    assert.strictEqual(laporanRPL.peserta[0].auto_submitted, 1);
    assert.strictEqual(laporanRPL.statistik.rata_rata, 85);
    assert.strictEqual(laporanRPL.statistik.tuntas_count, 1);

    // 7.3 Ambil Laporan Khusus Kelas '10 TKJ 2'
    const laporanTKJ = reviewService.getLaporanNilai(ulanganActive.id, guru.id, '10 TKJ 2');
    assert.strictEqual(laporanTKJ.filter_kelas, '10 TKJ 2');
    assert.strictEqual(laporanTKJ.peserta.length, 1);
    assert.strictEqual(laporanTKJ.peserta[0].nama_siswa, 'Siti Nurhaliza');
    assert.strictEqual(laporanTKJ.peserta[0].auto_submitted, 0);
    assert.strictEqual(laporanTKJ.statistik.rata_rata, 65);
    assert.strictEqual(laporanTKJ.statistik.belum_tuntas_count, 1);
  });
});
