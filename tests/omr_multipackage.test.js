const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.NODE_ENV = 'test';
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const packageService = require('../src/services/packageService');
const omrService = require('../src/services/omrService');
const studentService = require('../src/services/studentService');
const reviewService = require('../src/services/reviewService');
const app = require('../server');

describe('=== SUITE: FITUR OMR SCANNER, MULTI-PAKET (A/B/C/D), & UJIAN GABUNGAN ===', () => {
  let testGuruId;
  let testUlanganId;
  let server;
  let baseUrl;
  let teacherCookie = '';

  before(async () => {
    // Pastikan akun guru ada
    const guru = db.prepare('SELECT id, email, password FROM guru LIMIT 1').get();
    testGuruId = guru.id;

    // Start ephemeral server
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;

    // Login guru untuk mendapatkan token auth
    const authRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: guru.email, password: process.env.TEACHER_PASSWORD || guru.password || 'Guru123' })
    });
    const authData = await authRes.json();
    if (authData.token) {
      teacherCookie = `auth_token=${authData.token}`;
    }

    // Buat ulangan campuran (Pilihan Ganda 60% + Esai 40%)
    const ulangan = examService.createUlangan(testGuruId, {
      judul: 'Asesmen Sumatif IPA & Biologi',
      mata_pelajaran: 'Ilmu Pengetahuan Alam',
      tingkat_kelas: '7A, 7B',
      jenis_ulangan: 'campuran',
      jumlah_paket: 4,
      bobot_pg: 60,
      bobot_essay: 40,
      opsi_pg_count: 4
    });
    testUlanganId = ulangan.id;
    // Buka status ulangan agar siswa dapat mengerjakan
    examService.updateStatusUlangan(testUlanganId, 'dibuka');

    // Tambah 5 soal Pilihan Ganda (PG) dengan kunci bervariasi
    const pgData = [
      { nomor: 1, pertanyaan: 'Organel sel penghasil energi adalah...', jenis: 'pilihan_ganda', opsi_a: 'Ribosom', opsi_b: 'Mitokondria', opsi_c: 'Lisosom', opsi_d: 'Vakuola', kunci_pg: 'B', bobot: 2 },
      { nomor: 2, pertanyaan: 'Zat hijau daun disebut...', jenis: 'pilihan_ganda', opsi_a: 'Klorofil', opsi_b: 'Kloroplas', opsi_c: 'Stomata', opsi_d: 'Sitoplasma', kunci_pg: 'A', bobot: 2 },
      { nomor: 3, pertanyaan: 'Bagian terkecil dari makhluk hidup adalah...', jenis: 'pilihan_ganda', opsi_a: 'Jaringan', opsi_b: 'Organ', opsi_c: 'Sel', opsi_d: 'Sistem Organ', kunci_pg: 'C', bobot: 2 },
      { nomor: 4, pertanyaan: 'Gas yang dibutuhkan tumbuhan untuk fotosintesis adalah...', jenis: 'pilihan_ganda', opsi_a: 'Oksigen', opsi_b: 'Nitrogen', opsi_c: 'Karbon Monoksida', opsi_d: 'Karbon Dioksida', kunci_pg: 'D', bobot: 2 },
      { nomor: 5, pertanyaan: 'Alat pernapasan utama pada ikan adalah...', jenis: 'pilihan_ganda', opsi_a: 'Paru-paru', opsi_b: 'Insang', opsi_c: 'Trakea', opsi_d: 'Kulit', kunci_pg: 'B', bobot: 2 }
    ];

    for (const q of pgData) {
      examService.createSoal(testUlanganId, q);
    }

    // Tambah 1 soal Esai
    examService.createSoal(testUlanganId, {
      nomor: 6,
      pertanyaan: 'Jelaskan tahapan proses fotosintesis secara singkat!',
      jenis: 'essay',
      kunci_jawaban: 'Tahap reaksi terang dan reaksi gelap di kloroplas.',
      rubrik: 'Menyebutkan reaksi terang, gelap, dan kloroplas.',
      bobot: 10
    });
  });

  after(async () => {
    if (testUlanganId) {
      try {
        db.prepare('DELETE FROM ulangan WHERE id = ?').run(testUlanganId);
      } catch (e) {}
    }
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('1. Guru dapat men-generate 4 Paket Soal (A, B, C, D) dengan urutan teracak dan kunci otomatis', () => {
    const res = packageService.generatePackages(testUlanganId, { packageCount: 4 });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.jumlah_paket, 4);
    assert.strictEqual(res.packages.length, 4);

    // Pastikan setiap paket memiliki 5 kunci jawaban PG
    for (const pkg of res.packages) {
      assert.ok(['A', 'B', 'C', 'D'].includes(pkg.nama_paket));
      assert.strictEqual(Object.keys(pkg.kunci_jawaban_map).length, 5);
    }

    // Paket A selalu urutan asli: 1:B, 2:A, 3:C, 4:D, 5:B
    const keyA = res.packages.find(p => p.nama_paket === 'A').kunci_jawaban_map;
    assert.strictEqual(keyA['1'], 'B');
    assert.strictEqual(keyA['2'], 'A');
    assert.strictEqual(keyA['3'], 'C');
    assert.strictEqual(keyA['4'], 'D');
    assert.strictEqual(keyA['5'], 'B');
  });

  test('2. Guru dapat mengambil naskah cetak naskah soal terpisah per paket', () => {
    const printA = packageService.getPrintableQuestionsByPackage(testUlanganId, 'A');
    assert.strictEqual(printA.paket, 'A');
    assert.strictEqual(printA.soal_pg.length, 5);
    assert.strictEqual(printA.soal_essay.length, 1);

    const printB = packageService.getPrintableQuestionsByPackage(testUlanganId, 'B');
    assert.strictEqual(printB.paket, 'B');
    assert.strictEqual(printB.soal_pg.length, 5);
  });

  test('3. Algoritma OMR dapat mengoreksi jawaban siswa paket A secara tepat (Benar, Salah, Kosong)', () => {
    // Kunci Paket A: 1:B, 2:A, 3:C, 4:D, 5:B
    // Siswa jawab: 1:B (benar), 2:B (salah), 3:C (benar), 4:D (benar), 5: (kosong)
    const answersMap = { '1': 'B', '2': 'B', '3': 'C', '4': 'D' };
    const scored = omrService.scoreSubmission({
      ulanganId: testUlanganId,
      paket: 'A',
      answersMap
    });

    assert.strictEqual(scored.total_soal, 5);
    assert.strictEqual(scored.total_benar, 3);
    assert.strictEqual(scored.total_salah, 1);
    assert.strictEqual(scored.total_kosong, 1);
    assert.strictEqual(scored.skor_pg, 60); // 3 / 5 * 100 = 60
  });

  test('4. Hasil scan kamera LJK OMR tersimpan seketika ke database peserta dan rekap nilai guru', () => {
    const scanData = {
      ulanganId: testUlanganId,
      namaSiswa: 'Budi Santoso',
      kelas: '7A',
      paket: 'A',
      answersMap: { '1': 'B', '2': 'A', '3': 'C', '4': 'D', '5': 'B' }, // 100% benar
      imageData: 'data:image/jpeg;base64,samplethumbnail...'
    };

    const saved = omrService.saveScannedResult(scanData);
    assert.strictEqual(saved.success, true);
    assert.strictEqual(saved.skor_pg, 100);
    assert.strictEqual(saved.total_benar, 5);

    // Cek pengerjaan di DB
    const pengerjaan = db.prepare('SELECT * FROM pengerjaan WHERE id = ?').get(saved.pengerjaan_id);
    assert.ok(pengerjaan);
    assert.strictEqual(pengerjaan.skor_pg, 100);
    assert.strictEqual(pengerjaan.metode_koreksi_pg, 'kamera_omr');
  });

  test('5. Mode Ujian Online: Siswa mengerjakan PG di web dan langsung dinilai instan 100% tanpa token AI', () => {
    const ulangan = db.prepare('SELECT kode_ujian FROM ulangan WHERE id = ?').get(testUlanganId);
    
    // Siswa mulai ujian online
    const startRes = studentService.startExam(ulangan.kode_ujian, 'Siti Nurhaliza', '7B');
    assert.strictEqual(startRes.alreadySubmitted, false);
    assert.ok(startRes.soal.length >= 5);

    // Pastikan opsi A s/d D tersedia di payload siswa
    const pgItem = startRes.soal.find(s => s.jenis === 'pilihan_ganda');
    assert.ok(pgItem.opsi_a);
    assert.ok(pgItem.opsi_b);
    assert.ok(pgItem.opsi_c);
    assert.ok(pgItem.opsi_d);
    // Kunci tidak boleh bocor ke siswa
    assert.strictEqual(pgItem.kunci_pg, undefined);

    // Siswa submit ujian (jawab PG saja)
    const answers = [
      { soal_id: startRes.soal[0].id, jawaban_siswa: 'B' },
      { soal_id: startRes.soal[1].id, jawaban_siswa: 'A' },
      { soal_id: startRes.soal[2].id, jawaban_siswa: 'C' },
      { soal_id: startRes.soal[3].id, jawaban_siswa: 'D' },
      { soal_id: startRes.soal[4].id, jawaban_siswa: 'B' }
    ];

    const submitRes = studentService.submitExam(startRes.pengerjaanId, answers);
    assert.strictEqual(submitRes.success, true);
    assert.strictEqual(submitRes.skor_pg, 100);
    assert.strictEqual(submitRes.benar_pg, 5);
  });

  test('6. Kalkulasi Nilai Akhir Campuran (Bobot PG 60% + Bobot Esai 40%) terhitung otomatis', () => {
    // Ambil pengerjaan siswa Budi (skor PG = 100)
    const p = db.prepare('SELECT id FROM pengerjaan WHERE ulangan_id = ? AND skor_pg = 100 LIMIT 1').get(testUlanganId);
    assert.ok(p);

    // Beri nilai esai = 80 melalui reviewService
    const soalEssay = db.prepare("SELECT id, bobot FROM soal WHERE ulangan_id = ? AND jenis = 'essay'").get(testUlanganId);
    assert.ok(soalEssay);

    // Tambah jawaban esai untuk pengerjaan ini jika belum ada
    db.prepare(`
      INSERT INTO jawaban (pengerjaan_id, soal_id, jawaban_siswa, skor_maksimum, skor_rekomendasi, status_penilaian)
      VALUES (?, ?, 'Reaksi terang dan gelap', ?, 8, 'selesai')
    `).run(p.id, soalEssay.id, soalEssay.bobot);

    // Recalculate
    const recalc = reviewService.recalculatePengerjaanTotal(p.id);
    
    // PG (100 * 60%) = 60
    // Esai (80 * 40%) = 32
    // Total Nilai = 92
    assert.strictEqual(recalc.nilai_final, 92);
  });

  test('7. REST API Endpoints: Guru dapat generate paket, ambil naskah print, dan kirim scan OMR via Express', async () => {
    // Test endpoint generate paket
    const genRes = await fetch(`${baseUrl}/api/guru/ulangan/${testUlanganId}/packages/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': teacherCookie
      },
      body: JSON.stringify({ packageCount: 2 })
    });
    const genData = await genRes.json();
    assert.strictEqual(genRes.status, 200);
    assert.strictEqual(genData.success, true);
    assert.strictEqual(genData.jumlah_paket, 2);

    // Test endpoint list paket
    const listRes = await fetch(`${baseUrl}/api/guru/ulangan/${testUlanganId}/packages`, {
      headers: { 'Cookie': teacherCookie }
    });
    const listData = await listRes.json();
    assert.strictEqual(listRes.status, 200);
    assert.strictEqual(listData.packages.length, 2);

    // Test endpoint printable
    const printRes = await fetch(`${baseUrl}/api/guru/ulangan/${testUlanganId}/packages/A/printable`, {
      headers: { 'Cookie': teacherCookie }
    });
    const printData = await printRes.json();
    assert.strictEqual(printRes.status, 200);
    assert.strictEqual(printData.paket, 'A');

    // Test endpoint scan result
    const scanRes = await fetch(`${baseUrl}/api/guru/ulangan/${testUlanganId}/omr/scan-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': teacherCookie
      },
      body: JSON.stringify({
        namaSiswa: 'Dewi Lestari',
        kelas: '7A',
        paket: 'A',
        answersMap: { '1': 'B', '2': 'A', '3': 'C', '4': 'D', '5': 'B' }
      })
    });
    const scanData = await scanRes.json();
    assert.strictEqual(scanRes.status, 200);
    assert.strictEqual(scanData.success, true);
    assert.strictEqual(scanData.skor_pg, 100);
  });
});
