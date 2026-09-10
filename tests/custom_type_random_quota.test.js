const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const reviewService = require('../src/services/reviewService');

test('T-24: Fitur Distribusi & Kuota Wajib per Tipe Soal saat Pengacakan (misal: 4 Isian + 1 Essay)', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  assert.ok(guru, 'Guru harus tersedia di database');

  // 1. Buat ulangan dengan bank 20 soal: target 5 soal (wajib 4 isian + 1 essay)
  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Harian Koding - Kuota Acak',
    mata_pelajaran: 'Informatika',
    tingkat_kelas: 'Kelas 8',
    jumlah_soal_tampil: 5,
    jumlah_soal_isian: 4,
    jumlah_soal_essay: 1,
    acak_soal: 1
  });

  assert.strictEqual(ulangan.jumlah_soal_tampil, 5);
  assert.strictEqual(ulangan.jumlah_soal_isian, 4);
  assert.strictEqual(ulangan.jumlah_soal_essay, 1);
  assert.strictEqual(ulangan.acak_soal, 1);

  // Masukkan 20 butir soal: 15 Isian dan 5 Essay
  const isianIds = [];
  const essayIds = [];

  for (let i = 1; i <= 15; i++) {
    const s = examService.createSoal(ulangan.id, {
      nomor: i,
      jenis: 'isian',
      pertanyaan: `Soal Isian Bank Nomor ${i}?`,
      kunci_jawaban: `Jawaban isian ${i}`,
      rubrik: `Rubrik isian ${i}`,
      bobot: 15,
      urutan: i
    });
    isianIds.push(s.id);
  }

  for (let i = 16; i <= 20; i++) {
    const s = examService.createSoal(ulangan.id, {
      nomor: i,
      jenis: 'essay',
      pertanyaan: `Soal Essay Analisis Kasus Nomor ${i}?`,
      kunci_jawaban: `Jawaban essay ${i}`,
      rubrik: `Rubrik essay ${i}`,
      bobot: 40,
      urutan: i
    });
    essayIds.push(s.id);
  }

  assert.strictEqual(isianIds.length, 15);
  assert.strictEqual(essayIds.length, 5);

  // Buka ulangan
  examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

  await t.test('1. Validasi token ujian mengembalikan info kuota tipe soal', () => {
    const val = studentService.validateExamCode(ulangan.kode_ujian);
    assert.strictEqual(val.valid, true);
    assert.strictEqual(val.ulangan.total_soal, 20);
    assert.strictEqual(val.ulangan.soal_dikerjakan, 5);
    assert.strictEqual(val.ulangan.jumlah_soal_isian, 4);
    assert.strictEqual(val.ulangan.jumlah_soal_essay, 1);
  });

  let pengerjaanAId;
  let soalSiswaA;

  await t.test('2. Siswa A menerima tepat 5 soal acak yang terdiri dari 4 Isian dan 1 Essay', () => {
    const sessionA = studentService.startExam(ulangan.kode_ujian, 'Rian Pratama', '8A');
    assert.strictEqual(sessionA.alreadySubmitted, false);
    assert.strictEqual(sessionA.soal.length, 5, 'Total soal yang diterima harus tepat 5 butir');

    pengerjaanAId = sessionA.pengerjaanId;
    soalSiswaA = sessionA.soal;

    const countIsian = soalSiswaA.filter(s => s.jenis === 'isian').length;
    const countEssay = soalSiswaA.filter(s => s.jenis === 'essay').length;

    assert.strictEqual(countIsian, 4, 'Wajib mendapatkan tepat 4 butir soal isian');
    assert.strictEqual(countEssay, 1, 'Wajib mendapatkan tepat 1 butir soal essay');

    // Pastikan ID soal berasal dari masing-masing pool
    const isianDiterima = soalSiswaA.filter(s => s.jenis === 'isian').map(s => s.id);
    const essayDiterima = soalSiswaA.filter(s => s.jenis === 'essay').map(s => s.id);

    assert.ok(isianDiterima.every(id => isianIds.includes(id)));
    assert.ok(essayDiterima.every(id => essayIds.includes(id)));

    // Nomor urut rapi 1..5
    assert.deepStrictEqual(soalSiswaA.map(s => s.nomor), [1, 2, 3, 4, 5]);
  });

  await t.test('3. Siswa B menerima paket acak berbeda namun tetap tepat 4 Isian dan 1 Essay', () => {
    const sessionB = studentService.startExam(ulangan.kode_ujian, 'Siti Nurhaliza', '8A');
    assert.strictEqual(sessionB.soal.length, 5);

    const countIsian = sessionB.soal.filter(s => s.jenis === 'isian').length;
    const countEssay = sessionB.soal.filter(s => s.jenis === 'essay').length;

    assert.strictEqual(countIsian, 4);
    assert.strictEqual(countEssay, 1);

    const idsA = soalSiswaA.map(s => s.id);
    const idsB = sessionB.soal.map(s => s.id);

    // Dengan 15 isian dan 5 essay, variasi kombinasi (C(15,4) * C(5,1) = 1365 * 5 = 6825 variasi)
    // Siswa B hampir pasti menerima kombinasi soal berbeda
    const isIdentical = JSON.stringify(idsA) === JSON.stringify(idsB);
    assert.strictEqual(isIdentical, false, 'Paket soal Siswa B harus berbeda secara acak dari Siswa A');
  });

  await t.test('4. Sesi Persisten: Siswa A refresh tetap menerima 4 Isian & 1 Essay yang sama persis', () => {
    const sessionReload = studentService.startExam(ulangan.kode_ujian, 'Rian Pratama', '8A');
    assert.strictEqual(sessionReload.pengerjaanId, pengerjaanAId);

    const reloadIds = sessionReload.soal.map(s => s.id);
    const originalIds = soalSiswaA.map(s => s.id);
    assert.deepStrictEqual(reloadIds, originalIds, 'Soal tidak berubah saat browser di-refresh');
  });

  await t.test('5. Pengumpulan jawaban & penilaian skor 100 terkalibrasi akurat', () => {
    const answers = soalSiswaA.map(s => ({
      soal_id: s.id,
      jawaban_siswa: `Jawaban siswa untuk soal ${s.id}`
    }));

    const resSubmit = studentService.submitExam(pengerjaanAId, answers);
    assert.strictEqual(resSubmit.success, true);

    const jawabanRows = db.prepare('SELECT id, skor_maksimum FROM jawaban WHERE pengerjaan_id = ?').all(pengerjaanAId);
    assert.strictEqual(jawabanRows.length, 5);

    // Siswa menjawab seluruh soal dengan benar penuh (100%)
    db.transaction(() => {
      jawabanRows.forEach(j => {
        db.prepare(`
          UPDATE jawaban 
          SET skor_rekomendasi = ?, skor_maksimum = ?, status_penilaian = 'selesai', status_jawaban = 'benar'
          WHERE id = ?
        `).run(j.skor_maksimum, j.skor_maksimum, j.id);
      });
    })();

    const finalScore = reviewService.recalculatePengerjaanTotal(pengerjaanAId);
    assert.strictEqual(finalScore.nilai_final, 100);
  });

  await t.test('6. Guru dapat memperbarui kuota tipe soal melalui updateUlangan', () => {
    examService.updateUlangan(ulangan.id, guru.id, {
      jumlah_soal_tampil: 7,
      jumlah_soal_isian: 5,
      jumlah_soal_essay: 2
    });

    const updated = examService.getUlanganById(ulangan.id, guru.id);
    assert.strictEqual(updated.jumlah_soal_tampil, 7);
    assert.strictEqual(updated.jumlah_soal_isian, 5);
    assert.strictEqual(updated.jumlah_soal_essay, 2);
  });

  await t.test('7. Format broadcast WhatsApp menyertakan rincian kuota soal acak', () => {
    const geminiService = require('../src/services/geminiService');
    const u = examService.getUlanganById(ulangan.id, guru.id);
    const waText = geminiService.formatDefaultWhatsAppBroadcast(u, 'https://contoh.sch.id');

    assert.ok(waText.includes('*Jumlah Soal:* 7 Soal Acak (5 Isian + 2 Essay)'));
  });

  await t.test('8. Penanganan fleksibel jika kuota melebihi bank soal tidak menyebabkan crash', () => {
    // Ulangan kecil dengan 2 isian & 1 essay, namun kuota diminta 5 isian & 5 essay
    const ulanganKecil = examService.createUlangan(guru.id, {
      judul: 'Ulangan Mini',
      mata_pelajaran: 'Fisika',
      tingkat_kelas: 'Kelas 7',
      jumlah_soal_tampil: 10,
      jumlah_soal_isian: 5,
      jumlah_soal_essay: 5
    });

    examService.createSoal(ulanganKecil.id, { nomor: 1, jenis: 'isian', pertanyaan: 'Soal 1?', kunci_jawaban: 'A', rubrik: 'R', bobot: 50, urutan: 1 });
    examService.createSoal(ulanganKecil.id, { nomor: 2, jenis: 'isian', pertanyaan: 'Soal 2?', kunci_jawaban: 'B', rubrik: 'R', bobot: 50, urutan: 2 });
    examService.createSoal(ulanganKecil.id, { nomor: 3, jenis: 'essay', pertanyaan: 'Soal 3?', kunci_jawaban: 'C', rubrik: 'R', bobot: 50, urutan: 3 });

    examService.updateUlangan(ulanganKecil.id, guru.id, { status: 'dibuka' });

    const sessionMini = studentService.startExam(ulanganKecil.kode_ujian, 'Doni', '7A');
    assert.strictEqual(sessionMini.soal.length, 3, 'Harus mengambil semua soal yang tersedia tanpa crash');
  });
});
