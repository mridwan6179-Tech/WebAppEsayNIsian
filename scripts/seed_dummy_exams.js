const db = require('../src/config/database');
const examService = require('../src/services/examService');
const packageService = require('../src/services/packageService');
const codingGameService = require('../src/services/codingGameService');

async function main() {
  console.log('🚀 Memulai pembuatan ulangan dummy...');

  // 1. Dapatkan Guru ID 1 (Muhammad Ridwan) atau Guru pertama
  let guru = db.prepare('SELECT id, nama, email FROM guru WHERE id = 1').get();
  if (!guru) {
    guru = db.prepare('SELECT id, nama, email FROM guru LIMIT 1').get();
  }
  console.log(`👤 Menggunakan Akun Guru: ${guru.nama} (ID: ${guru.id}, Email: ${guru.email})`);

  // =========================================================================
  // ULANGAN 1: ULANGAN DUMMY GAME KODING LENGKAP (8 JENIS GAME SMP)
  // =========================================================================
  console.log('\n--- 1. Membuat Ulangan Dummy Game Koding (Seluruh Mode) ---');
  
  // Hapus ulangan demo lama jika pernah dibuat sebelumnya agar bersih
  const existingKoding = db.prepare("SELECT id FROM ulangan WHERE guru_id = ? AND judul LIKE '%[DEMO LAB KODING]%'").all(guru.id);
  for (const ex of existingKoding) {
    console.log(`🗑️ Menghapus versi demo koding lama (ID: ${ex.id})...`);
    db.prepare('DELETE FROM soal WHERE ulangan_id = ?').run(ex.id);
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(ex.id);
  }

  const ulanganKoding = examService.createUlangan(guru.id, {
    judul: '[DEMO LAB KODING] Uji Coba Lengkap Seluruh Mode Permainan Algoritma SMP',
    mata_pelajaran: 'Informatika & Koding SMP',
    tingkat_kelas: 'Kelas 7, Kelas 8, Kelas 9',
    deskripsi: 'Ulangan uji coba interaktif untuk menguji seluruh mekanika game koding: Grid Runner Antariksa, Labirin Forest (Maju & Mundur), Loop Master (Perulangan), If-Else (Percabangan Sensor), Bug Doctor (Perbaikan Kode), Scratch Mini Puzzle (Event-Action), Tebak Pola Algoritmik, dan Parsons Problem (Susun Urutan).',
    jenis_ulangan: 'koding_saja',
    bobot_koding: 100,
    bobot_pg: 0,
    bobot_essay: 0,
    durasi_menit: 60,
    kkm: 75,
    zona_waktu: 'WITA'
  });

  const presets = codingGameService.getPresets();
  const presetMap = new Map(presets.map(p => [p.id, p]));

  // Daftar butir soal koding yang mencakup seluruh mode
  const codingQuestions = [
    {
      presetId: 'preset-grid-runner-1',
      pertanyaan: 'Misi Antariksa: Susun algoritma balok untuk menggerakkan Robot ke gerbang warp 🏁 dan kumpulkan semua 2 bintang target ⭐! Garis finish terkunci sampai kedua bintang terkumpul.',
      bobot: 12
    },
    {
      presetId: 'preset-forest-explorer-1',
      pertanyaan: 'Labirin Hutan Tebing: Masuki celah sempit berbatu untuk mengambil kristal bintang ⭐ lalu gunakan perintah MUNDUR dan berbelok untuk mencapai pos pengamatan 🏁 tanpa menabrak tebing!',
      bobot: 13
    },
    {
      presetId: 'preset-loop-master-1',
      pertanyaan: 'Piramida Tangga Berulang: Kenali pola langkah tangga mendaki (Maju ➔ Belok Kiri ➔ Maju ➔ Belok Kanan). Gunakan balok ULANGI (Loop) agar kode efisien dan memenuhi batas Par!',
      bobot: 13
    },
    {
      presetId: 'preset-if-else-1',
      pertanyaan: 'Gerbang Sensor Lahar Panas: Jalur dipenuhi rintangan lava 🔥! Gunakan balok percabangan JIKA RINTANGAN agar sensor mendeteksi bahaya dan robot otomatis berbelok ke jalan aman.',
      bobot: 13
    },
    {
      presetId: 'preset-bug-doctor-1',
      pertanyaan: 'Dokter Kode (Debugging): Rover penjelajah memiliki kode bawaan yang salah dan menabrak tebing. Periksa balok-baloknya, gunakan tombol ⬆️ ⬇️ untuk menukar urutan atau ganti balok yang keliru!',
      bobot: 12
    },
    {
      presetId: 'preset-scratch-puzzle-1',
      pertanyaan: 'Logika Scratch Mini: Pasangkan setiap Pemicu Kejadian (Event ⚡) dengan Balok Aksi (Action ▶) yang paling logis untuk rancangan game aksi panggung!',
      bobot: 12
    },
    {
      presetId: 'preset-pattern-guesser-1',
      pertanyaan: 'Tebak Pola Patroli Drone: Drone bergerak dalam siklus: [Maju 2 Kotak] ➔ [Belok Kanan 90°] ➔ [Maju 2 Kotak] ➔ [Belok Kanan 90°] ➔ [ ? ]. Tentukan balok kelima yang tepat!',
      bobot: 12
    },
    {
      presetId: 'preset-parsons-puzzle-1',
      pertanyaan: 'Susun Algoritma Pintu Otomatis: Urutkan balok logika sistem microcontroller sensor gerak dari langkah 1 sampai 5 agar pintu mall membuka dan menutup dengan aman!',
      bobot: 15
    }
  ];

  let nomorKoding = 1;
  for (const q of codingQuestions) {
    const preset = presetMap.get(q.presetId);
    if (!preset) {
      console.warn(`⚠️ Preset ${q.presetId} tidak ditemukan!`);
      continue;
    }
    examService.createSoal(ulanganKoding.id, {
      nomor: nomorKoding,
      jenis: 'koding_game',
      pertanyaan: q.pertanyaan,
      bobot: q.bobot,
      tingkat_kesulitan: preset.difficulty || 'sedang',
      game_data: preset
    });
    console.log(`  ✓ Soal ${nomorKoding}: ${preset.title} (${preset.mode} / ${preset.subtipe})`);
    nomorKoding++;
  }

  // Buka ulangan koding agar langsung aktif
  examService.updateStatusUlangan(ulanganKoding.id, 'dibuka');
  console.log(`✅ Ulangan Koding Berhasil Dibuat: ID=${ulanganKoding.id}, Kode Ujian=${ulanganKoding.kode_ujian}`);

  // =========================================================================
  // ULANGAN 2: ULANGAN DUMMY PG MULTI-PAKET (10 SOAL PER PAKET: A, B, C, D)
  // =========================================================================
  console.log('\n--- 2. Membuat Ulangan Dummy PG Multi-Paket (10 Soal per Paket) ---');

  const existingPg = db.prepare("SELECT id FROM ulangan WHERE guru_id = ? AND judul LIKE '%[DEMO PG MULTI-PAKET]%'").all(guru.id);
  for (const ex of existingPg) {
    console.log(`🗑️ Menghapus versi demo PG lama (ID: ${ex.id})...`);
    db.prepare('DELETE FROM paket_soal WHERE ulangan_id = ?').run(ex.id);
    db.prepare('DELETE FROM soal WHERE ulangan_id = ?').run(ex.id);
    db.prepare('DELETE FROM ulangan WHERE id = ?').run(ex.id);
  }

  const ulanganPg = examService.createUlangan(guru.id, {
    judul: '[DEMO PG MULTI-PAKET] Asesmen Sumatif Informatika SMP (Paket A, B, C, D)',
    mata_pelajaran: 'Informatika SMP',
    tingkat_kelas: 'Kelas 7A, 7B, 7C',
    deskripsi: 'Ulangan Pilihan Ganda 10 butir soal standar kurikulum dengan 4 paket soal teracak otomatis (Paket A, B, C, D). Siap untuk dicetak lembar naskah soal per paket, dicetak Lembar Jawaban Komputer (LJK) fisik OMR, dan dipindai menggunakan Scan Kamera LJK.',
    jenis_ulangan: 'pg_saja',
    jumlah_paket: 4,
    bobot_pg: 100,
    bobot_essay: 0,
    bobot_koding: 0,
    opsi_pg_count: 4,
    durasi_menit: 45,
    kkm: 75,
    zona_waktu: 'WITA'
  });

  const pg10Questions = [
    {
      nomor: 1,
      pertanyaan: 'Komponen perangkat keras komputer yang berfungsi sebagai otak utama untuk memproses seluruh instruksi dan perhitungan logika data adalah...',
      opsi_a: 'RAM (Random Access Memory)',
      opsi_b: 'CPU (Central Processing Unit)',
      opsi_c: 'SSD (Solid State Drive)',
      opsi_d: 'GPU (Graphics Processing Unit)',
      kunci_pg: 'B',
      bobot: 10
    },
    {
      nomor: 2,
      pertanyaan: 'Dalam konsep Berpikir Komputasional, teknik memecah masalah yang kompleks atau besar menjadi bagian-bagian yang lebih kecil dan mudah dikelola disebut...',
      opsi_a: 'Dekomposisi (Decomposition)',
      opsi_b: 'Abstraksi (Abstraction)',
      opsi_c: 'Pengenalan Pola (Pattern Recognition)',
      opsi_d: 'Perancangan Algoritma (Algorithm Design)',
      kunci_pg: 'A',
      bobot: 10
    },
    {
      nomor: 3,
      pertanyaan: 'Perangkat keras jaringan yang bertugas menghubungkan dua atau lebih jaringan komputer berbeda serta menentukan rute terbaik pengiriman paket data di internet adalah...',
      opsi_a: 'Switch LAN',
      opsi_b: 'Hub Pasif',
      opsi_c: 'Router',
      opsi_d: 'Repeater Sinyal',
      kunci_pg: 'C',
      bobot: 10
    },
    {
      nomor: 4,
      pertanyaan: 'Struktur logika dalam algoritma pemrograman yang digunakan untuk mengeksekusi sekumpulan instruksi berulang kali selama suatu kondisi terpenuhi adalah...',
      opsi_a: 'Percabangan (Branching / Selection)',
      opsi_b: 'Sekuensial Berurutan (Sequence)',
      opsi_c: 'Deklarasi Variabel',
      opsi_d: 'Perulangan (Looping / Iteration)',
      kunci_pg: 'D',
      bobot: 10
    },
    {
      nomor: 5,
      pertanyaan: 'Manakah kriteria kata sandi (password) yang paling aman dan kuat untuk melindungi akun digital dari ancaman peretasan...',
      opsi_a: 'Menggunakan nama panggilan dan tanggal lahir',
      opsi_b: 'Kombinasi minimal 8-12 karakter huruf besar, huruf kecil, angka, dan simbol khusus',
      opsi_c: 'Kata umum yang mudah ditebak seperti "rahasia12345"',
      opsi_d: 'Hanya deretan 6 digit angka nomor ponsel',
      kunci_pg: 'B',
      bobot: 10
    },
    {
      nomor: 6,
      pertanyaan: 'Struktur data linier yang menerapkan prinsip LIFO (Last In First Out), di mana elemen yang terakhir dimasukkan akan menjadi elemen yang pertama kali dikeluarkan, adalah...',
      opsi_a: 'Stack (Tumpukan)',
      opsi_b: 'Queue (Antrean)',
      opsi_c: 'Array Satu Dimensi',
      opsi_d: 'Tree (Pohon Biner)',
      kunci_pg: 'A',
      bobot: 10
    },
    {
      nomor: 7,
      pertanyaan: 'Etika, sopan santun, dan tata krama dalam berkomunikasi dan berinteraksi secara sehat di media sosial dan internet dikenal dengan istilah...',
      opsi_a: 'Cyberbullying',
      opsi_b: 'Hak Kekayaan Intelektual',
      opsi_c: 'Netiket (Network Etiquette)',
      opsi_d: 'Phishing',
      kunci_pg: 'C',
      bobot: 10
    },
    {
      nomor: 8,
      pertanyaan: 'Bilangan biner 1011 jika dikonversikan ke dalam sistem bilangan desimal berbasis 10 bernilai...',
      opsi_a: '8',
      opsi_b: '9',
      opsi_c: '10',
      opsi_d: '11',
      kunci_pg: 'D',
      bobot: 10
    },
    {
      nomor: 9,
      pertanyaan: 'Format ekstensi berkas dokumen yang secara standar digunakan oleh aplikasi pengolah lembar kerja (spreadsheet) elektronis adalah...',
      opsi_a: '.xlsx / .xls',
      opsi_b: '.docx / .doc',
      opsi_c: '.pptx / .ppt',
      opsi_d: '.mp4 / .avi',
      kunci_pg: 'A',
      bobot: 10
    },
    {
      nomor: 10,
      pertanyaan: 'Dalam lingkungan pemrograman visual Scratch, balok perintah berwarna oranye "When Green Flag Clicked" (Ketika Bendera Hijau Diklik) termasuk ke dalam kategori balok...',
      opsi_a: 'Motion (Gerakan)',
      opsi_b: 'Events (Kejadian / Pemicu)',
      opsi_c: 'Looks (Tampilan Kostum)',
      opsi_d: 'Sensing (Sensor Sentuhan)',
      kunci_pg: 'B',
      bobot: 10
    }
  ];

  for (const q of pg10Questions) {
    examService.createSoal(ulanganPg.id, {
      nomor: q.nomor,
      jenis: 'pilihan_ganda',
      pertanyaan: q.pertanyaan,
      opsi_a: q.opsi_a,
      opsi_b: q.opsi_b,
      opsi_c: q.opsi_c,
      opsi_d: q.opsi_d,
      kunci_pg: q.kunci_pg,
      bobot: q.bobot,
      tingkat_kesulitan: 'sedang'
    });
    console.log(`  ✓ PG Soal ${q.nomor}: Kunci [${q.kunci_pg}] - ${q.pertanyaan.slice(0, 40)}...`);
  }

  // Generate 4 Paket Soal (Paket A, B, C, D)
  console.log('📦 Membuat 4 Paket Soal Teracak (Paket A, B, C, D)...');
  const pkgRes = packageService.generatePackages(ulanganPg.id, { packageCount: 4 });
  console.log(`  ✓ Berhasil generate ${pkgRes.jumlah_paket} paket!`);
  for (const p of pkgRes.packages) {
    const keysStr = Object.entries(p.kunci_jawaban_map).map(([num, k]) => `${num}:${k}`).join(' ');
    console.log(`    - Paket ${p.nama_paket} (10 Soal): Kunci = [${keysStr}]`);
  }

  // Buka ulangan PG agar siap dicetak & discan
  examService.updateStatusUlangan(ulanganPg.id, 'dibuka');
  console.log(`✅ Ulangan PG Multi-Paket Berhasil Dibuat: ID=${ulanganPg.id}, Kode Ujian=${ulanganPg.kode_ujian}`);

  console.log('\n======================================================');
  console.log('🎉 SELURUH ULANGAN DUMMY SIAP DIGUNAKAN!');
  console.log('======================================================');
  console.log(`1. ULANGAN GAME KODING (8 MODE):`);
  console.log(`   - Judul     : ${ulanganKoding.judul}`);
  console.log(`   - ID Ulangan: ${ulanganKoding.id}`);
  console.log(`   - Kode Ujian: ${ulanganKoding.kode_ujian}`);
  console.log(`   - Status    : DIBUKA (Aktif)`);
  console.log(`   - Mode Game : Grid Robot (2 Bintang), Forest Explorer (Maju-Mundur), Loop Master, If-Else, Bug Doctor, Scratch Puzzle, Pattern Guesser, Parsons Problem.`);
  console.log(`\n2. ULANGAN PG MULTI-PAKET (10 SOAL PER PAKET):`);
  console.log(`   - Judul     : ${ulanganPg.judul}`);
  console.log(`   - ID Ulangan: ${ulanganPg.id}`);
  console.log(`   - Kode Ujian: ${ulanganPg.kode_ujian}`);
  console.log(`   - Status    : DIBUKA (Aktif)`);
  console.log(`   - Jumlah Soal: 10 Soal per paket`);
  console.log(`   - Paket     : 4 Paket (A, B, C, D)`);
  console.log(`   - Fitur Siap: Cetak Naskah Paket A-D, Cetak LJK 10 Soal OMR Presisi, Scan Kamera LJK OMR.`);
  console.log('======================================================\n');
}

main().catch(err => {
  console.error('❌ Gagal membuat ulangan dummy:', err);
  process.exit(1);
});
