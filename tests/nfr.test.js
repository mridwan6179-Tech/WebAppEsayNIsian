const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const queueService = require('../src/services/queueService');
const reviewService = require('../src/services/reviewService');

test('T-08: Pengujian Kebutuhan Non-Fungsional (NFR-01 s/d NFR-14)', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();

  await t.test('NFR-10: Skala MVP mendukung sekurang-kurangnya 20 peserta dalam satu ulangan', async () => {
    const ulangan = examService.createUlangan(guru.id, {
      judul: 'Ulangan Skala 20 Siswa MVP',
      mata_pelajaran: 'Matematika',
      tingkat_kelas: 'Kelas 8'
    });
    examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

    const soal1 = examService.createSoal(ulangan.id, { pertanyaan: '5 x 5 = ?', jenis: 'isian', bobot: 20, kunci_jawaban: '25' });
    const soal2 = examService.createSoal(ulangan.id, { pertanyaan: '100 / 4 = ?', jenis: 'isian', bobot: 30, kunci_jawaban: '25' });

    // Daftarkan 20 siswa submit secara independen
    const pengerjaanIds = [];
    for (let i = 1; i <= 20; i++) {
      const st = studentService.startExam(ulangan.kode_ujian, `Siswa Ke-${i}`, '8A');
      pengerjaanIds.push(st.pengerjaanId);
      studentService.submitExam(st.pengerjaanId, [
        { soal_id: soal1.id, jawaban_siswa: '25' },
        { soal_id: soal2.id, jawaban_siswa: i % 2 === 0 ? '25' : '20' }
      ]);
    }

    assert.strictEqual(pengerjaanIds.length, 20);

    // Enqueue seluruh jawaban ke antrean
    const qStatus = queueService.enqueueUlangan(ulangan.id);
    assert.strictEqual(qStatus.total, 40, 'Harus ada 40 jawaban (20 siswa x 2 soal)');
    assert.strictEqual(qStatus.menunggu, 40);

    // Proses 40 jawaban menggunakan mock grader
    let processedCount = 0;
    const mockGrader = async (item) => {
      processedCount++;
      const isCorrect = (item.jawaban_siswa || '').trim() === '25';
      return {
        skor_rekomendasi: isCorrect ? item.bobot : 0,
        status_jawaban: isCorrect ? 'benar' : 'salah',
        alasan_ai: isCorrect ? 'Perhitungan benar' : 'Perhitungan salah',
        model_ai: 'gemini-test-mvp'
      };
    };

    await queueService.startReview(ulangan.id, mockGrader, 1);

    // Tunggu worker selesai
    let attempts = 0;
    while (attempts < 100) {
      await new Promise(r => setTimeout(r, 50));
      const st = queueService.getQueueStatus(ulangan.id);
      if (st.selesai === 40 && !st.isRunning) break;
      attempts++;
    }

    const finalQ = queueService.getQueueStatus(ulangan.id);
    assert.strictEqual(finalQ.selesai, 40, 'Seluruh 40 jawaban harus selesai dinilai');
    assert.strictEqual(processedCount, 40);

    // Hitung total nilai semua 20 siswa dan verifikasi
    const studentList = reviewService.getPengerjaanListByUlangan(ulangan.id, guru.id);
    assert.strictEqual(studentList.length, 20);
    for (const st of studentList) {
      assert.strictEqual(st.total_dinilai, 2);
    }
  });

  await t.test('NFR-08: Clamping skor pada rentang 0 sampai bobot soal', () => {
    const rawItems = [
      { bobot: 25, skor_rekomendasi: -10 }, // Di-clamp ke 0
      { bobot: 25, skor_rekomendasi: 35 }   // Di-clamp ke 25
    ];
    // (0 + 25) / 50 * 100 = 50
    const score = examService.calculateNormalizedScore(rawItems);
    assert.strictEqual(score, 50);
  });

  await t.test('NFR-07: Audit trail lengkap tersimpan pada database', () => {
    const sampleAnswer = db.prepare(`
      SELECT j.*, a.completed_at
      FROM jawaban j
      LEFT JOIN antrean_review a ON j.id = a.jawaban_id
      WHERE j.status_penilaian = 'selesai'
      LIMIT 1
    `).get();

    assert.ok(sampleAnswer);
    assert.ok(sampleAnswer.model_ai);
    assert.ok(sampleAnswer.alasan_ai);
    assert.ok(sampleAnswer.reviewed_at);
    assert.ok(sampleAnswer.status_jawaban);
    assert.ok(sampleAnswer.skor_rekomendasi !== null);
  });
});
