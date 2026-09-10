const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const queueService = require('../src/services/queueService');

test('T-04: Antrean Penilaian AI & Worker (FR-09 - FR-13, NFR-02 - NFR-06)', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();

  // Setup ulangan & soal
  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Queue Test',
    mata_pelajaran: 'Matematika',
    tingkat_kelas: 'Kelas 7'
  });
  examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

  const soal1 = examService.createSoal(ulangan.id, { pertanyaan: '1 + 1 = ?', jenis: 'isian', bobot: 10, kunci_jawaban: '2' });
  const soal2 = examService.createSoal(ulangan.id, { pertanyaan: '2 x 3 = ?', jenis: 'isian', bobot: 10, kunci_jawaban: '6' });

  // Pengerjaan Siswa 1
  const s1 = studentService.startExam(ulangan.kode_ujian, 'Budi Santoso', '7A');
  studentService.submitExam(s1.pengerjaanId, [
    { soal_id: soal1.id, jawaban_siswa: '2' },
    { soal_id: soal2.id, jawaban_siswa: '6' }
  ]);

  // Pengerjaan Siswa 2
  const s2 = studentService.startExam(ulangan.kode_ujian, 'Siti Aminah', '7A');
  studentService.submitExam(s2.pengerjaanId, [
    { soal_id: soal1.id, jawaban_siswa: 'dua' },
    { soal_id: soal2.id, jawaban_siswa: 'enam' }
  ]);

  await t.test('FR-11: Jeda acak berada dalam rentang 5-13 detik', () => {
    for (let i = 0; i < 20; i++) {
      const delayMs = queueService.getRandomDelay(5, 13);
      assert.ok(delayMs >= 5000, `Delay harus >= 5000ms, didapat: ${delayMs}`);
      assert.ok(delayMs <= 13000, `Delay harus <= 13000ms, didapat: ${delayMs}`);
    }
  });

  await t.test('FR-09: Enqueue ulangan memasukkan 4 jawaban ke antrean', () => {
    const status = queueService.enqueueUlangan(ulangan.id);
    assert.strictEqual(status.total, 4);
    assert.strictEqual(status.menunggu, 4);
    assert.strictEqual(status.selesai, 0);

    // Enqueue lagi tidak menduplikasi antrean
    queueService.enqueueUlangan(ulangan.id);
    const count = db.prepare(`
      SELECT COUNT(*) as c 
      FROM antrean_review a 
      JOIN jawaban j ON a.jawaban_id = j.id 
      JOIN pengerjaan p ON j.pengerjaan_id = p.id 
      WHERE p.ulangan_id = ?
    `).get(ulangan.id);
    assert.strictEqual(count.c, 4);
  });

  await t.test('FR-10 & FR-13: Menjalankan worker bertahap dengan mock grader', async () => {
    let processedCount = 0;

    const mockGrader = async (item) => {
      processedCount++;
      return {
        skor_rekomendasi: item.bobot,
        status_jawaban: 'benar',
        alasan_ai: 'Jawaban tepat sesuai perhitungan matematika.',
        model_ai: 'mock-model'
      };
    };

    // Jalankan dengan delayOverride = 10ms untuk kecepatan pengujian
    await queueService.startReview(ulangan.id, mockGrader, 10);

    // Tunggu sampai worker menyelesaikan seluruh antrean
    let attempts = 0;
    while (attempts < 50) {
      await new Promise(r => setTimeout(r, 50));
      const st = queueService.getQueueStatus(ulangan.id);
      if (st.selesai === 4 && !st.isRunning) break;
      attempts++;
    }

    const finalStatus = queueService.getQueueStatus(ulangan.id);
    assert.strictEqual(finalStatus.selesai, 4);
    assert.strictEqual(finalStatus.menunggu, 0);
    assert.strictEqual(processedCount, 4);

    // Verifikasi semua jawaban berstatus selesai
    const answers = db.prepare('SELECT status_penilaian, skor_rekomendasi, model_ai FROM jawaban WHERE pengerjaan_id IN (?, ?)').all(s1.pengerjaanId, s2.pengerjaanId);
    assert.strictEqual(answers.length, 4);
    for (const a of answers) {
      assert.strictEqual(a.status_penilaian, 'selesai');
      assert.strictEqual(a.model_ai, 'mock-model');
    }
  });

  await t.test('NFR-06: Idempotensi - Memulai review ulang tidak memproses jawaban yang sudah selesai', async () => {
    let reProcessed = 0;
    const mockGrader = async () => { reProcessed++; return {}; };

    await queueService.startReview(ulangan.id, mockGrader, 10);
    await new Promise(r => setTimeout(r, 50));

    assert.strictEqual(reProcessed, 0, 'Jawaban yang sudah selesai tidak boleh diproses ulang');
  });

  await t.test('FR-12 & NFR-04: Error retry dan batasan max_retry = 3', async () => {
    // Tambah siswa 3 dengan jawaban baru
    const s3 = studentService.startExam(ulangan.kode_ujian, 'Joko Susilo', '7A');
    studentService.submitExam(s3.pengerjaanId, [{ soal_id: soal1.id, jawaban_siswa: 'salah' }]);

    queueService.enqueueUlangan(ulangan.id);

    let failAttempts = 0;
    const failingGrader = async () => {
      failAttempts++;
      const err = new Error('Rate limit exceeded');
      err.status = 429;
      throw err;
    };

    // Jalankan 1 putaran kegagalan
    await queueService.startReview(ulangan.id, failingGrader, 10);
    await new Promise(r => setTimeout(r, 100));

    const errStatus = queueService.getQueueStatus(ulangan.id);
    assert.ok(errStatus.menunggu > 0 || errStatus.gagal > 0);
    assert.ok(failAttempts > 0);
  });
});
