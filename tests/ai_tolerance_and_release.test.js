const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const geminiService = require('../src/services/geminiService');
const reviewService = require('../src/services/reviewService');
const studentService = require('../src/services/studentService');

describe('T-21: Pengaturan Toleransi Penilaian AI Guru & Indikator Rilis Nilai Siswa/Kelas', () => {
  let testGuruId;
  let testUlanganId;
  let pengerjaanIdA;
  let pengerjaanIdB;

  before(() => {
    // Siapkan guru uji
    const existing = db.prepare('SELECT id FROM guru WHERE email = ?').get('guru_tolerance@sekolah.id');
    if (existing) {
      testGuruId = existing.id;
    } else {
      const info = db.prepare('INSERT INTO guru (email, nama, password) VALUES (?, ?, ?)')
        .run('guru_tolerance@sekolah.id', 'Guru Toleransi AI', 'guru123');
      testGuruId = info.lastInsertRowid;
    }
  });

  it('1. Guru dapat membuat ulangan dengan opsi toleransi AI dan instruksi khusus', () => {
    const ulangan = examService.createUlangan(testGuruId, {
      judul: 'Ulangan Biologi Toleransi AI',
      mata_pelajaran: 'Biologi',
      tingkat_kelas: '10 MIPA',
      izinkan_singkatan: 1,
      izinkan_informal: 1,
      toleransi_typo: 1,
      instruksi_penilaian_khusus: 'Siswa wajib menyebutkan klorofil, jawaban ringkas tetap nilai penuh'
    });

    assert.ok(ulangan.id);
    testUlanganId = ulangan.id;
    assert.strictEqual(ulangan.izinkan_singkatan, 1);
    assert.strictEqual(ulangan.izinkan_informal, 1);
    assert.strictEqual(ulangan.toleransi_typo, 1);
    assert.strictEqual(ulangan.instruksi_penilaian_khusus, 'Siswa wajib menyebutkan klorofil, jawaban ringkas tetap nilai penuh');
  });

  it('2. Guru dapat memperbarui (update) parameter toleransi AI ulangan', () => {
    const updated = examService.updateUlangan(testUlanganId, testGuruId, {
      izinkan_singkatan: 0,
      izinkan_informal: 0,
      toleransi_typo: 0,
      instruksi_penilaian_khusus: 'Gunakan istilah baku ilmiah'
    });

    assert.strictEqual(updated.izinkan_singkatan, 0);
    assert.strictEqual(updated.izinkan_informal, 0);
    assert.strictEqual(updated.toleransi_typo, 0);
    assert.strictEqual(updated.instruksi_penilaian_khusus, 'Gunakan istilah baku ilmiah');
  });

  it('3. buildPrompt menyusun instruksi AI sesuai toleransi aktif & menyuntikkan instruksi khusus guru', () => {
    // Kasus A: Toleransi aktif penuh + instruksi khusus
    const promptA = geminiService.buildPrompt({
      pertanyaan: 'Jelaskan proses fotosintesis',
      jenis: 'essay',
      bobot: 10,
      kunci_jawaban: 'Fotosintesis menghasilkan glukosa dan oksigen dengan bantuan sinar matahari',
      jawaban_siswa: 'fotosistesis itu proses tanaman bikin mknan dgn bantuan chaya mtahari',
      izinkan_singkatan: 1,
      izinkan_informal: 1,
      toleransi_typo: 1,
      instruksi_penilaian_khusus: 'Fokus pada hasil reaksi terang dan gelap'
    });

    assert.ok(promptA.includes('MENGIZINKAN siswa menggunakan singkatan kata umum'), 'Harus memuat izin singkatan umum');
    assert.ok(promptA.includes('JANGAN KURANGI NILAI SAMA SEKALI'), 'Dilarang memotong skor singkatan');
    assert.ok(promptA.includes('MENGIZINKAN penggunaan bahasa santai'), 'Harus memuat izin bahasa santai');
    assert.ok(promptA.includes('Fokus pada hasil reaksi terang dan gelap'), 'Harus memuat parameter instruksi khusus guru');
    assert.ok(promptA.includes('INSTRUKSI & PARAMETER KHUSUS DARI GURU PENGAMPU (PRIORITAS TINGGI)'), 'Harus berlabel prioritas tinggi');

    // Kasus B: Standar ketat (singkatan dipotong, bahasa formal)
    const promptB = geminiService.buildPrompt({
      pertanyaan: 'Jelaskan hukum Newton 1',
      jenis: 'essay',
      bobot: 10,
      kunci_jawaban: 'Benda tetap diam atau GLB jika gaya total nol',
      jawaban_siswa: 'benda ttp diam krn ga ada gaya',
      izinkan_singkatan: 0,
      izinkan_informal: 0,
      toleransi_typo: 0
    });

    assert.ok(promptB.includes('PENGURANGAN NILAI MINOR'), 'Harus menyertakan aturan pengurangan nilai singkatan');
    assert.ok(promptB.includes('KEBIJAKAN BAHASA FORMAL'), 'Harus menyertakan aturan bahasa formal');
    assert.ok(promptB.includes('STANDAR KETAT'), 'Harus menyertakan standar ketat ejaan istilah');
    assert.ok(!promptB.includes('INSTRUKSI & PARAMETER KHUSUS'), 'Tidak boleh memuat blok instruksi khusus jika kosong');
  });

  it('4. fallbackOfflineEvaluation tidak memotong nilai singkatan saat izinkan_singkatan = 1', () => {
    const itemWithTolerance = {
      pertanyaan: 'Sebutkan organ pernapasan utama manusia',
      jenis: 'isian',
      bobot: 10,
      kunci_jawaban: 'paru-paru',
      jawaban_siswa: 'paru-paru yg ada dlm dada manusia',
      izinkan_singkatan: 1
    };

    const resTolerant = geminiService.fallbackOfflineEvaluation(itemWithTolerance);
    assert.strictEqual(resTolerant.skor_rekomendasi, 10, 'Harus mendapatkan skor penuh 10');
    assert.ok(!resTolerant.alasan_ai.includes('pengurangan nilai karena menggunakan singkatan'), 'Tidak boleh ada alasan pemotongan skor singkatan');

    const itemStrict = {
      pertanyaan: 'Sebutkan organ pernapasan utama manusia',
      jenis: 'isian',
      bobot: 10,
      kunci_jawaban: 'paru-paru',
      jawaban_siswa: 'paru-paru yg ada dlm dada manusia',
      izinkan_singkatan: 0
    };

    const resStrict = geminiService.fallbackOfflineEvaluation(itemStrict);
    assert.ok(resStrict.skor_rekomendasi < 10, 'Harus terkena pengurangan nilai minor');
    assert.ok(resStrict.alasan_ai.includes('Terdapat sedikit pengurangan nilai'), 'Harus memuat alasan pemotongan singkatan');
  });

  it('5. Rilis nilai dapat dilakukan per kelas maupun untuk seluruh kelas, dan pengerjaan mencatat released_at', () => {
    // Buat soal untuk ulangan
    const soal = examService.createSoal(testUlanganId, {
      nomor: 1,
      jenis: 'isian',
      pertanyaan: 'Apa fungsi klorofil?',
      kunci_jawaban: 'Menyerap cahaya matahari',
      bobot: 100
    });

    // Buka ulangan
    examService.updateUlangan(testUlanganId, testGuruId, { status: 'dibuka' });
    const uDetail = examService.getUlanganById(testUlanganId, testGuruId);

    // Siswa 1 dari Kelas 10 MIPA 1
    const s1 = studentService.startExam(uDetail.kode_ujian, 'Ahmad Siswa A', '10 MIPA 1');
    pengerjaanIdA = s1.pengerjaanId;
    studentService.submitExam(pengerjaanIdA, { [soal.id]: 'Menyerap cahaya matahari' }, 0, false);

    // Siswa 2 dari Kelas 10 MIPA 2
    const s2 = studentService.startExam(uDetail.kode_ujian, 'Budi Siswa B', '10 MIPA 2');
    pengerjaanIdB = s2.pengerjaanId;
    studentService.submitExam(pengerjaanIdB, { [soal.id]: 'Menyerap cahaya matahari' }, 0, false);

    // Sebelum rilis: kedua siswa memiliki released_at = null
    let listPeserta = reviewService.getPengerjaanListByUlangan(testUlanganId, testGuruId);
    assert.strictEqual(listPeserta.length, 2);
    assert.strictEqual(listPeserta.find(p => p.pengerjaan_id === pengerjaanIdA).released_at, null);
    assert.strictEqual(listPeserta.find(p => p.pengerjaan_id === pengerjaanIdB).released_at, null);

    // Rilis KHUSUS Kelas "10 MIPA 1"
    reviewService.toggleReleasePengerjaan(testUlanganId, testGuruId, true, '10 MIPA 1');
    listPeserta = reviewService.getPengerjaanListByUlangan(testUlanganId, testGuruId);

    const rowA = listPeserta.find(p => p.pengerjaan_id === pengerjaanIdA);
    const rowB = listPeserta.find(p => p.pengerjaan_id === pengerjaanIdB);

    assert.ok(rowA.released_at !== null, 'Siswa 10 MIPA 1 harus sudah dirilis');
    assert.strictEqual(rowB.released_at, null, 'Siswa 10 MIPA 2 harus belum dirilis');

    // Rilis SELURUH kelas
    reviewService.toggleReleasePengerjaan(testUlanganId, testGuruId, true);
    listPeserta = reviewService.getPengerjaanListByUlangan(testUlanganId, testGuruId);
    assert.ok(listPeserta.every(p => p.released_at !== null), 'Semua siswa harus sudah dirilis');

    // Tarik kembali rilis nilai untuk Kelas "10 MIPA 1"
    reviewService.toggleReleasePengerjaan(testUlanganId, testGuruId, false, '10 MIPA 1');
    listPeserta = reviewService.getPengerjaanListByUlangan(testUlanganId, testGuruId);
    const rowAAfter = listPeserta.find(p => p.pengerjaan_id === pengerjaanIdA);
    const rowBAfter = listPeserta.find(p => p.pengerjaan_id === pengerjaanIdB);
    assert.strictEqual(rowAAfter.released_at, null, 'Siswa 10 MIPA 1 harus ditarik kembali');
    assert.ok(rowBAfter.released_at !== null, 'Siswa 10 MIPA 2 tetap dirilis');
  });
});
