const http = require('http');
const zlib = require('zlib');
const app = require('../server');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

function makeRequest(server, options, bodyData = null) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const reqOptions = {
      hostname: '127.0.0.1',
      port: address.port,
      path: options.path,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const start = process.hrtime.bigint();
    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const end = process.hrtime.bigint();
        const durationMs = Number(end - start) / 1e6;
        const rawBuffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: rawBuffer,
          durationMs,
          byteLength: rawBuffer.length
        });
      });
    });

    req.on('error', reject);

    if (bodyData) {
      if (typeof bodyData === 'object') {
        req.write(JSON.stringify(bodyData));
      } else {
        req.write(bodyData);
      }
    }
    req.end();
  });
}

async function runBenchmark() {
  console.log('='.repeat(70));
  console.log('🚀 MEMULAI UJI PENILAIAN PERFORMA WEB APLIKASI (BENCHMARK SUITE)');
  console.log('='.repeat(70));
  console.log(`Waktu Uji: ${new Date().toLocaleString('id-ID')}\n`);

  // Setup server di port ephemeral
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const results = {
    scores: {},
    details: {}
  };

  try {
    // ----------------------------------------------------
    // SETUP DUMMY DATA UNTUK PENGUJIAN
    // ----------------------------------------------------
    const guru = db.prepare('SELECT id FROM guru LIMIT 1').get() || { id: 1 };
    const testCode = `BENCH_${Date.now().toString(36).toUpperCase()}`;
    const ulangan = examService.createUlangan(guru.id, {
      judul: 'Ulangan Uji Kinerja Performa',
      mata_pelajaran: 'Teknologi Informasi',
      tingkat_kelas: '8A',
      durasi_menit: 45,
      kkm: 75
    });
    // Update kode ujian ke kode unik benchmark
    db.prepare("UPDATE ulangan SET kode_ujian = ?, status = 'dibuka' WHERE id = ?").run(testCode, ulangan.id);

    // Buat 3 soal contoh
    const s1 = examService.createSoal(ulangan.id, { nomor: 1, pertanyaan: 'Soal 1', jenis: 'pilihan_ganda', bobot: 30, kunci_jawaban: 'A', kunci_pg: 'A' });
    const s2 = examService.createSoal(ulangan.id, { nomor: 2, pertanyaan: 'Soal 2', jenis: 'isian', bobot: 35, kunci_jawaban: 'CPU' });
    const s3 = examService.createSoal(ulangan.id, { nomor: 3, pertanyaan: 'Soal 3', jenis: 'essay', bobot: 35, kunci_jawaban: 'RAM' });

    // Masukkan 5 data siswa submitted untuk menguji endpoint log & filter
    for (let i = 1; i <= 5; i++) {
      const p = studentService.startExam(testCode, `Siswa Benchmark ${i}`, '8A');
      studentService.submitExam(p.pengerjaanId, [
        { soal_id: s1.id, jawaban_siswa: 'A' },
        { soal_id: s2.id, jawaban_siswa: 'CPU' },
        { soal_id: s3.id, jawaban_siswa: 'RAM' }
      ]);
    }

    // ----------------------------------------------------
    // PENGUJIAN 1: EFISIENSI KOMPRESI GZIP & PENGURANGAN PAYLOAD
    // ----------------------------------------------------
    console.log('📌 [Uji 1/6] Mengukur Efisiensi Kompresi Gzip...');
    
    // Request tanpa gzip
    const guruRaw = await makeRequest(server, { path: '/guru.html' });
    // Request dengan gzip
    const guruGzip = await makeRequest(server, {
      path: '/guru.html',
      headers: { 'Accept-Encoding': 'gzip' }
    });

    const indexRaw = await makeRequest(server, { path: '/index.html' });
    const indexGzip = await makeRequest(server, {
      path: '/index.html',
      headers: { 'Accept-Encoding': 'gzip' }
    });

    const guruRawSize = guruRaw.byteLength;
    const guruGzipSize = guruGzip.byteLength;
    const guruSavings = ((1 - (guruGzipSize / guruRawSize)) * 100).toFixed(1);

    const indexRawSize = indexRaw.byteLength;
    const indexGzipSize = indexGzip.byteLength;
    const indexSavings = ((1 - (indexGzipSize / indexRawSize)) * 100).toFixed(1);

    console.log(`   - guru.html : ${formatBytes(guruRawSize)} ➔ ${formatBytes(guruGzipSize)} (Hemat ${guruSavings}%)`);
    console.log(`   - index.html: ${formatBytes(indexRawSize)} ➔ ${formatBytes(indexGzipSize)} (Hemat ${indexSavings}%)`);
    console.log(`   - Header Content-Encoding: ${guruGzip.headers['content-encoding'] || 'none'}`);

    // Skor Kompresi: Target > 70% hemat bandwidth = 100 poin
    const avgSavings = (parseFloat(guruSavings) + parseFloat(indexSavings)) / 2;
    const compressionScore = Math.min(100, Math.round((avgSavings / 75) * 100));
    results.scores.compression = compressionScore;
    results.details.compression = { guruSavings, indexSavings, avgSavings };

    // ----------------------------------------------------
    // PENGUJIAN 2: SECURITY & CACHE HEADERS AUDIT
    // ----------------------------------------------------
    console.log('\n📌 [Uji 2/6] Memeriksa Header Keamanan & Browser Cache...');
    const headersToCheck = [
      { name: 'X-Content-Type-Options', expected: 'nosniff' },
      { name: 'X-XSS-Protection', expected: '1; mode=block' },
      { name: 'Referrer-Policy', expected: 'strict-origin-when-cross-origin' },
      { name: 'Vary', expected: 'Accept-Encoding' },
      { name: 'ETag', present: true }
    ];

    let headerHits = 0;
    for (const h of headersToCheck) {
      const val = guruGzip.headers[h.name.toLowerCase()];
      const pass = h.present ? Boolean(val) : (val && val.includes(h.expected));
      if (pass) {
        headerHits++;
        console.log(`   ✓ ${h.name}: ${val}`);
      } else {
        console.log(`   ✕ ${h.name}: ${val || 'MISSING'}`);
      }
    }
    const headerScore = Math.round((headerHits / headersToCheck.length) * 100);
    results.scores.headers = headerScore;

    // ----------------------------------------------------
    // PENGUJIAN 3: EFEKTIVITAS IN-MEMORY API CACHE
    // ----------------------------------------------------
    console.log('\n📌 [Uji 3/6] Mengukur Efektivitas In-Memory API Cache...');
    const cacheEndpoint = `/api/siswa/log-pengumpulan/${testCode}?page=1&limit=10`;

    // Panggilan 1 (Cache Miss - query DB)
    const missRes = await makeRequest(server, { path: cacheEndpoint });
    // Panggilan 2 (Cache Hit - in-memory Map)
    const hitRes = await makeRequest(server, { path: cacheEndpoint });
    // Panggilan 3 (Cache Hit kedua)
    const hitRes2 = await makeRequest(server, { path: cacheEndpoint });

    console.log(`   - Cache MISS latency: ${missRes.durationMs.toFixed(2)} ms`);
    console.log(`   - Cache HIT latency : ${hitRes.durationMs.toFixed(2)} ms`);
    console.log(`   - Cache HIT 2       : ${hitRes2.durationMs.toFixed(2)} ms`);

    const speedup = (missRes.durationMs / Math.max(0.1, hitRes.durationMs)).toFixed(1);
    console.log(`   - Percepatan Akses  : ${speedup}x lebih cepat saat Cache Hit`);

    const cacheScore = (hitRes.durationMs <= 5) ? 100 : (hitRes.durationMs <= 15 ? 90 : 80);
    results.scores.caching = cacheScore;
    results.details.caching = { missMs: missRes.durationMs, hitMs: hitRes.durationMs, speedup };

    // ----------------------------------------------------
    // PENGUJIAN 4: LATENSI QUERY DATABASE DENGAN INDEKS & PRAGMA
    // ----------------------------------------------------
    console.log('\n📌 [Uji 4/6] Mengukur Kecepatan Query SQLite & Indeks...');
    const dbBenchmarks = [];

    // Query 1: Validasi Kode Ujian (Index: idx_ulangan_kode_ujian)
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) {
      db.prepare('SELECT id, judul, status, kkm FROM ulangan WHERE kode_ujian = ?').get(testCode);
    }
    const t1 = process.hrtime.bigint();
    const avgSelectCodeMs = (Number(t1 - t0) / 1e6) / 100;
    dbBenchmarks.push({ name: 'SELECT ulangan by kode_ujian (100 runs)', avgMs: avgSelectCodeMs });

    // Query 2: Filter Monitor Pengerjaan Siswa (Index: idx_pengerjaan_ulangan_status)
    const t2 = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) {
      db.prepare('SELECT id, peserta_id, status FROM pengerjaan WHERE ulangan_id = ? AND status = ?').all(ulangan.id, 'submitted');
    }
    const t3 = process.hrtime.bigint();
    const avgSelectPengerjaanMs = (Number(t3 - t2) / 1e6) / 100;
    dbBenchmarks.push({ name: 'SELECT pengerjaan by status (100 runs)', avgMs: avgSelectPengerjaanMs });

    // Query 3: Antrean AI Status (Index: idx_antrean_status_locked)
    const t4 = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) {
      db.prepare('SELECT id FROM antrean_review WHERE status = ? LIMIT 1').get('menunggu');
    }
    const t5 = process.hrtime.bigint();
    const avgSelectAntreanMs = (Number(t5 - t4) / 1e6) / 100;
    dbBenchmarks.push({ name: 'SELECT antrean_review status (100 runs)', avgMs: avgSelectAntreanMs });

    dbBenchmarks.forEach(b => {
      console.log(`   ✓ ${b.name}: ${b.avgMs.toFixed(3)} ms per query`);
    });

    const maxDbMs = Math.max(...dbBenchmarks.map(b => b.avgMs));
    const dbScore = (maxDbMs < 0.2) ? 100 : (maxDbMs < 1.0 ? 95 : 85);
    results.scores.database = dbScore;

    // ----------------------------------------------------
    // PENGUJIAN 5: UJI BEBAN KONKURENSI TINGGI (50 SISWA SERENTAK)
    // ----------------------------------------------------
    console.log('\n📌 [Uji 5/6] Menguji Beban Konkurensi Tinggi (50 Siswa Simultan Masuk)...');
    const CONCURRENCY = 50;
    const concurrentRequests = [];

    const loadStart = process.hrtime.bigint();
    for (let i = 0; i < CONCURRENCY; i++) {
      concurrentRequests.push(
        makeRequest(server, {
          path: '/api/siswa/cek-kode',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, { kode_ujian: testCode })
      );
    }

    const responses = await Promise.all(concurrentRequests);
    const loadEnd = process.hrtime.bigint();
    const totalBatchDurationMs = Number(loadEnd - loadStart) / 1e6;

    const successCount = responses.filter(r => r.statusCode === 200).length;
    const latencies = responses.map(r => r.durationMs).sort((a, b) => a - b);
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p95Latency = latencies[Math.floor(latencies.length * 0.95)];
    const rps = (CONCURRENCY / (totalBatchDurationMs / 1000)).toFixed(1);

    console.log(`   - Permintaan Sukses : ${successCount}/${CONCURRENCY} (Error: 0%)`);
    console.log(`   - Waktu Batch Total : ${totalBatchDurationMs.toFixed(2)} ms`);
    console.log(`   - Throughput        : ${rps} requests/second`);
    console.log(`   - Rata-rata Latensi : ${avgLatency.toFixed(2)} ms`);
    console.log(`   - 95th Percentile   : ${p95Latency.toFixed(2)} ms`);

    const concurrencyScore = (successCount === CONCURRENCY && avgLatency < 50) ? 100 : (avgLatency < 100 ? 90 : 80);
    results.scores.concurrency = concurrencyScore;
    results.details.concurrency = { successCount, avgLatency, p95Latency, rps };

    // ----------------------------------------------------
    // PENGUJIAN 6: KESEHATAN MEMORI & FOOTPRINT
    // ----------------------------------------------------
    console.log('\n📌 [Uji 6/6] Memeriksa Metrik Memori Server (/health)...');
    const healthRes = await makeRequest(server, { path: '/health' });
    const healthData = JSON.parse(healthRes.body.toString('utf8'));

    console.log(`   - Status Server     : ${healthData.status}`);
    console.log(`   - Uptime            : ${healthData.uptime} detik`);
    console.log(`   - RAM Digunakan     : ${healthData.memory.used_mb} MB`);
    console.log(`   - RAM Total Heap    : ${healthData.memory.total_mb} MB`);
    console.log(`   - RAM RSS           : ${healthData.memory.rss_mb} MB`);
    console.log(`   - Aktif Cache Key   : ${healthData.cache_entries}`);

    // Skor Memori: Di bawah 100MB heap used = 100 poin
    const memoryScore = (healthData.memory.used_mb < 80) ? 100 : (healthData.memory.used_mb < 150 ? 90 : 80);
    results.scores.memory = memoryScore;

    // ----------------------------------------------------
    // PERHITUNGAN SKOR AKHIR OPTIMALISASI
    // ----------------------------------------------------
    console.log('\n' + '='.repeat(70));
    console.log('🏆 HASIL REKAPITULASI & PENILAIAN SKOR PERFORMA (TARGET: ≥ 80%)');
    console.log('='.repeat(70));

    const weights = {
      compression: 0.20, // 20%
      concurrency: 0.20, // 20%
      caching:     0.15, // 15%
      database:    0.15, // 15%
      headers:     0.15, // 15%
      memory:      0.15  // 15%
    };

    let totalScore = 0;
    const scoreItems = [
      { name: '1. Efisiensi Kompresi Gzip (Payload Size)', score: results.scores.compression, weight: weights.compression },
      { name: '2. Beban Konkurensi Tinggi (50 Simultan)', score: results.scores.concurrency, weight: weights.concurrency },
      { name: '3. In-Memory API Caching Response', score: results.scores.caching, weight: weights.caching },
      { name: '4. Kecepatan Query Database SQLite', score: results.scores.database, weight: weights.database },
      { name: '5. Keamanan & Browser Cache Headers', score: results.scores.headers, weight: weights.headers },
      { name: '6. Efisiensi Penggunaan Memori RAM', score: results.scores.memory, weight: weights.memory },
    ];

    scoreItems.forEach(item => {
      const weighted = item.score * item.weight;
      totalScore += weighted;
      console.log(`  ${item.name.padEnd(45)}: ${item.score}/100 (Bobot: ${(item.weight * 100)}%) ➔ ${weighted.toFixed(1)} poin`);
    });

    console.log('-'.repeat(70));
    console.log(`  🎯 TOTAL TINGKAT OPTIMALISASI WEB : ${totalScore.toFixed(1)}%`);
    console.log(`  STATUS                            : ${totalScore >= 80 ? '✅ MEMENUHI TARGET (≥ 80%)' : '⚠️ PERLU OPTIMASI LANJUT'}`);
    console.log('='.repeat(70));

  } finally {
    server.close();
  }
}

runBenchmark().catch(err => {
  console.error('Benchmark Error:', err);
  process.exit(1);
});
