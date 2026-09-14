const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');

test('=== PENGUJIAN FITUR CETAK LEMBAR SOAL UJIAN FISIK (A4 / HEMAT KERTAS / ACAK PAKET) ===', async (t) => {
  const guru = db.prepare('SELECT id, nama FROM guru LIMIT 1').get();
  assert.ok(guru, 'Guru harus tersedia di database');

  let ulangan5Soal;
  let ulangan10Soal;

  await t.test('1. Persiapan Ulangan 5 Soal (Ujian Singkat) & 10 Soal', () => {
    // Buat ulangan 5 soal
    ulangan5Soal = examService.createUlangan(guru.id, {
      judul: 'Ulangan Harian Biologi Sel',
      mata_pelajaran: 'Biologi',
      tingkat_kelas: 'Kelas 11',
      durasi_menit: 45
    });

    for (let i = 1; i <= 4; i++) {
      examService.createSoal(ulangan5Soal.id, {
        nomor: i,
        jenis: 'isian',
        pertanyaan: `Pertanyaan Isian ke-${i} tentang organel sel?`,
        kunci_jawaban: `Jawaban Isian ${i}`,
        bobot: 15
      });
    }
    examService.createSoal(ulangan5Soal.id, {
      nomor: 5,
      jenis: 'essay',
      pertanyaan: 'Jelaskan perbedaan mendasar sel hewan dan sel tumbuhan secara rinci!',
      kunci_jawaban: 'Dinding sel, kloroplas, vakuola',
      bobot: 40
    });

    // Buat ulangan 10 soal
    ulangan10Soal = examService.createUlangan(guru.id, {
      judul: 'Ulangan Semester Kimia Dasar',
      mata_pelajaran: 'Kimia',
      tingkat_kelas: 'Kelas 10',
      durasi_menit: 90
    });
    for (let i = 1; i <= 8; i++) {
      examService.createSoal(ulangan10Soal.id, {
        nomor: i,
        jenis: 'isian',
        pertanyaan: `Soal Isian Kimia Nomor ${i}`,
        kunci_jawaban: `Kunci ${i}`,
        bobot: 10
      });
    }
    for (let i = 9; i <= 10; i++) {
      examService.createSoal(ulangan10Soal.id, {
        nomor: i,
        jenis: 'essay',
        pertanyaan: `Soal Essay Kimia Nomor ${i}`,
        kunci_jawaban: `Kunci Essay ${i}`,
        bobot: 10
      });
    }

    assert.strictEqual(ulangan5Soal.id > 0, true);
    assert.strictEqual(ulangan10Soal.id > 0, true);
  });

  await t.test('2. Lembar Cetak 1 Paket Standar: 2 Baris Kosong Isian & 5 Baris Essay', () => {
    const data = examService.getExamPrintData(ulangan5Soal.id, guru.id, {
      jumlah_cetak: 1,
      acak_soal: false
    });

    assert.strictEqual(data.success, true);
    assert.strictEqual(data.ulangan.judul, 'Ulangan Harian Biologi Sel');
    assert.strictEqual(data.ulangan.mata_pelajaran, 'Biologi');
    assert.strictEqual(data.paket_list.length, 1);

    const paket = data.paket_list[0];
    assert.strictEqual(paket.kode_paket, 'Paket Standar');
    assert.strictEqual(paket.soal.length, 5);

    // 4 Soal pertama adalah isian -> baris_jawaban = 2
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(paket.soal[i].jenis, 'isian');
      assert.strictEqual(paket.soal[i].baris_jawaban, 2, 'Isian singkat harus memiliki 2 baris kosong');
      assert.strictEqual(paket.soal[i].nomor_cetak, i + 1);
    }

    // Soal ke-5 adalah essay -> baris_jawaban = 5
    assert.strictEqual(paket.soal[4].jenis, 'essay');
    assert.strictEqual(paket.soal[4].baris_jawaban, 5, 'Essay harus memiliki 5 baris kosong');
    assert.strictEqual(paket.soal[4].nomor_cetak, 5);
  });

  await t.test('3. Deteksi Otomatis Mode Layout: <= 5 Soal = hemat_kertas, > 5 Soal = satu_halaman', () => {
    const data5 = examService.getExamPrintData(ulangan5Soal.id, guru.id, { mode_layout: 'auto' });
    assert.strictEqual(data5.options.mode_layout, 'hemat_kertas', '5 soal harus otomatis memilih mode hemat_kertas');

    const data10 = examService.getExamPrintData(ulangan10Soal.id, guru.id, { mode_layout: 'auto' });
    assert.strictEqual(data10.options.mode_layout, 'satu_halaman', '10 soal harus otomatis memilih mode satu_halaman');
  });

  await t.test('4. Cetak 4 Buah dengan Acak Soal (Paket A, B, C, D) & Anti-Contek', () => {
    const data = examService.getExamPrintData(ulangan5Soal.id, guru.id, {
      jumlah_cetak: 4,
      acak_soal: true,
      sertakan_kunci: true
    });

    assert.strictEqual(data.paket_list.length, 4);
    assert.strictEqual(data.paket_list[0].kode_paket, 'Paket A');
    assert.strictEqual(data.paket_list[1].kode_paket, 'Paket B');
    assert.strictEqual(data.paket_list[2].kode_paket, 'Paket C');
    assert.strictEqual(data.paket_list[3].kode_paket, 'Paket D');

    // Setiap paket harus memiliki tepat 5 butir soal dengan nomor_cetak 1..5
    data.paket_list.forEach((p) => {
      assert.strictEqual(p.soal.length, 5);
      p.soal.forEach((s, idx) => {
        assert.strictEqual(s.nomor_cetak, idx + 1);
        assert.ok(s.nomor_asli >= 1 && s.nomor_asli <= 5);
      });
    });

    // Master Keys harus ada 4 paket
    assert.strictEqual(data.master_keys.length, 4);
    assert.strictEqual(data.master_keys[0].kode_paket, 'Paket A');
    assert.strictEqual(data.master_keys[0].items.length, 5);
  });

  await t.test('5. Kustomisasi Baris Kosong Jawaban (misal: 3 baris isian, 7 baris essay)', () => {
    const data = examService.getExamPrintData(ulangan5Soal.id, guru.id, {
      jumlah_cetak: 1,
      baris_isian: 3,
      baris_essay: 7
    });

    const paket = data.paket_list[0];
    assert.strictEqual(paket.soal[0].baris_jawaban, 3);
    assert.strictEqual(paket.soal[4].baris_jawaban, 7);
  });

  await t.test('6. Keamanan: Guru lain dilarang mencetak ulangan yang bukan miliknya', () => {
    const fakeGuruId = 999999;
    assert.throws(() => {
      examService.getExamPrintData(ulangan5Soal.id, fakeGuruId);
    }, /bukan milik guru ini/i);
  });

  await t.test('7. Pemilihan Jumlah Butir Soal yang Dicetak (misal dari 10 soal hanya cetak 5 soal)', () => {
    const data = examService.getExamPrintData(ulangan10Soal.id, guru.id, {
      jumlah_cetak: 2,
      jumlah_soal_cetak: 5,
      mode_layout: 'auto'
    });

    assert.strictEqual(data.paket_list[0].soal.length, 5, 'Harus terpotong tepat 5 butir soal');
    assert.strictEqual(data.options.mode_layout, 'hemat_kertas', 'Karena hanya cetak 5 soal, otomatis mode hemat_kertas');
  });
});
