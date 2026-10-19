const http = require('http');
const app = require('../server');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');

function makeRequest(server, options, bodyData = null) {
  return new Promise((resolve) => {
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
        resolve({
          statusCode: res.statusCode,
          durationMs
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        statusCode: 500,
        error: err.message,
        durationMs: 0
      });
    });

    if (bodyData) {
      req.write(JSON.stringify(bodyData));
    }
    req.end();
  });
}

async function testLoad(server, testCode, concurrency) {
  console.log(`\n⏳ Menguji simulasi ${concurrency} siswa mengakses server secara serentak...`);
  const start = process.hrtime.bigint();
  
  const requests = [];
  for (let i = 0; i < concurrency; i++) {
    // Campuran: 50% cek kode ulangan, 50% ping detak jantung / status
    if (i % 2 === 0) {
      requests.push(makeRequest(server, {
        path: '/api/siswa/cek-kode',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, { kode_ujian: testCode }));
    } else {
      requests.push(makeRequest(server, {
        path: `/api/siswa/sedang-mengerjakan/${testCode}?page=1&limit=10`
      }));
    }
  }

  const results = await Promise.all(requests);
  const end = process.hrtime.bigint();
  const totalMs = Number(end - start) / 1e6;

  const successful = results.filter(r => r.statusCode === 200).length;
  const failed = results.filter(r => r.statusCode !== 200).length;
  const latencies = results.map(r => r.durationMs).sort((a, b) => a - b);
  const avgLatency = (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2);
  const p95Latency = latencies[Math.floor(latencies.length * 0.95)].toFixed(2);
  const rps = ((concurrency / (totalMs / 1000))).toFixed(1);

  const mem = process.memoryUsage();
  const usedHeapMb = Math.round(mem.heapUsed / 1024 / 1024);

  console.log(`   ✓ Hasil: ${successful}/${concurrency} berhasil (${failed} gagal)`);
  console.log(`   ✓ Waktu Eksekusi Total : ${totalMs.toFixed(2)} ms`);
  console.log(`   ✓ Kecepatan Rata-rata  : ${avgLatency} ms per siswa`);
  console.log(`   ✓ Latensi P95          : ${p95Latency} ms`);
  console.log(`   ✓ Throughput           : ${rps} request/detik`);
  console.log(`   ✓ Penggunaan RAM Node  : ${usedHeapMb} MB`);

  return {
    concurrency,
    successful,
    failed,
    avgLatency,
    rps,
    usedHeapMb,
    sanggup: failed === 0 && parseFloat(avgLatency) < 250
  };
}

async function runStressTest() {
  console.log('='.repeat(70));
  console.log('🧪 PENGUJIAN STRESS-TEST KESANGGUPAN BEBAN SERVER (100, 200, 300 SISWA)');
  console.log('='.repeat(70));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const guru = db.prepare('SELECT id FROM guru LIMIT 1').get() || { id: 1 };
    const testCode = `STRESS_${Date.now().toString(36).toUpperCase()}`;
    const ulangan = examService.createUlangan(guru.id, {
      judul: 'Ulangan Uji Stres Server',
      mata_pelajaran: 'Informatika',
      tingkat_kelas: '8A',
      durasi_menit: 60,
      kkm: 75
    });
    db.prepare("UPDATE ulangan SET kode_ujian = ?, status = 'dibuka' WHERE id = ?").run(testCode, ulangan.id);

    // Jalankan bertahap: 50 siswa, 100 siswa, 200 siswa, 300 siswa serentak
    const r50 = await testLoad(server, testCode, 50);
    const r100 = await testLoad(server, testCode, 100);
    const r200 = await testLoad(server, testCode, 200);
    const r300 = await testLoad(server, testCode, 300);

    console.log('\n' + '='.repeat(70));
    console.log('📋 KESIMPULAN KESANGGUPAN SERVER:');
    console.log('='.repeat(70));
    [r50, r100, r200, r300].forEach(r => {
      const statusIcon = r.sanggup ? '✅ SANGAT SANGGUP' : '⚠️ BUTUH PENYESUAIAN';
      console.log(`  Beban ${r.concurrency.toString().padEnd(3)} Siswa Serentak : ${statusIcon} (Respon: ${r.avgLatency}ms, Sukses: ${r.successful}/${r.concurrency}, RAM: ${r.usedHeapMb}MB)`);
    });
    console.log('='.repeat(70));

  } finally {
    server.close();
  }
}

runStressTest().catch(err => {
  console.error('Stress Test Error:', err);
  process.exit(1);
});
