const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const reviewService = require('../src/services/reviewService');

test('T-11: Fitur Bank Soal & Pengacakan Paket Soal Berbeda per Siswa', async (t) => {
  // Setup guru & ulangan
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  assert.ok(guru);

  // Buat ulangan dengan bank 20 soal dan tampilkan 10 soal acak
  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Bank Soal Acak',
    mata_pelajaran: 'Biologi Genetika',
    tingkat_kelas: 'Kelas 12',
    jumlah_soal_tampil: 10,
    acak_soal: 1
  });

  assert.strictEqual(ulangan.jumlah_soal_tampil, 10);
  assert.strictEqual(ulangan.acak_soal, 1);

  // Masukkan 20 butir soal ke bank soal
  const bankSoalIds = [];
  for (let i = 1; i <= 20; i++) {
    const s = examService.createSoal(ulangan.id, {
      nomor: i,
      jenis: i % 2 === 0 ? 'essay' : 'isian',
      pertanyaan: `Pertanyaan Bank Soal Nomor ${i}?`,
      kunci_jawaban: `Kunci ${i}`,
      rubrik: `Rubrik ${i}`,
      bobot: 10,
      urutan: i
    });
    bankSoalIds.push(s.id);
  }
  assert.strictEqual(bankSoalIds.length, 20);

  // Buka ulangan agar bisa diakses siswa
  examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

  let pengerjaanAId;
  let soalIdsA;

  await t.test('1. Validasi info ujian memuat jumlah soal yang dikerjakan (10 dari 20)', () => {
    const val = studentService.validateExamCode(ulangan.kode_ujian);
    assert.strictEqual(val.valid, true);
    assert.strictEqual(val.ulangan.total_soal, 20, 'Total bank soal ada 20');
    assert.strictEqual(val.ulangan.soal_dikerjakan, 10, 'Siswa hanya mengerjakan 10');
    assert.strictEqual(val.ulangan.jumlah_soal_tampil, 10);
    assert.strictEqual(val.ulangan.acak_soal, 1);
  });

  await t.test('2. Siswa A memulai ujian dan menerima tepat 10 butir soal acak', () => {
    const sessionA = studentService.startExam(ulangan.kode_ujian, 'Ahmad Fauzi', '12 MIPA 1');
    assert.strictEqual(sessionA.alreadySubmitted, false);
    assert.strictEqual(sessionA.soal.length, 10, 'Siswa A harus menerima tepat 10 soal');

    pengerjaanAId = sessionA.pengerjaanId;
    soalIdsA = sessionA.soal.map(s => s.id);

    // Semua soal harus berasal dari bank 20 soal
    assert.ok(soalIdsA.every(id => bankSoalIds.includes(id)));

    // Nomor urut harus berurutan 1..10
    assert.deepStrictEqual(sessionA.soal.map(s => s.nomor), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  await t.test('3. Siswa B memulai ujian dan menerima paket soal yang berbeda/teracak', () => {
    const sessionB = studentService.startExam(ulangan.kode_ujian, 'Budi Pratama', '12 MIPA 1');
    assert.strictEqual(sessionB.alreadySubmitted, false);
    assert.strictEqual(sessionB.soal.length, 10, 'Siswa B harus menerima tepat 10 soal');

    const soalIdsB = sessionB.soal.map(s => s.id);

    // Semua soal harus berasal dari bank soal
    assert.ok(soalIdsB.every(id => bankSoalIds.includes(id)));

    // Paket soal siswa B harus berbeda urutan atau komposisinya dari Siswa A
    const isIdentical = JSON.stringify(soalIdsA) === JSON.stringify(soalIdsB);
    assert.strictEqual(isIdentical, false, 'Siswa B harus menerima paket/urutan soal yang berbeda dari Siswa A');
  });

  await t.test('4. Ketahanan Sesi (Anti-Curang): Siswa A re-open/refresh tetap mendapat 10 soal yang sama persis', () => {
    // Siswa A membuka kembali halaman ujian
    const sessionAReopen = studentService.startExam(ulangan.kode_ujian, 'Ahmad Fauzi', '12 MIPA 1');
    assert.strictEqual(sessionAReopen.alreadySubmitted, false);
    assert.strictEqual(sessionAReopen.pengerjaanId, pengerjaanAId);

    const reloadedIds = sessionAReopen.soal.map(s => s.id);
    assert.deepStrictEqual(reloadedIds, soalIdsA, 'ID butir soal dan urutan harus tetap sama persis setelah refresh');
  });

  await t.test('5. Siswa A submit jawaban dan skor dinormalisasi berdasarkan 10 soal yang dikerjakannya', () => {
    // Siswa A menjawab seluruh 10 soal miliknya
    const answers = soalIdsA.map((id, idx) => ({
      soal_id: id,
      jawaban_siswa: `Jawaban siswa A untuk soal ${id}`
    }));

    const submitRes = studentService.submitExam(pengerjaanAId, answers);
    assert.strictEqual(submitRes.success, true);

    // Periksa bahwa hanya ada 10 baris jawaban di database untuk pengerjaan A
    const countJawaban = db.prepare('SELECT COUNT(*) as c FROM jawaban WHERE pengerjaan_id = ?').get(pengerjaanAId);
    assert.strictEqual(countJawaban.c, 10, 'Hanya 10 soal yang dijawab dan disimpan ke tabel jawaban');

    // Berikan skor acuan pada jawaban siswa A
    // Misal: 8 soal benar penuh (skor 10) dan 2 soal setengah (skor 5)
    const jawabanRows = db.prepare('SELECT id, skor_maksimum FROM jawaban WHERE pengerjaan_id = ?').all(pengerjaanAId);
    assert.strictEqual(jawabanRows.length, 10);

    db.transaction(() => {
      jawabanRows.forEach((j, idx) => {
        const skor = idx < 8 ? 10 : 5;
        db.prepare(`
          UPDATE jawaban 
          SET skor_rekomendasi = ?, status_penilaian = 'selesai', status_jawaban = ?
          WHERE id = ?
        `).run(skor, skor === 10 ? 'benar' : 'parsial', j.id);
      });
    })();

    // Hitung ulang normalisasi
    const totalScore = reviewService.recalculatePengerjaanTotal(pengerjaanAId);

    // Total bobot 10 soal = 100, poin diperoleh = (8*10) + (2*5) = 90
    // Normalisasi skala 100 = (90 / 100) * 100 = 90
    assert.strictEqual(totalScore.nilai_ai, 90);
    assert.strictEqual(totalScore.nilai_final, 90);
  });

  await t.test('6. Kasus Eksak: Bank 10 Soal, 5 Soal Dikerjakan Acak -> Benar Semua Full Nilai 100', () => {
    // Buat ulangan baru khusus pengujian 10 bank soal & 5 tampil
    const ulangan5 = examService.createUlangan(guru.id, {
      judul: 'Ulangan 10 Bank Soal 5 Tampil',
      mata_pelajaran: 'Matematika',
      tingkat_kelas: 'Kelas 10',
      jumlah_soal_tampil: 5,
      acak_soal: 1
    });

    for (let i = 1; i <= 10; i++) {
      examService.createSoal(ulangan5.id, {
        nomor: i,
        jenis: 'isian',
        pertanyaan: `Soal Uji ${i}`,
        kunci_jawaban: `Jawaban ${i}`,
        bobot: 10,
        urutan: i
      });
    }

    examService.updateUlangan(ulangan5.id, guru.id, { status: 'dibuka' });

    // Siswa C mulai ujian
    const sessionC = studentService.startExam(ulangan5.kode_ujian, 'Siswa Teladan C', '10 MIPA 1');
    assert.strictEqual(sessionC.soal.length, 5, 'Siswa C harus menerima tepat 5 butir soal');

    // Kumpulkan 5 jawaban
    const answersC = sessionC.soal.map(s => ({
      soal_id: s.id,
      jawaban_siswa: `Jawaban siswa ${s.id}`
    }));
    studentService.submitExam(sessionC.pengerjaanId, answersC);

    // Berikan semua 5 soal nilai maksimal (skor_rekomendasi = bobot)
    const jawabanC = db.prepare('SELECT id, skor_maksimum FROM jawaban WHERE pengerjaan_id = ?').all(sessionC.pengerjaanId);
    assert.strictEqual(jawabanC.length, 5);

    db.transaction(() => {
      jawabanC.forEach(j => {
        db.prepare(`
          UPDATE jawaban 
          SET skor_rekomendasi = ?, status_penilaian = 'selesai', status_jawaban = 'benar'
          WHERE id = ?
        `).run(j.skor_maksimum, j.id);
      });
    })();

    // Hitung ulang normalisasi
    const totalScoreC = reviewService.recalculatePengerjaanTotal(sessionC.pengerjaanId);

    // 5 soal benar semua -> HARUS 100 FULL!
    assert.strictEqual(totalScoreC.nilai_ai, 100, 'Nilai AI harus 100 penuh');
    assert.strictEqual(totalScoreC.nilai_final, 100, 'Nilai Final harus 100 penuh');

    // Cleanup
    examService.deleteUlangan(ulangan5.id, guru.id);
  });

  // Cleanup ulangan test
  examService.deleteUlangan(ulangan.id, guru.id);
});
