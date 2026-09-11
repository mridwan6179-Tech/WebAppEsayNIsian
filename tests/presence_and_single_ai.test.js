const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const reviewService = require('../src/services/reviewService');
const queueService = require('../src/services/queueService');

test('Deteksi Status Kehadiran Siswa (Aktif vs DC) & Review AI Perorangan', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();

  // Setup ulangan & soal
  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Deteksi Presence & Single AI',
    mata_pelajaran: 'Teknologi Informasi',
    tingkat_kelas: 'Kelas 9'
  });
  examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

  const soal1 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Jelaskan fungsi utama CPU pada komputer!',
    jenis: 'essay',
    bobot: 20,
    kunci_jawaban: 'CPU memproses dan mengeksekusi instruksi data'
  });

  const soal2 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Sebutkan 1 contoh perangkat input!',
    jenis: 'isian',
    bobot: 10,
    kunci_jawaban: 'Keyboard'
  });

  // Siswa 1: Aktif Mengerjakan
  const s1 = studentService.startExam(ulangan.kode_ujian, 'Ahmad Fadhil', '9A');

  // Siswa 2: Terputus (DC / Disconnect)
  const s2 = studentService.startExam(ulangan.kode_ujian, 'Dewi Lestari', '9A');

  // Siswa 3: Sudah Mengumpulkan
  const s3 = studentService.startExam(ulangan.kode_ujian, 'Rian Pratama', '9A');
  studentService.submitExam(s3.pengerjaanId, [
    { soal_id: soal1.id, jawaban_siswa: 'CPU adalah otak komputer untuk mengolah data' },
    { soal_id: soal2.id, jawaban_siswa: 'Keyboard dan mouse' }
  ]);

  await t.test('1. Heartbeat ping memperbarui last_active_at', () => {
    const pingRes = studentService.recordPing(s1.pengerjaanId, 'active');
    assert.strictEqual(pingRes.success, true);
    assert.strictEqual(pingRes.status, 'active');

    const pRow = db.prepare('SELECT last_active_at FROM pengerjaan WHERE id = ?').get(s1.pengerjaanId);
    assert.ok(pRow.last_active_at !== null, 'last_active_at harus terisi');
  });

  await t.test('2. Disconnect eksplisit (offline) menandai last_active_at ke masa lampau', () => {
    const dcRes = studentService.recordPing(s2.pengerjaanId, 'offline');
    assert.strictEqual(dcRes.success, true);
    assert.strictEqual(dcRes.status, 'offline');

    const pRow = db.prepare('SELECT last_active_at FROM pengerjaan WHERE id = ?').get(s2.pengerjaanId);
    assert.ok(pRow.last_active_at.startsWith('2000-01-01'), 'last_active_at harus di-set lampau untuk offline');
  });

  await t.test('3. reviewService mendeteksi status_kehadiran: aktif, dc, dan selesai', () => {
    const list = reviewService.getPengerjaanListByUlangan(ulangan.id, guru.id);
    assert.strictEqual(list.length, 3);

    const ahmad = list.find(p => p.nama_siswa === 'Ahmad Fadhil');
    const dewi = list.find(p => p.nama_siswa === 'Dewi Lestari');
    const rian = list.find(p => p.nama_siswa === 'Rian Pratama');

    // Ahmad baru saja ping -> aktif
    assert.strictEqual(ahmad.status, 'mengerjakan');
    assert.strictEqual(ahmad.status_kehadiran, 'aktif');
    assert.ok(ahmad.terakhir_aktif_teks.includes('aktif'));

    // Dewi offline -> dc
    assert.strictEqual(dewi.status, 'mengerjakan');
    assert.strictEqual(dewi.status_kehadiran, 'dc');
    assert.ok(dewi.terakhir_aktif_teks.includes('Terputus'));

    // Rian sudah submit -> selesai
    assert.strictEqual(rian.status, 'submitted');
    assert.strictEqual(rian.status_kehadiran, 'selesai');
  });

  await t.test('4. Review AI Perorangan (startReviewSingle) menilai hanya siswa yang dipilih', async () => {
    // Buat siswa 4 yang juga submit
    const s4 = studentService.startExam(ulangan.kode_ujian, 'Zaskia Nur', '9A');
    studentService.submitExam(s4.pengerjaanId, [
      { soal_id: soal1.id, jawaban_siswa: 'Pusat kontrol komputer' },
      { soal_id: soal2.id, jawaban_siswa: 'Scanner' }
    ]);

    let mockCallCount = 0;
    const mockGrader = async (item) => {
      mockCallCount++;
      return {
        skor_rekomendasi: item.bobot,
        status_jawaban: 'benar',
        alasan_ai: 'Penjelasan relevan dan tepat.',
        model_ai: 'mock-gemini-single'
      };
    };

    // Nilai HANYA Siswa 3 (Rian Pratama)
    const reviewResult = await queueService.startReviewSingle(s3.pengerjaanId, guru.id, mockGrader, 0);

    assert.strictEqual(reviewResult.success, true);
    assert.strictEqual(reviewResult.pengerjaan_id, s3.pengerjaanId);
    assert.strictEqual(reviewResult.total_dinilai, 2);
    assert.strictEqual(mockCallCount, 2, 'Hanya jawaban siswa terpilih (2 soal) yang diproses AI');
    assert.strictEqual(reviewResult.nilai_ai, 100);
    assert.strictEqual(reviewResult.nilai_final, 100);

    // Cek di DB bahwa nilai Rian terisi
    const rianDB = db.prepare('SELECT nilai_ai, nilai_final FROM pengerjaan WHERE id = ?').get(s3.pengerjaanId);
    assert.strictEqual(rianDB.nilai_ai, 100);
    assert.strictEqual(rianDB.nilai_final, 100);

    // Cek bahwa Siswa 4 (Zaskia) BELUM dinilai
    const zaskiaDB = db.prepare('SELECT nilai_ai, nilai_final FROM pengerjaan WHERE id = ?').get(s4.pengerjaanId);
    assert.strictEqual(zaskiaDB.nilai_ai, null);

    const zaskiaAnswers = db.prepare('SELECT status_penilaian FROM jawaban WHERE pengerjaan_id = ?').all(s4.pengerjaanId);
    for (const a of zaskiaAnswers) {
      assert.strictEqual(a.status_penilaian, 'menunggu');
    }
  });

  await t.test('5. Nilai AI perorangan dapat dijalankan ulang (re-grade) jika dibutuhkan', async () => {
    const mockGraderHalf = async (item) => {
      return {
        skor_rekomendasi: item.bobot / 2,
        status_jawaban: 'sebagian',
        alasan_ai: 'Jawaban kurang lengkap.',
        model_ai: 'mock-gemini-single'
      };
    };

    // Jalankan ulang penilaian pada Rian
    const reResult = await queueService.startReviewSingle(s3.pengerjaanId, guru.id, mockGraderHalf, 0);
    assert.strictEqual(reResult.success, true);
    assert.strictEqual(reResult.nilai_ai, 50);
    assert.strictEqual(reResult.nilai_final, 50);

    const rianDB = db.prepare('SELECT nilai_ai, nilai_final FROM pengerjaan WHERE id = ?').get(s3.pengerjaanId);
    assert.strictEqual(rianDB.nilai_ai, 50);
  });

  await t.test('6. Validasi hak akses & status pengerjaan saat startReviewSingle', async () => {
    // Tolak jika bukan milik guru yang bersangkutan
    await assert.rejects(
      async () => queueService.startReviewSingle(s3.pengerjaanId, 999999),
      /Akses ditolak/
    );

    // Tolak jika siswa belum mengumpulkan ujian
    await assert.rejects(
      async () => queueService.startReviewSingle(s1.pengerjaanId, guru.id),
      /belum dikumpulkan/
    );
  });
});
