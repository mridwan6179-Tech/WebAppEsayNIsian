const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const queueService = require('../src/services/queueService');
const reviewService = require('../src/services/reviewService');

test('PENGUJIAN KALIBRASI BOBOT PROPORSIONAL INSTAN & ANTREAN REVIEW AI BEBAS ERROR', async (t) => {
  // Setup data guru & ulangan
  const uniqueEmail = `fisika_${Date.now()}_${Math.random().toString(36).substring(2, 7)}@test.com`;
  const guru = db.prepare("INSERT INTO guru (nama, email, password) VALUES ('Guru Fisika', ?, 'hashed')").run(uniqueEmail);
  const guruId = guru.lastInsertRowid;

  const ulangan = examService.createUlangan(guruId, {
    judul: 'Ulangan Fisika Uji Kalibrasi & Antrean',
    mata_pelajaran: 'Fisika',
    durasi_menit: 60,
    tingkat_kelas: 'Kelas 12'
  });
  examService.updateUlangan(ulangan.id, guruId, { status: 'dibuka' });

  // Buat 3 soal dengan bobot awal:
  // Soal 1 (isian, sedang): bobot = 10
  // Soal 2 (isian, mudah): bobot = 10
  // Soal 3 (essay, sulit): bobot = 20
  // Total bobot awal = 40
  const soal1 = examService.createSoal(ulangan.id, {
    jenis: 'isian',
    pertanyaan: 'Rumus gaya Coulomb adalah...',
    kunci_jawaban: 'F = k * q1 * q2 / r^2',
    tingkat_kesulitan: 'sedang',
    bobot: 10
  });

  const soal2 = examService.createSoal(ulangan.id, {
    jenis: 'isian',
    pertanyaan: 'Satuan SI dari arus listrik adalah...',
    kunci_jawaban: 'Ampere',
    tingkat_kesulitan: 'mudah',
    bobot: 10
  });

  const soal3 = examService.createSoal(ulangan.id, {
    jenis: 'essay',
    pertanyaan: 'Jelaskan hukum kekekalan energi mekanik...',
    kunci_jawaban: 'Energi mekanik adalah penjumlahan energi kinetik dan potensial...',
    tingkat_kesulitan: 'sulit',
    bobot: 20
  });

  // Siswa 1 mengerjakan ulangan & submit
  const s1 = studentService.startExam(ulangan.kode_ujian, 'Ahmad Siswa 1', 'XII MIPA 1');
  studentService.submitExam(s1.pengerjaanId, [
    { soal_id: soal1.id, jawaban_siswa: 'F = k q1 q2 / r^2' },
    { soal_id: soal2.id, jawaban_siswa: 'Ampere' },
    { soal_id: soal3.id, jawaban_siswa: 'Energi tidak dapat dimusnahkan...' }
  ]);

  // Siswa 2 mengerjakan ulangan & submit
  const s2 = studentService.startExam(ulangan.kode_ujian, 'Budi Siswa 2', 'XII MIPA 1');
  studentService.submitExam(s2.pengerjaanId, [
    { soal_id: soal1.id, jawaban_siswa: 'F = m a' }, // salah
    { soal_id: soal2.id, jawaban_siswa: 'Ampere' }, // benar
    { soal_id: soal3.id, jawaban_siswa: 'Penjelasan parsial' } // parsial
  ]);

  await t.test('1. Menilai siswa 1 secara penuh (mock AI) sebelum kalibrasi', async () => {
    // Beri nilai untuk Siswa 1:
    // Soal 1: skor 10 dari 10 (100%)
    // Soal 2: skor 10 dari 10 (100%)
    // Soal 3: skor 15 dari 20 (75%)
    // Total capaian = 35 / 40 = 87.5% -> Nilai normalisasi = 87.5
    const j1_1 = db.prepare('SELECT id FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(s1.pengerjaanId, soal1.id);
    const j1_2 = db.prepare('SELECT id FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(s1.pengerjaanId, soal2.id);
    const j1_3 = db.prepare('SELECT id FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(s1.pengerjaanId, soal3.id);

    db.prepare("UPDATE jawaban SET status_penilaian = 'selesai', skor_rekomendasi = 10, skor_maksimum = 10 WHERE id = ?").run(j1_1.id);
    db.prepare("UPDATE jawaban SET status_penilaian = 'selesai', skor_rekomendasi = 10, skor_maksimum = 10 WHERE id = ?").run(j1_2.id);
    db.prepare("UPDATE jawaban SET status_penilaian = 'selesai', skor_rekomendasi = 15, skor_maksimum = 20 WHERE id = ?").run(j1_3.id);

    // Guru mereview soal 3 memberi nilai final 16
    reviewService.updateJawabanReview(j1_3.id, guruId, {
      skor_final: 16,
      catatan_guru: 'Jawaban cukup mendalam'
    });

    const recalculated1 = reviewService.recalculatePengerjaanTotal(s1.pengerjaanId);
    assert.strictEqual(recalculated1.nilai_ai, 87.5);
    // Nilai final: (10 + 10 + 16) / 40 * 100 = 36 / 40 * 100 = 90
    assert.strictEqual(recalculated1.nilai_final, 90);

    // Siswa 2 dibiarkan belum dinilai (status_penilaian = 'menunggu')
    const j2_pending = db.prepare('SELECT id, status_penilaian FROM jawaban WHERE pengerjaan_id = ?').all(s2.pengerjaanId);
    for (const j of j2_pending) {
      assert.strictEqual(j.status_penilaian, 'menunggu');
    }
  });

  await t.test('2. Kalibrasi bobot secara otomatis me-rescale nilai jawaban yang sudah dinilai secara instan', async () => {
    // Kalibrasi ulangan ke target_total_bobot = 100 (mode proportional)
    const calibResult = examService.calibrateQuestionWeights(ulangan.id, guruId, {
      target_total_bobot: 100,
      mode: 'proportional'
    });

    assert.strictEqual(calibResult.success, true);
    assert.strictEqual(calibResult.total_bobot, 100);

    const s1Bobot = db.prepare('SELECT bobot FROM soal WHERE id = ?').get(soal1.id).bobot;
    const s2Bobot = db.prepare('SELECT bobot FROM soal WHERE id = ?').get(soal2.id).bobot;
    const s3Bobot = db.prepare('SELECT bobot FROM soal WHERE id = ?').get(soal3.id).bobot;

    assert.strictEqual(s1Bobot + s2Bobot + s3Bobot, 100);

    // Cek jawaban Siswa 1 yang SUDAH dinilai:
    const j1_1 = db.prepare('SELECT skor_rekomendasi, skor_maksimum FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(s1.pengerjaanId, soal1.id);
    const j1_2 = db.prepare('SELECT skor_rekomendasi, skor_maksimum FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(s1.pengerjaanId, soal2.id);
    const j1_3 = db.prepare('SELECT skor_rekomendasi, skor_maksimum FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(s1.pengerjaanId, soal3.id);
    const rg1_3 = db.prepare('SELECT skor_ai, skor_final FROM review_guru WHERE jawaban_id = (SELECT id FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?)').get(s1.pengerjaanId, soal3.id);

    // Soal 1 siswa dapat 100% (10/10) -> Sekarang harus 100% dari s1Bobot
    assert.strictEqual(j1_1.skor_rekomendasi, s1Bobot);
    assert.strictEqual(j1_1.skor_maksimum, s1Bobot);

    // Soal 2 siswa dapat 100% (10/10) -> Sekarang harus 100% dari s2Bobot
    assert.strictEqual(j1_2.skor_rekomendasi, s2Bobot);
    assert.strictEqual(j1_2.skor_maksimum, s2Bobot);

    // Soal 3 siswa dapat 75% (15/20) -> Sekarang harus 75% dari s3Bobot
    const expectedSoal3Skor = Math.round((15 / 20) * s3Bobot * 100) / 100;
    assert.strictEqual(j1_3.skor_rekomendasi, expectedSoal3Skor);
    assert.strictEqual(j1_3.skor_maksimum, s3Bobot);

    // Review guru (16/20 = 80%) -> Sekarang harus 80% dari s3Bobot
    const expectedGuruSkor = Math.round((16 / 20) * s3Bobot * 100) / 100;
    assert.strictEqual(rg1_3.skor_final, expectedGuruSkor);
    assert.strictEqual(rg1_3.skor_ai, expectedSoal3Skor);

    // Cek nilai akhir pengerjaan Siswa 1:
    // Nilai otomatis ter-revisi/terkalibrasi secara proporsional dan instan tanpa panggil AI!
    // Soal 1: 21/21, Soal 2: 17/17, Soal 3: 46.5/62 -> Total AI = 84.5 / 100 = 84.5
    // Final guru: 21 + 17 + 49.6 = 87.6 / 100 = 87.6
    const p1 = db.prepare('SELECT nilai_ai, nilai_final FROM pengerjaan WHERE id = ?').get(s1.pengerjaanId);
    assert.strictEqual(p1.nilai_ai, 84.5, 'Nilai AI p1 otomatis ter-rescale tepat ke 84.5');
    assert.strictEqual(p1.nilai_final, 87.6, 'Nilai final guru p1 otomatis ter-rescale tepat ke 87.6');

    // Cek jawaban Siswa 2 yang BELUM dinilai:
    const j2_answers = db.prepare('SELECT skor_rekomendasi, skor_maksimum, status_penilaian FROM jawaban WHERE pengerjaan_id = ?').all(s2.pengerjaanId);
    for (const j of j2_answers) {
      assert.strictEqual(j.status_penilaian, 'menunggu');
      assert.strictEqual(j.skor_rekomendasi, null);
      assert.ok(j.skor_maksimum > 0);
    }
  });

  await t.test('3. startReview dengan mode step hanya mengantrekan tanpa memicu dual worker background', async () => {
    const stepStart = await queueService.startReview(ulangan.id, null, null, { mode: 'step' });
    assert.strictEqual(stepStart.success, true);
    assert.strictEqual(stepStart.status.isRunning, false, 'Dalam mode step, background worker TIDAK boleh running');
    assert.strictEqual(stepStart.status.menunggu, 3, 'Ada 3 jawaban siswa 2 yang menunggu');
    assert.strictEqual(stepStart.status.selesai, 3, 'Ada 3 jawaban siswa 1 yang sudah selesai');
  });

  await t.test('4. processNextAnswer memproses jawaban menunggu secara bertahap dan aman', async () => {
    const mockGrader = async (queueItem) => {
      return {
        skor_rekomendasi: Math.round(queueItem.bobot * 0.5),
        status_jawaban: 'parsial',
        alasan_ai: 'Penjelasan cukup baik',
        model_ai: 'gemini-mock'
      };
    };

    // Proses langkah 1
    const step1 = await queueService.processNextAnswer(ulangan.id, mockGrader);
    assert.strictEqual(step1.success, true);
    assert.strictEqual(step1.done, false);
    assert.strictEqual(step1.status.selesai, 4);
    assert.strictEqual(step1.status.menunggu, 2);

    // Proses langkah 2
    const step2 = await queueService.processNextAnswer(ulangan.id, mockGrader);
    assert.strictEqual(step2.success, true);
    assert.strictEqual(step2.done, false);
    assert.strictEqual(step2.status.selesai, 5);
    assert.strictEqual(step2.status.menunggu, 1);

    // Proses langkah 3
    const step3 = await queueService.processNextAnswer(ulangan.id, mockGrader);
    assert.strictEqual(step3.success, true);
    assert.strictEqual(step3.done, false);
    assert.strictEqual(step3.status.selesai, 6);
    assert.strictEqual(step3.status.menunggu, 0);

    // Langkah 4: Antrean sudah tuntas
    const step4 = await queueService.processNextAnswer(ulangan.id, mockGrader);
    assert.strictEqual(step4.success, true);
    assert.strictEqual(step4.done, true);
    assert.strictEqual(step4.status.selesai, 6);
    assert.strictEqual(step4.status.menunggu, 0);

    // Pengerjaan siswa 2 sekarang sudah terisi nilainya secara otomatis
    const p2 = db.prepare('SELECT nilai_ai, nilai_final FROM pengerjaan WHERE id = ?').get(s2.pengerjaanId);
    assert.ok(p2.nilai_ai > 0, 'Nilai AI siswa 2 terisi otomatis');
    assert.ok(p2.nilai_final > 0, 'Nilai final siswa 2 terisi otomatis');
  });

  await t.test('5. Nilai Ulang Semua (forceAll: true) me-reset semua jawaban dan menilai ulang dari awal', async () => {
    const statusBefore = queueService.getQueueStatus(ulangan.id);
    assert.strictEqual(statusBefore.selesai, 6);
    assert.strictEqual(statusBefore.menunggu, 0);

    const reevalStart = await queueService.startReview(ulangan.id, null, null, {
      forceAll: true,
      mode: 'step'
    });

    assert.strictEqual(reevalStart.success, true);
    assert.strictEqual(reevalStart.status.selesai, 0, 'Seluruh jawaban di-reset ke menunggu');
    assert.strictEqual(reevalStart.status.menunggu, 6, 'Semua 6 jawaban siap dinilai ulang');

    let reEvaluatedCount = 0;
    const mockGraderFull = async (queueItem) => {
      reEvaluatedCount++;
      return {
        skor_rekomendasi: queueItem.bobot,
        status_jawaban: 'benar',
        alasan_ai: 'Sempurna setelah dinilai ulang',
        model_ai: 'gemini-mock-reeval'
      };
    };

    const nextStep = await queueService.processNextAnswer(ulangan.id, mockGraderFull);
    assert.strictEqual(nextStep.success, true);
    assert.strictEqual(reEvaluatedCount, 1);
    assert.strictEqual(nextStep.status.selesai, 1);
    assert.strictEqual(nextStep.status.menunggu, 5);
  });

  await t.test('6. Auto-heal pada recalculatePengerjaanTotal saat skor_maksimum out-of-sync dengan soal.bobot', async () => {
    // Simulasikan kondisi di mana skor_maksimum lama adalah 4, tapi soal.bobot adalah 21
    // Siswa mendapat skor 4/4 (100%), namun jika tanpa auto-heal akan terhitung 4/21 (19%)
    const j1_1 = db.prepare('SELECT id FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(s1.pengerjaanId, soal1.id);
    db.prepare("UPDATE jawaban SET status_penilaian = 'selesai', skor_rekomendasi = 4, skor_maksimum = 4 WHERE id = ?").run(j1_1.id);

    // Jalankan recalculatePengerjaanTotal
    const healed = reviewService.recalculatePengerjaanTotal(s1.pengerjaanId);
    assert.ok(healed.nilai_ai > 50, `Nilai AI (${healed.nilai_ai}) harus tetap tinggi dan tidak anjlok ke bawah 50`);

    // Pastikan database jawaban ter-self-heal
    const j1_1After = db.prepare('SELECT skor_rekomendasi, skor_maksimum FROM jawaban WHERE id = ?').get(j1_1.id);
    const curBobot1 = db.prepare('SELECT bobot FROM soal WHERE id = ?').get(soal1.id).bobot;
    assert.strictEqual(j1_1After.skor_maksimum, curBobot1);
    assert.strictEqual(j1_1After.skor_rekomendasi, curBobot1);
  });

  await t.test('7. updateSoal dengan perubahan bobot otomatis me-rescale jawaban siswa secara proporsional', async () => {
    // Ubah bobot soal 2 dari bobot sekarang ke 50
    examService.updateSoal(soal2.id, { bobot: 50 });

    const updatedBobot = db.prepare('SELECT bobot FROM soal WHERE id = ?').get(soal2.id).bobot;
    assert.strictEqual(updatedBobot, 50);

    const j1_2 = db.prepare('SELECT skor_rekomendasi, skor_maksimum FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(s1.pengerjaanId, soal2.id);
    assert.strictEqual(j1_2.skor_maksimum, 50);
  });
});
