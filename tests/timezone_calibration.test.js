const { describe, it } = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const reviewService = require('../src/services/reviewService');

describe('Kalibrasi Zona Waktu (WIB, WITA, WIT), Hapus Pengerjaan & Deteksi Duplikat', () => {

  // Ambil guru ID pengujian
  let guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  if (!guru) {
    const info = db.prepare('INSERT INTO guru (email, nama, password) VALUES (?, ?, ?)').run('guru.tz@test.id', 'Guru TZ', 'guru123');
    guru = { id: info.lastInsertRowid };
  }

  it('1. parseIndonesianDateTime mengonversi waktu datetime-local ke UTC ISO dengan offset WIB (+07:00), WITA (+08:00), WIT (+09:00)', () => {
    // 2026-09-10 18:00 di WIB (UTC+7) harus sama dengan 11:00 UTC
    const isoWib = examService.parseIndonesianDateTime('2026-09-10T18:00', 'WIB');
    assert.strictEqual(isoWib, '2026-09-10T11:00:00.000Z');

    // 2026-09-10 18:00 di WITA (UTC+8) harus sama dengan 10:00 UTC
    const isoWita = examService.parseIndonesianDateTime('2026-09-10T18:00', 'WITA');
    assert.strictEqual(isoWita, '2026-09-10T10:00:00.000Z');

    // 2026-09-10 18:00 di WIT (UTC+9) harus sama dengan 09:00 UTC
    const isoWit = examService.parseIndonesianDateTime('2026-09-10T18:00', 'WIT');
    assert.strictEqual(isoWit, '2026-09-10T09:00:00.000Z');

    // Jika string sudah memiliki Z, tetap terjaga
    const isoZ = examService.parseIndonesianDateTime('2026-09-10T11:00:00.000Z', 'WIB');
    assert.strictEqual(isoZ, '2026-09-10T11:00:00.000Z');
  });

  it('2. formatIndonesianDateTime memformat waktu ISO UTC kembali ke jam lokal dengan label zona waktu', () => {
    const utcIso = '2026-09-10T11:00:00.000Z';

    const strWib = examService.formatIndonesianDateTime(utcIso, 'WIB', true);
    assert.ok(strWib.includes('18.00') || strWib.includes('18:00'), `Expected 18:00 in WIB, got ${strWib}`);
    assert.ok(strWib.includes('WIB'), `Expected WIB label, got ${strWib}`);

    const strWita = examService.formatIndonesianDateTime(utcIso, 'WITA', true);
    assert.ok(strWita.includes('19.00') || strWita.includes('19:00'), `Expected 19:00 in WITA, got ${strWita}`);
    assert.ok(strWita.includes('WITA'), `Expected WITA label, got ${strWita}`);

    const strWit = examService.formatIndonesianDateTime(utcIso, 'WIT', true);
    assert.ok(strWit.includes('20.00') || strWit.includes('20:00'), `Expected 20:00 in WIT, got ${strWit}`);
    assert.ok(strWit.includes('WIT'), `Expected WIT label, got ${strWit}`);
  });

  it('3. Buat dan update ulangan dengan zona_waktu tersimpan di database', () => {
    const ulangan = examService.createUlangan(guru.id, {
      judul: 'Ulangan Kalibrasi Waktu',
      mata_pelajaran: 'Fisika',
      tingkat_kelas: '10 MIPA',
      zona_waktu: 'WITA',
      tanggal_mulai: '2026-10-01T08:00',
      tanggal_selesai: '2026-10-01T10:00',
      durasi_menit: 90
    });

    assert.strictEqual(ulangan.zona_waktu, 'WITA');
    // 08:00 WITA (UTC+8) -> 00:00 UTC
    assert.strictEqual(ulangan.tanggal_mulai, '2026-10-01T00:00:00.000Z');

    // Update zona waktu menjadi WIT
    const updated = examService.updateUlangan(ulangan.id, guru.id, {
      zona_waktu: 'WIT',
      tanggal_mulai: '2026-10-01T08:00'
    });
    assert.strictEqual(updated.zona_waktu, 'WIT');
    // 08:00 WIT (UTC+9) -> 2026-09-30T23:00:00.000Z
    assert.strictEqual(updated.tanggal_mulai, '2026-09-30T23:00:00.000Z');
  });

  it('4. Validasi jadwal ujian studentService menyertakan label zona waktu dan waktu server', () => {
    // Ulangan di masa depan (1 jam lagi)
    const futureTime = new Date(Date.now() + 3600 * 1000).toISOString();
    const ulanganFuture = examService.createUlangan(guru.id, {
      judul: 'Ulangan Masa Depan',
      mata_pelajaran: 'Kimia',
      tingkat_kelas: '11 IPA',
      zona_waktu: 'WIB',
      tanggal_mulai: futureTime
    });
    examService.updateUlangan(ulanganFuture.id, guru.id, { status: 'dibuka' });

    const valFuture = studentService.validateExamCode(ulanganFuture.kode_ujian);
    assert.strictEqual(valFuture.valid, false);
    assert.strictEqual(valFuture.status, 'belum_buka');
    assert.strictEqual(valFuture.zona_waktu, 'WIB');
    assert.ok(valFuture.message.includes('WIB'), 'Pesan harus menyebutkan WIB');
    assert.ok(valFuture.message.includes('Waktu server saat ini'), 'Pesan harus menginformasikan jam server');
  });

  it('5. Guru dapat menghapus pengerjaan siswa dan siswa dapat mengerjakan ulang', () => {
    // Buat ulangan terbuka
    const ulangan = examService.createUlangan(guru.id, {
      judul: 'Ulangan Hapus Pengerjaan Test',
      mata_pelajaran: 'Matematika',
      tingkat_kelas: '12 IPA'
    });
    examService.createSoal(ulangan.id, {
      jenis: 'isian',
      pertanyaan: '2 + 2 = ?',
      kunci_jawaban: '4',
      bobot: 100
    });
    examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

    // Siswa mulai dan submit
    const startRes = studentService.startExam(ulangan.kode_ujian, 'Budi Santoso', '12 IPA 1');
    assert.ok(startRes.pengerjaanId);

    const submitRes = studentService.submitExam(startRes.pengerjaanId, [
      { soal_id: startRes.soal[0].id, jawaban_siswa: '4' }
    ]);
    assert.strictEqual(submitRes.success, true);

    // Verifikasi siswa sudah berstatus submitted
    const tryReEnter = studentService.startExam(ulangan.kode_ujian, 'Budi Santoso', '12 IPA 1');
    assert.strictEqual(tryReEnter.alreadySubmitted, true);

    // Guru menghapus pengerjaan siswa
    const delRes = reviewService.deletePengerjaan(startRes.pengerjaanId, guru.id);
    assert.strictEqual(delRes.success, true);

    // Verifikasi siswa sekarang BISA mengerjakan ulang dari awal
    const reStart = studentService.startExam(ulangan.kode_ujian, 'Budi Santoso', '12 IPA 1');
    assert.strictEqual(reStart.alreadySubmitted, false);
    assert.ok(reStart.pengerjaanId);
    assert.notStrictEqual(reStart.pengerjaanId, startRes.pengerjaanId);
  });

  it('6. Guru dilarang menghapus pengerjaan ulangan milik guru lain', () => {
    const ulangan = examService.createUlangan(guru.id, {
      judul: 'Ulangan Keamanan',
      mata_pelajaran: 'Sejarah',
      tingkat_kelas: '10 IPS'
    });
    examService.createSoal(ulangan.id, { jenis: 'isian', pertanyaan: 'Kapan RI merdeka?', kunci_jawaban: '1945', bobot: 100 });
    examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

    const startRes = studentService.startExam(ulangan.kode_ujian, 'Siti Rahma', '10 IPS 2');
    studentService.submitExam(startRes.pengerjaanId, [{ soal_id: startRes.soal[0].id, jawaban_siswa: '1945' }]);

    // Coba hapus dengan ID guru lain (999999)
    assert.throws(() => {
      reviewService.deletePengerjaan(startRes.pengerjaanId, 999999);
    }, /Akses ditolak/);
  });
});
