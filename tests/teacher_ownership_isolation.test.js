const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const classService = require('../src/services/classService');
const pinService = require('../src/services/pinService');

const scopedFiles = [
  'src/services/classService.js',
  'src/services/examService.js',
  'src/services/reviewService.js',
  'src/services/pinService.js'
];

test('teacher ownership never aliases separate numeric IDs', () => {
  for (const relativePath of scopedFiles) {
    const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    assert.doesNotMatch(
      source,
      /guru_id\s+IN\s*\(\s*1\s*,\s*3\s*\)/i,
      `${relativePath} masih menggabungkan data guru_id 1 dan 3`
    );
    assert.doesNotMatch(
      source,
      /Number\(guruId\)\s*===\s*1[\s\S]{0,120}Number\(guruId\)\s*===\s*3/i,
      `${relativePath} masih memiliki alias kepemilikan berbasis ID khusus`
    );
  }
});

test('teacher-owned exams and classes stay isolated at runtime', () => {
  const teachers = db.prepare('SELECT id FROM guru WHERE id IN (1, 3) ORDER BY id').all();
  assert.equal(teachers.length, 2, 'fixture lokal harus memiliki dua akun guru terpisah');
  const [guruA, guruB] = teachers;
  const examA = examService.createUlangan(guruA.id, {
    judul: `Isolasi Guru A ${Date.now()}`,
    mata_pelajaran: 'Isolasi',
    tingkat_kelas: 'X'
  });
  const examB = examService.createUlangan(guruB.id, {
    judul: `Isolasi Guru B ${Date.now()}`,
    mata_pelajaran: 'Isolasi',
    tingkat_kelas: 'X'
  });

  try {
    assert.ok(examService.getUlanganByGuru(guruA.id).some(item => item.id === examA.id));
    assert.ok(!examService.getUlanganByGuru(guruA.id).some(item => item.id === examB.id));
    assert.equal(examService.getUlanganById(examA.id, guruB.id), null);
    assert.equal(examService.getUlanganById(examB.id, guruA.id), null);
    assert.throws(
      () => pinService.setUlanganPinMode(examA.id, guruB.id, true),
      /bukan ulangan milik Anda/
    );
  } finally {
    try { examService.deleteUlangan(examA.id, guruA.id); } catch (_) {}
    try { examService.deleteUlangan(examB.id, guruB.id); } catch (_) {}
  }
});

