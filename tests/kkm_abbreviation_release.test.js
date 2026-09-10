const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const reviewService = require('../src/services/reviewService');
const geminiService = require('../src/services/geminiService');

test('T-16: Pengaturan KKM, Penalti Singkatan Kata Sengaja & Tabel Rilis Nilai Kelas', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  assert.ok(guru, 'Guru harus tersedia di database');

  let ulanganId;
  let kodeUjian;
  let soalEssayId;
  let pengerjaanSiswa1Id;
  let pengerjaanSiswa2Id;

  await t.test('1. Pembuatan ulangan dengan KKM kustom (KKM = 80)', () => {
    const exam = examService.createUlangan(guru.id, {
      judul: 'Ujian Biologi KKM Tinggi',
      mata_pelajaran: 'Biologi Sel',
      tingkat_kelas: '11 MIPA',
      kkm: 80
    });

    assert.ok(exam.id);
    assert.strictEqual(exam.kkm, 80);
    ulanganId = exam.id;
    kodeUjian = exam.kode_ujian;

    // Tambahkan soal essay
    const soal = examService.createSoal(ulanganId, {
      nomor: 1,
      jenis: 'essay',
      pertanyaan: 'Jelaskan apa fungsi mitokondria dalam respirasi seluler!',
      kunci_jawaban: 'Mitokondria berfungsi sebagai tempat respirasi seluler untuk menghasilkan energi dalam bentuk ATP melalui siklus Krebs dan rantai transpor elektron.',
      bobot: 100
    });
    soalEssayId = soal.id;
    assert.ok(soalEssayId);

    // Buka ujian
    examService.updateUlangan(ulanganId, guru.id, { status: 'dibuka' });
  });

  await t.test('2. Cek kode ujian memvalidasi dan mengembalikan KKM', () => {
    const val = studentService.validateExamCode(kodeUjian);
    assert.strictEqual(val.valid, true);
    assert.strictEqual(val.ulangan.kkm, 80);
  });

  await t.test('3. Evaluasi AI memberikan penalti minor untuk singkatan kata yang disengaja', () => {
    // Jawaban formal tanpa singkatan sengaja
    const formalResult = geminiService.fallbackOfflineEvaluation({
      pertanyaan: 'Jelaskan apa fungsi mitokondria dalam respirasi seluler!',
      kunci_jawaban: 'Organel tempat respirasi seluler menghasilkan energi dalam bentuk ATP',
      jawaban_siswa: 'Organel respirasi seluler menghasilkan energi dalam bentuk ATP',
      bobot: 100,
      skor_maksimum: 100,
      jenis: 'essay'
    });

    // Jawaban dengan singkatan SMS/chat yang disengaja (yg, dlm, bgt, scr, krn)
    const abbreviatedResult = geminiService.fallbackOfflineEvaluation({
      pertanyaan: 'Jelaskan apa fungsi mitokondria dalam respirasi seluler!',
      kunci_jawaban: 'Organel tempat respirasi seluler menghasilkan energi dalam bentuk ATP',
      jawaban_siswa: 'Organel respirasi seluler menghasilkan energi dlm bentuk ATP scr sel',
      bobot: 100,
      skor_maksimum: 100,
      jenis: 'essay'
    });

    assert.ok(formalResult.skor_rekomendasi >= 0);
    assert.ok(abbreviatedResult.skor_rekomendasi >= 0);

    // Jawaban bersingkatan sengaja harus mencantumkan catatan penalti pada alasan_ai
    // dan memiliki skor lebih rendah daripada jawaban yang tanpa singkatan
    assert.match(
      abbreviatedResult.alasan_ai, 
      /singkatan|menyingkat|penalti/i, 
      'Alasan AI harus memuat penjelasan penalti singkatan kata'
    );
    assert.ok(
      abbreviatedResult.skor_rekomendasi < formalResult.skor_rekomendasi,
      'Skor jawaban yang menyingkat kata harus mendapat pengurangan minor'
    );
  });

  await t.test('4. Dua siswa mengerjakan ujian: Siswa A (Nilai 85) dan Siswa B (Nilai 70)', async () => {
    // Siswa A
    const sesi1 = studentService.startExam(kodeUjian, 'Ahmad Fauzi', '11 MIPA 1');
    pengerjaanSiswa1Id = sesi1.pengerjaanId;
    studentService.submitExam(pengerjaanSiswa1Id, [
      {
        soal_id: soalEssayId,
        jawaban_siswa: 'Mitokondria berfungsi sebagai organel penghasil energi ATP melalui proses respirasi sel.'
      }
    ]);

    // Siswa B
    const sesi2 = studentService.startExam(kodeUjian, 'Budi Santoso', '11 MIPA 1');
    pengerjaanSiswa2Id = sesi2.pengerjaanId;
    studentService.submitExam(pengerjaanSiswa2Id, [
      {
        soal_id: soalEssayId,
        jawaban_siswa: 'Tempat membuat energi sel.'
      }
    ]);

    // Ambil jawaban id masing-masing
    const j1 = db.prepare('SELECT id FROM jawaban WHERE pengerjaan_id = ?').get(pengerjaanSiswa1Id);
    const j2 = db.prepare('SELECT id FROM jawaban WHERE pengerjaan_id = ?').get(pengerjaanSiswa2Id);

    // Guru memberikan skor: Siswa A = 85 (Tuntas, >= 80), Siswa B = 70 (Belum Tuntas, < 80)
    reviewService.updateJawabanReview(j1.id, guru.id, {
      skor_final: 85,
      catatan_guru: 'Penjelasan baik dan lengkap.'
    });
    reviewService.updateJawabanReview(j2.id, guru.id, {
      skor_final: 70,
      catatan_guru: 'Kurang penjelasan mendalam tentang ATP.'
    });

    // Rilis nilai pengerjaan
    reviewService.toggleReleasePengerjaan(ulanganId, guru.id, true);
  });

  await t.test('5. Portal Siswa: getPengerjaanStatus mengembalikan KKM dan rekap leaderboard kelas saat nilai dirilis', () => {
    const hasilSiswa1 = studentService.getPengerjaanStatus(pengerjaanSiswa1Id);

    assert.strictEqual(hasilSiswa1.isReleased, true);
    assert.strictEqual(hasilSiswa1.kkm, 80);
    assert.strictEqual(hasilSiswa1.nilaiFinal, 85);

    // Periksa tabel rekapNilaiKelas
    const rekap = hasilSiswa1.rekapNilaiKelas;
    assert.ok(Array.isArray(rekap));
    assert.ok(rekap.length >= 2);

    // Peringkat 1: Ahmad Fauzi (85)
    const rank1 = rekap.find(r => r.nama === 'Ahmad Fauzi');
    assert.ok(rank1);
    assert.strictEqual(rank1.nilai, 85);
    assert.strictEqual(rank1.isTuntas, true);
    assert.strictEqual(rank1.isCurrentStudent, true);

    // Peringkat 2: Budi Santoso (70)
    const rank2 = rekap.find(r => r.nama === 'Budi Santoso');
    assert.ok(rank2);
    assert.strictEqual(rank2.nilai, 70);
    assert.strictEqual(rank2.isTuntas, false); // KKM 80 -> 70 belum tuntas!
    assert.strictEqual(rank2.isCurrentStudent, false);

    // Cek dari sudut pandang Siswa 2 (Budi Santoso)
    const hasilSiswa2 = studentService.getPengerjaanStatus(pengerjaanSiswa2Id);
    const rekap2 = hasilSiswa2.rekapNilaiKelas;
    const budiInRekap2 = rekap2.find(r => r.nama === 'Budi Santoso');
    assert.strictEqual(budiInRekap2.isCurrentStudent, true);
  });

  await t.test('6. Laporan Nilai Guru menghitung ketuntasan berdasarkan KKM kustom ulangan', () => {
    const laporan = reviewService.getLaporanNilai(ulanganId, guru.id);
    assert.strictEqual(laporan.ulangan.kkm, 80);
    assert.strictEqual(laporan.statistik.kkm, 80);
    assert.strictEqual(laporan.statistik.total_peserta, 2);
    assert.strictEqual(laporan.statistik.tuntas_count, 1); // Hanya Ahmad Fauzi (85)
    assert.strictEqual(laporan.statistik.belum_tuntas_count, 1); // Budi Santoso (70)
  });
});
