const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const reviewService = require('../src/services/reviewService');
const authService = require('../src/services/authService');
const adminService = require('../src/services/adminService');
const fileParserService = require('../src/services/fileParserService');
const geminiService = require('../src/services/geminiService');

test('T-17: Upload Dokumen Materi, Persona Guru AI, Status Remedial & Riwayat Nilai Kronologis', async (t) => {
  const guru = db.prepare('SELECT id, nama, email, no_wa FROM guru LIMIT 1').get();
  assert.ok(guru, 'Guru harus tersedia di database');

  let testGuruId = guru.id;
  const uniqueStudentName = 'Anton Wijaya ' + Date.now();
  let ulangan1Id;
  let ulangan2Id;
  let pengerjaan1Id;
  let pengerjaan2Id;

  await t.test('1. fileParserService: Ekstraksi teks dari berkas TXT dan CSV/Spreadsheet', async () => {
    // 1a. Test berkas Plain Text
    const rawText = 'Fotosintesis adalah proses biokimia pembentukan karbohidrat oleh tumbuhan berklorofil.';
    const base64Txt = Buffer.from(rawText, 'utf-8').toString('base64');
    const resTxt = await fileParserService.parseFile(base64Txt, 'materi_biologi.txt');

    assert.strictEqual(resTxt.success, true);
    assert.strictEqual(resTxt.fileType, 'text');
    assert.ok(resTxt.text.includes('Fotosintesis adalah proses biokimia'));
    assert.ok(resTxt.charCount > 0);

    // 1b. Test berkas CSV / Spreadsheet
    const rawCsv = 'No,Pertanyaan,Kunci\n1,Apa ibu kota Indonesia?,Nusantara\n2,Berapa hasil 2+2?,4';
    const base64Csv = Buffer.from(rawCsv, 'utf-8').toString('base64');
    const resCsv = await fileParserService.parseFile(base64Csv, 'daftar_soal.csv');

    assert.strictEqual(resCsv.success, true);
    assert.strictEqual(resCsv.fileType, 'excel');
    assert.ok(resCsv.text.includes('Nusantara'));
    assert.ok(resCsv.text.includes('hasil 2+2'));

    // 1c. Test berkas ekstensi tidak didukung
    await assert.rejects(async () => {
      await fileParserService.parseFile(base64Txt, 'virus.exe');
    }, /Format berkas '\.exe' tidak didukung/);
  });

  await t.test('2. Pengaturan Profil Guru & Kontak WhatsApp (authService & adminService)', () => {
    const updated = authService.updateGuruProfile(testGuruId, {
      nama: 'Bpk. Ahmad Dahlan, S.Pd',
      no_wa: '081298765432'
    });

    assert.strictEqual(updated.nama, 'Bpk. Ahmad Dahlan, S.Pd');
    assert.strictEqual(updated.no_wa, '081298765432');

    const profile = authService.getGuruProfile(testGuruId);
    assert.strictEqual(profile.no_wa, '081298765432');

    const allGuru = adminService.getAllGuru();
    const found = allGuru.find(g => g.id === testGuruId);
    assert.strictEqual(found.no_wa, '081298765432');
  });

  await t.test('3. Evaluasi Persona Guru AI: Edukatif, Objektif, Membimbing', () => {
    const evalResult = geminiService.fallbackOfflineEvaluation({
      pertanyaan: 'Jelaskan perbedaan fotosintesis dan kemosintesis!',
      kunci_jawaban: 'Fotosintesis menggunakan energi cahaya matahari, sedangkan kemosintesis menggunakan energi kimia dari reaksi anorganik.',
      jawaban_siswa: 'Fotosintesis pakai cahaya matahari tapi kalau kemosintesis pakai energi kimia',
      bobot: 100,
      skor_maksimum: 100,
      jenis: 'essay'
    });

    assert.ok(evalResult.skor_rekomendasi >= 50);
    assert.ok(evalResult.alasan_ai && evalResult.alasan_ai.length > 5);
  });

  await t.test('4. Skenario Remedial & Kontak Guru saat Nilai di Bawah KKM', () => {
    const exam1 = examService.createUlangan(testGuruId, {
      judul: 'Ulangan Harian Bab 1 Ekosistem',
      mata_pelajaran: 'Biologi',
      tingkat_kelas: '10 MIPA',
      kkm: 80
    });
    ulangan1Id = exam1.id;

    examService.createSoal(ulangan1Id, {
      nomor: 1,
      jenis: 'isian',
      pertanyaan: 'Sebutkan tingkatan trofik pertama dalam rantai makanan!',
      kunci_jawaban: 'Produsen',
      bobot: 100
    });
    examService.updateUlangan(ulangan1Id, testGuruId, { status: 'dibuka' });

    const start1 = studentService.startExam(exam1.kode_ujian, uniqueStudentName, '10 MIPA 1');
    pengerjaan1Id = start1.pengerjaanId;

    studentService.submitExam(pengerjaan1Id, [
      { soal_id: start1.soal[0].id, jawaban_siswa: 'Konsumen Primer' }
    ]);

    const pengerjaanDetail = reviewService.getPengerjaanDetail(pengerjaan1Id, testGuruId);
    const jwbId = pengerjaanDetail.jawabanList[0].jawaban_id;
    reviewService.updateJawabanReview(jwbId, testGuruId, {
      skor_final: 50,
      catatan_guru: 'Jawaban salah, pelajari kembali tingkatan trofik produsen.'
    });
    reviewService.toggleReleasePengerjaan(ulangan1Id, testGuruId, true);

    const statusResult = studentService.getPengerjaanStatus(pengerjaan1Id);
    assert.strictEqual(statusResult.isReleased, true);
    assert.strictEqual(statusResult.nilaiFinal, 50);
    assert.strictEqual(statusResult.kkm, 80);
    assert.strictEqual(statusResult.isRemedial, true);
    assert.ok(statusResult.guru);
    assert.strictEqual(statusResult.guru.nama, 'Bpk. Ahmad Dahlan, S.Pd');
    assert.strictEqual(statusResult.guru.no_wa, '081298765432');
    assert.ok(statusResult.guru.wa_link.startsWith('https://wa.me/6281298765432?text='));
    assert.ok(statusResult.guru.wa_link.includes('remedial'));
  });

  await t.test('5. Riwayat Nilai Ulangan Siswa: Urut Tanggal Descending (Terbaru di Atas, Lama di Bawah)', async () => {
    await new Promise(r => setTimeout(r, 100));

    const exam2 = examService.createUlangan(testGuruId, {
      judul: 'Ulangan Perbaikan Remedial Bab 1',
      mata_pelajaran: 'Biologi',
      tingkat_kelas: '10 MIPA',
      kkm: 75
    });
    ulangan2Id = exam2.id;

    examService.createSoal(ulangan2Id, {
      nomor: 1,
      jenis: 'isian',
      pertanyaan: 'Organisme yang mampu membuat makanan sendiri disebut organisme apa?',
      kunci_jawaban: 'Autotrof',
      bobot: 100
    });
    examService.updateUlangan(ulangan2Id, testGuruId, { status: 'dibuka' });

    const start2 = studentService.startExam(exam2.kode_ujian, uniqueStudentName, '10 MIPA 1');
    pengerjaan2Id = start2.pengerjaanId;

    studentService.submitExam(pengerjaan2Id, [
      { soal_id: start2.soal[0].id, jawaban_siswa: 'Autotrof' }
    ]);

    const pengerjaan2Detail = reviewService.getPengerjaanDetail(pengerjaan2Id, testGuruId);
    const jwb2Id = pengerjaan2Detail.jawabanList[0].jawaban_id;
    reviewService.updateJawabanReview(jwb2Id, testGuruId, {
      skor_final: 90,
      catatan_guru: 'Bagus sekali, pemahaman konsep sudah tepat.'
    });
    reviewService.toggleReleasePengerjaan(ulangan2Id, testGuruId, true);

    const history = studentService.getStudentExamHistory(pengerjaan2Id);
    assert.ok(Array.isArray(history));
    assert.strictEqual(history.length, 2);

    assert.strictEqual(history[0].pengerjaanId, pengerjaan2Id);
    assert.strictEqual(history[0].judul, 'Ulangan Perbaikan Remedial Bab 1');
    assert.strictEqual(history[0].isRemedial, false);
    assert.strictEqual(history[0].nilaiFinal, 90);
    assert.strictEqual(history[0].isCurrentExam, true);

    assert.strictEqual(history[1].pengerjaanId, pengerjaan1Id);
    assert.strictEqual(history[1].judul, 'Ulangan Harian Bab 1 Ekosistem');
    assert.strictEqual(history[1].isRemedial, true);
    assert.strictEqual(history[1].nilaiFinal, 50);
    assert.strictEqual(history[1].isCurrentExam, false);
    assert.ok(history[1].guru.wa_link.includes('6281298765432'));
  });
});
