const test = require('node:test');
const assert = require('node:assert');
const geminiService = require('../src/services/geminiService');

test('T-23: Fitur Sebaran Pengumuman WhatsApp Otomatis & To-The-Point', async (t) => {
  const sampleUlangan = {
    judul: 'Ulangan Harian Koding Dan AI',
    mata_pelajaran: 'Informatika',
    tingkat_kelas: '7A, 7B',
    kelas: [{ nama_kelas: '7A' }, { nama_kelas: '7B' }],
    durasi_menit: 60,
    zona_waktu: 'WIB',
    tanggal_mulai: '2026-09-11T08:00:00+07:00',
    tanggal_selesai: '2026-09-11T12:00:00+07:00',
    kkm: 75,
    deskripsi: 'Kerjakan seluruh butir soal dengan mandiri dan jujur.',
    kode_ujian: 'HMU4G3'
  };

  await t.test('1. formatDefaultWhatsAppBroadcast menyusun teks to-the-point tanpa basa-basi', () => {
    const text = geminiService.formatDefaultWhatsAppBroadcast(sampleUlangan, 'https://web-app-esay-n-isian.vercel.app');

    assert.ok(text.includes('PEMBERITAHUAN ULANGAN ONLINE'), 'Harus memuat header pengumuman');
    assert.ok(text.includes('Informatika'), 'Harus memuat mata pelajaran');
    assert.ok(text.includes('Ulangan Harian Koding Dan AI'), 'Harus memuat judul ulangan');
    assert.ok(text.includes('7A, 7B'), 'Harus memuat sasaran kelas');
    assert.ok(text.includes('60 Menit'), 'Harus memuat durasi pengerjaan');
    assert.ok(text.includes('HMU4G3'), 'Harus memuat kode ujian');
    assert.ok(text.includes('https://web-app-esay-n-isian.vercel.app/?kode=HMU4G3'), 'Harus memuat tautan langsung dengan kode ujian');
    assert.ok(text.includes('Kerjakan seluruh butir soal dengan mandiri dan jujur.'), 'Harus memuat petunjuk/deskripsi');

    // Pastikan tidak ada kata sambutan basa-basi
    assert.strictEqual(text.toLowerCase().includes('halo siswa'), false, 'Dilarang memuat basa-basi halo siswa');
    assert.strictEqual(text.toLowerCase().includes('semoga kalian sehat'), false, 'Dilarang memuat basa-basi');
    assert.strictEqual(text.toLowerCase().includes('selamat pagi'), false, 'Dilarang memuat basa-basi');
  });

  await t.test('2. generateWhatsAppBroadcast berfungsi cerdas dan fallback ke format standar jika offline', async () => {
    const result = await geminiService.generateWhatsAppBroadcast(sampleUlangan, 'https://web-app-esay-n-isian.vercel.app');
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('HMU4G3'));
  });
});
