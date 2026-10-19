const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const reviewService = require('../src/services/reviewService');

test('Retake Limit and Grade Policy Suite', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();

  // Test 1: Default 1x attempt (no retake allowed)
  await t.test('1. Default ulangan (maksimal 1x) melarang ujian ulang setelah submit', () => {
    const ulangan = examService.createUlangan(guru.id, {
      judul: 'Uji Coba Percobaan 1x',
      mata_pelajaran: 'Matematika',
      tingkat_kelas: 'Kelas 7',
      durasi_menit: 30,
      maksimal_percobaan: 1,
      kebijakan_nilai: 'tertinggi'
    });
    examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

    const s1 = examService.createSoal(ulangan.id, {
      pertanyaan: '2 + 2 = ?',
      jenis: 'pilihan_ganda',
      bobot: 100,
      opsi_a: '4',
      opsi_b: '3',
      opsi_c: '5',
      opsi_d: '6',
      kunci_pg: 'A'
    });

    try {
      // Siswa mulai pengerjaan ke-1
      const resStart1 = studentService.startExam(ulangan.kode_ujian, 'Budi Santoso', '7A');
      assert.equal(resStart1.attemptKe, 1);
      assert.equal(resStart1.maksimalPercobaan, 1);

      // Siswa submit
      const resSubmit1 = studentService.submitExam(resStart1.pengerjaanId, { [s1.id]: 'A' });
      assert.equal(resSubmit1.attempt_ke, 1);
      assert.equal(resSubmit1.can_retake, false);
      assert.equal(resSubmit1.maksimal_percobaan, 1);

      // Coba mulai lagi tanpa isRetake
      const resStart2NoRetake = studentService.startExam(ulangan.kode_ujian, 'Budi Santoso', '7A');
      assert.equal(resStart2NoRetake.alreadySubmitted, true);
      assert.equal(resStart2NoRetake.canRetake, false);
      assert.equal(resStart2NoRetake.maxAttemptsReached, true);

      // Coba mulai lagi dengan isRetake = true -> Harus tetap ditolak karena maxAttempts = 1
      const resStart2Retake = studentService.startExam(ulangan.kode_ujian, 'Budi Santoso', '7A', null, true);
      assert.equal(resStart2Retake.alreadySubmitted, true);
      assert.equal(resStart2Retake.canRetake, false);
      assert.equal(resStart2Retake.maxAttemptsReached, true);
    } finally {
      db.prepare('DELETE FROM ulangan WHERE id = ?').run(ulangan.id);
    }
  });

  // Test 2: 2x attempt with kebijakan 'tertinggi'
  await t.test('2. Ulangan 2x percobaan dengan kebijakan nilai tertinggi', () => {
    const ulangan = examService.createUlangan(guru.id, {
      judul: 'Uji Coba 2x Nilai Tertinggi',
      mata_pelajaran: 'Fisika',
      tingkat_kelas: 'Kelas 8',
      durasi_menit: 45,
      maksimal_percobaan: 2,
      kebijakan_nilai: 'tertinggi'
    });
    examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

    const s1 = examService.createSoal(ulangan.id, {
      pertanyaan: 'Satuan gaya adalah?',
      jenis: 'pilihan_ganda',
      bobot: 100,
      opsi_a: 'Newton',
      opsi_b: 'Joule',
      opsi_c: 'Watt',
      opsi_d: 'Pascal',
      kunci_pg: 'A'
    });

    try {
      // Attempt 1: Siswa salah jawab (opsi B -> skor 0)
      const a1Start = studentService.startExam(ulangan.kode_ujian, 'Siti Aminah', '8B');
      assert.equal(a1Start.attemptKe, 1);
      assert.equal(a1Start.maksimalPercobaan, 2);

      const a1Submit = studentService.submitExam(a1Start.pengerjaanId, { [s1.id]: 'B' });
      assert.equal(a1Submit.attempt_ke, 1);
      assert.equal(a1Submit.can_retake, true);
      assert.equal(a1Submit.nilai_final, 0);
      assert.equal(a1Submit.nilai_terbaik, 0);

      // Cek status pengerjaan attempt 1
      const a1Status = studentService.getPengerjaanStatus(a1Start.pengerjaanId);
      assert.equal(a1Status.can_retake, true);
      assert.equal(a1Status.sisa_percobaan, 1);

      // Attempt 2: Siswa retake (isRetake: true)
      const a2Start = studentService.startExam(ulangan.kode_ujian, 'Siti Aminah', '8B', null, true);
      assert.notEqual(a2Start.pengerjaanId, a1Start.pengerjaanId);
      assert.equal(a2Start.attemptKe, 2);
      assert.equal(a2Start.totalAttempts, 2);

      // Siswa jawab benar (opsi A -> skor 100)
      const a2Submit = studentService.submitExam(a2Start.pengerjaanId, { [s1.id]: 'A' });
      assert.equal(a2Submit.attempt_ke, 2);
      assert.equal(a2Submit.can_retake, false); // Sudah 2 dari 2
      assert.equal(a2Submit.nilai_final, 100);
      assert.equal(a2Submit.nilai_terbaik, 100);

      // Attempt 3: Harus diblokir karena max 2x
      const a3Start = studentService.startExam(ulangan.kode_ujian, 'Siti Aminah', '8B', null, true);
      assert.equal(a3Start.alreadySubmitted, true);
      assert.equal(a3Start.canRetake, false);
      assert.equal(a3Start.maxAttemptsReached, true);
      assert.equal(a3Start.nilaiTerbaik, 100);
    } finally {
      db.prepare('DELETE FROM ulangan WHERE id = ?').run(ulangan.id);
    }
  });

  // Test 3: Kebijakan 'terakhir' memilih nilai dari pengerjaan terbaru
  await t.test('3. Kebijakan nilai terakhir mengambil skor attempt paling akhir', () => {
    const ulangan = examService.createUlangan(guru.id, {
      judul: 'Uji Coba Kebijakan Terakhir',
      mata_pelajaran: 'Biologi',
      tingkat_kelas: 'Kelas 9',
      durasi_menit: 45,
      maksimal_percobaan: 2,
      kebijakan_nilai: 'terakhir'
    });
    examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

    const s1 = examService.createSoal(ulangan.id, {
      pertanyaan: 'Bagian terkecil dari makhluk hidup adalah?',
      jenis: 'pilihan_ganda',
      bobot: 100,
      opsi_a: 'Sel',
      opsi_b: 'Jaringan',
      opsi_c: 'Organ',
      opsi_d: 'Sistem',
      kunci_pg: 'A'
    });

    try {
      // Attempt 1: Benar (skor 100)
      const a1Start = studentService.startExam(ulangan.kode_ujian, 'Doni Pratama', '9C');
      const a1Submit = studentService.submitExam(a1Start.pengerjaanId, { [s1.id]: 'A' });
      assert.equal(a1Submit.nilai_final, 100);

      // Attempt 2: Salah (skor 0)
      const a2Start = studentService.startExam(ulangan.kode_ujian, 'Doni Pratama', '9C', null, true);
      const a2Submit = studentService.submitExam(a2Start.pengerjaanId, { [s1.id]: 'B' });
      assert.equal(a2Submit.nilai_final, 0);
      // Karena kebijakan 'terakhir', nilai terbaik/efektif harus 0
      assert.equal(a2Submit.nilai_terbaik, 0);

      // Cek getLaporanNilai guru: siswa hanya muncul 1 baris dengan nilai 0
      const laporan = reviewService.getLaporanNilai(ulangan.id, guru.id);
      assert.equal(laporan.peserta.length, 1);
      assert.equal(laporan.peserta[0].nama_siswa, 'Doni Pratama');
      assert.equal(laporan.peserta[0].total_attempts, 2);
      assert.equal(laporan.peserta[0].nilai_final, 0);
      assert.equal(laporan.statistik.rata_rata, 0);
    } finally {
      db.prepare('DELETE FROM ulangan WHERE id = ?').run(ulangan.id);
    }
  });

  // Test 4: Laporan Nilai mengagregasi 1 baris per siswa dengan kebijakan 'tertinggi'
  await t.test('4. getLaporanNilai mengagregasi nilai tertinggi tanpa duplikasi siswa', () => {
    const ulangan = examService.createUlangan(guru.id, {
      judul: 'Uji Coba Laporan Multi Attempt',
      mata_pelajaran: 'Kimia',
      tingkat_kelas: 'Kelas 11',
      durasi_menit: 45,
      maksimal_percobaan: 3,
      kebijakan_nilai: 'tertinggi'
    });
    examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

    const s1 = examService.createSoal(ulangan.id, {
      pertanyaan: 'Rumus kimia air adalah?',
      jenis: 'pilihan_ganda',
      bobot: 100,
      opsi_a: 'H2O',
      opsi_b: 'CO2',
      opsi_c: 'NaCl',
      opsi_d: 'O2',
      kunci_pg: 'A'
    });

    try {
      // Siswa 1: Rendy - Attempt 1 dapat 0, Attempt 2 dapat 100
      const r1 = studentService.startExam(ulangan.kode_ujian, 'Rendy', '11 IPA');
      studentService.submitExam(r1.pengerjaanId, { [s1.id]: 'B' });

      const r2 = studentService.startExam(ulangan.kode_ujian, 'Rendy', '11 IPA', null, true);
      studentService.submitExam(r2.pengerjaanId, { [s1.id]: 'A' });

      // Siswa 2: Maya - Attempt 1 dapat 100
      const m1 = studentService.startExam(ulangan.kode_ujian, 'Maya', '11 IPA');
      studentService.submitExam(m1.pengerjaanId, { [s1.id]: 'A' });

      const laporan = reviewService.getLaporanNilai(ulangan.id, guru.id);
      // Harus tepat 2 siswa unik
      assert.equal(laporan.peserta.length, 2);
      assert.equal(laporan.statistik.total_peserta, 2);
      assert.equal(laporan.statistik.rata_rata, 100);
      assert.equal(laporan.statistik.nilai_tertinggi, 100);
      assert.equal(laporan.statistik.nilai_terendah, 100);

      const rendyRow = laporan.peserta.find(p => p.nama_siswa === 'Rendy');
      assert.ok(rendyRow);
      assert.equal(rendyRow.total_attempts, 2);
      assert.equal(rendyRow.nilai_final, 100);
    } finally {
      db.prepare('DELETE FROM ulangan WHERE id = ?').run(ulangan.id);
    }
  });
});
