const test = require('node:test');
const assert = require('node:assert/strict');
const geminiService = require('../src/services/geminiService');
const examService = require('../src/services/examService');
const db = require('../src/config/database');

test('geminiService: normalizeGeneratedQuestions preserves and sanitizes tingkat_kesulitan', () => {
  const rawQuestions = [
    { pertanyaan: 'Soal 1', jenis: 'isian', bobot: 10, tingkat_kesulitan: 'mudah' },
    { pertanyaan: 'Soal 2', jenis: 'essay', bobot: 20, tingkat_kesulitan: 'sulit' },
    { pertanyaan: 'Soal 3', jenis: 'isian', bobot: 10, tingkat_kesulitan: 'SEDANG' },
    { pertanyaan: 'Soal 4', jenis: 'essay', bobot: 20, tingkat_kesulitan: 'invalid_val' },
    { pertanyaan: 'Soal 5', jenis: 'isian', bobot: 10 }
  ];

  const normalized = geminiService.normalizeGeneratedQuestions(rawQuestions, 100, { tingkat_kesulitan: 'mudah' });
  assert.equal(normalized.length, 5);
  assert.equal(normalized[0].tingkat_kesulitan, 'mudah');
  assert.equal(normalized[1].tingkat_kesulitan, 'sulit');
  assert.equal(normalized[2].tingkat_kesulitan, 'sedang');
  assert.equal(normalized[3].tingkat_kesulitan, 'mudah'); // falls back to options.tingkat_kesulitan
  assert.equal(normalized[4].tingkat_kesulitan, 'mudah'); // falls back to options.tingkat_kesulitan

  const totalBobot = normalized.reduce((sum, q) => sum + q.bobot, 0);
  assert.equal(totalBobot, 100);
});

test('geminiService: fallbackOfflineQuestionGenerator assigns valid tingkat_kesulitan', () => {
  const result = geminiService.fallbackOfflineQuestionGenerator({
    input_sumber: 'Matematika Dasar',
    jumlah_soal: 5,
    tipe_soal: 'campuran',
    tingkat_kesulitan: 'bervariasi',
    target_total_bobot: 100
  });

  assert.equal(result.success, true);
  assert.equal(result.soal.length, 5);
  result.soal.forEach(s => {
    assert.ok(['mudah', 'sedang', 'sulit'].includes(s.tingkat_kesulitan), `Invalid kesulitan: ${s.tingkat_kesulitan}`);
  });
});

test('examService: calibrateQuestionWeights works correctly across modes', (t) => {
  // Buat guru dan ulangan testing dummy
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  if (!guru) return; // skip if no guru in db

  const newExam = examService.createUlangan(guru.id, {
    judul: 'Test Kalibrasi Bobot',
    mata_pelajaran: 'Matematika',
    tingkat_kelas: 'X',
    durasi_menit: 60,
    kkm: 75
  });

  // Tambahkan 4 soal: 2 isian (mudah & sedang), 2 essay (sedang & sulit)
  examService.createSoal(newExam.id, { pertanyaan: 'Q1', jenis: 'isian', tingkat_kesulitan: 'mudah', bobot: 10 });
  examService.createSoal(newExam.id, { pertanyaan: 'Q2', jenis: 'isian', tingkat_kesulitan: 'sedang', bobot: 10 });
  examService.createSoal(newExam.id, { pertanyaan: 'Q3', jenis: 'essay', tingkat_kesulitan: 'sedang', bobot: 20 });
  examService.createSoal(newExam.id, { pertanyaan: 'Q4', jenis: 'essay', tingkat_kesulitan: 'sulit', bobot: 40 });

  // 1. Mode Proportional (Cerdas) ke target 100
  const calibProp = examService.calibrateQuestionWeights(newExam.id, guru.id, {
    target_total_bobot: 100,
    mode: 'proportional'
  });
  assert.equal(calibProp.success, true);
  assert.equal(calibProp.total_bobot, 100);
  const qProp = calibProp.soal;
  // Essay Sulit (Q4) harus punya bobot terbesar, Isian Mudah (Q1) harus punya bobot terkecil
  assert.ok(qProp[3].bobot > qProp[2].bobot, 'Q4 (Essay Sulit) > Q3 (Essay Sedang)');
  assert.ok(qProp[2].bobot > qProp[1].bobot, 'Q3 (Essay Sedang) > Q2 (Isian Sedang)');
  assert.ok(qProp[1].bobot > qProp[0].bobot, 'Q2 (Isian Sedang) > Q1 (Isian Mudah)');

  // 1.b Mode Proportional ke target ideal benchmark (68: 8 + 10 + 20 + 30)
  const calibIdeal = examService.calibrateQuestionWeights(newExam.id, guru.id, {
    target_total_bobot: 68,
    mode: 'proportional'
  });
  assert.equal(calibIdeal.success, true);
  assert.equal(calibIdeal.total_bobot, 68);
  assert.equal(calibIdeal.soal[0].bobot, 8, 'Isian Mudah tepat 8');
  assert.equal(calibIdeal.soal[1].bobot, 10, 'Isian Sedang tepat 10');
  assert.equal(calibIdeal.soal[2].bobot, 20, 'Essay Sedang tepat 20');
  assert.equal(calibIdeal.soal[3].bobot, 30, 'Essay Sulit tepat 30');

  // 2. Mode Uniform ke target 100
  const calibUniform = examService.calibrateQuestionWeights(newExam.id, guru.id, {
    target_total_bobot: 100,
    mode: 'uniform'
  });
  assert.equal(calibUniform.success, true);
  assert.equal(calibUniform.total_bobot, 100);
  // Tiap butir harus 25 (100 / 4)
  calibUniform.soal.forEach(s => assert.equal(s.bobot, 25));

  // 3. Mode Scale Current ke target 50
  const calibScale = examService.calibrateQuestionWeights(newExam.id, guru.id, {
    target_total_bobot: 50,
    mode: 'scale_current'
  });
  assert.equal(calibScale.success, true);
  assert.equal(calibScale.total_bobot, 50);

  // Bersihkan data testing
  examService.deleteUlangan(newExam.id, guru.id);
});
