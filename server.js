const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const db = require('./src/config/database');
const authService = require('./src/services/authService');
const examService = require('./src/services/examService');
const studentService = require('./src/services/studentService');
const queueService = require('./src/services/queueService');
const geminiService = require('./src/services/geminiService');
const reviewService = require('./src/services/reviewService');
const classService = require('./src/services/classService');
const adminService = require('./src/services/adminService');
const fileParserService = require('./src/services/fileParserService');
const waitingRoomService = require('./src/services/waitingRoomService');
const bankSoalService = require('./src/services/bankSoalService');

const app = express();
const PORT = process.env.PORT || 3000;

// Body & Cookie Parsers (Dukungan file payload hingga 30MB)
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ limit: '30mb', extended: true }));
app.use(cookieParser());

// Header Iframe-friendly untuk Google Sites (Embed)
app.use((req, res, next) => {
  // Izinkan penyematan iframe dari Google Sites dan domain Google
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://sites.google.com https://*.google.com https://*.googleusercontent.com;"
  );
  // Pastikan tidak ada X-Frame-Options DENY atau SAMEORIGIN yang memblokir Google Sites
  res.removeHeader('X-Frame-Options');
  next();
});

// Static Files
app.use(express.static(path.join(__dirname, 'public')));

// Header Anti-Cache untuk seluruh endpoint /api agar respons browser selalu segar (mencegah bug revert rilis nilai)
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Endpoint Health Check untuk monitoring platform hosting (Render/Vercel/Uptime)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Jadwalkan sinkronisasi latar belakang Turso secara debounced setelah request write selesai (tidak memblokir request klien)
app.use((req, res, next) => {
  if (req.path && req.path.startsWith('/api/') && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 400 && typeof db.syncCloud === 'function') {
        db.syncCloud();
      }
    });
  }
  next();
});

// ----------------------------------------------------
// ROUTE: Autentikasi Guru (FR-01)
// ----------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { email, password, remember_me } = req.body;
  const isRemember = remember_me === true || remember_me === 'true' || remember_me === 1 || remember_me === '1';
  const result = authService.login(email, password, isRemember);

  if (!result.success) {
    return res.status(401).json(result);
  }

  const isSecure = Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https');
  const maxAge = isRemember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

  // Simpan token di HTTP-Only Cookie
  res.cookie('auth_token', result.token, {
    httpOnly: true,
    maxAge,
    sameSite: isSecure ? 'none' : 'lax',
    secure: isSecure
  });

  res.json(result);
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.auth_token || req.headers['authorization']?.replace('Bearer ', '');
  authService.logout(token);
  res.clearCookie('auth_token');
  res.json({ success: true, message: 'Logout berhasil' });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.auth_token || req.headers['authorization']?.replace('Bearer ', '');
  const session = authService.verifyToken(token);
  if (!session) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({ authenticated: true, guru: session });
});

// Kalibrasi & Sinkronisasi Waktu Server
app.get('/api/waktu-server', (req, res) => {
  const now = new Date();
  const zw = (req.query.zona_waktu && ['WIB', 'WITA', 'WIT'].includes(String(req.query.zona_waktu).toUpperCase()))
    ? String(req.query.zona_waktu).toUpperCase()
    : 'WITA';
  res.json({
    success: true,
    server_time: now.toISOString(),
    server_timestamp: now.getTime(),
    zona_waktu: zw,
    waktu_terkalibrasi: examService.formatIndonesianDateTime(now.toISOString(), zw)
  });
});

// ----------------------------------------------------
// ROUTE: Modul Siswa (FR-06 - FR-08, FR-22, NFR-01)
// ----------------------------------------------------
app.post('/api/siswa/cek-kode', (req, res) => {
  try {
    const { kode_ujian } = req.body;
    const result = studentService.validateExamCode(kode_ujian);
    if (!result.valid) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ valid: false, message: err.message });
  }
});

// Log Tanda Terima Pengumpulan Jawaban Siswa (Publik / Bukti Diterima, Tanpa Menampilkan Nilai)
app.get('/api/siswa/log-pengumpulan/:kode', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const result = studentService.getSubmissionLogByExamCode(req.params.kode, page, limit);
    if (!result.success) {
      return res.status(404).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Monitor Siswa Sedang Mengerjakan & Terputus (DC) dengan Countdown Toleransi (Nama Ter-Sensor)
app.get('/api/siswa/sedang-mengerjakan/:kode', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const result = studentService.getActiveStudentsByExamCode(req.params.kode, page, limit);
    if (!result.success) {
      return res.status(404).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/siswa/mulai', (req, res) => {
  try {
    const { kode_ujian, nama, kelas } = req.body;

    // Periksa batas kuota bersamaan (maks 20 siswa) & sistem antrean ruang tunggu
    const check = waitingRoomService.checkEntry(kode_ujian, nama, kelas);
    if (!check.allowed && check.inQueue) {
      return res.json({
        success: true,
        inQueue: true,
        ticketId: check.ticketId,
        position: check.position,
        totalWaiting: check.totalWaiting,
        activeCount: check.activeCount,
        maxLimit: check.maxLimit,
        message: check.message
      });
    }

    const result = studentService.startExam(kode_ujian, nama, kelas);
    res.json({ success: true, inQueue: false, ...result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Polling status antrean ruang tunggu siswa
app.get('/api/siswa/antrean/:ticketId', (req, res) => {
  try {
    const status = waitingRoomService.getTicketStatus(req.params.ticketId);
    if (!status.valid) {
      return res.status(404).json({ success: false, message: status.message });
    }

    if (status.status === 'ready') {
      const { ticket } = status;
      // Giliran tiba: mulai ujian dan konsumsi tiket
      const examData = studentService.startExam(ticket.kodeUjian, ticket.nama, ticket.kelas);
      waitingRoomService.consumeTicket(req.params.ticketId);
      return res.json({
        success: true,
        status: 'ready',
        ...examData
      });
    }

    res.json({
      success: true,
      status: 'waiting',
      position: status.position,
      totalWaiting: status.totalWaiting,
      activeCount: status.activeCount,
      maxLimit: status.maxLimit
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/siswa/submit', async (req, res) => {
  try {
    const { pengerjaan_id, jawaban, paste_count, is_auto_submit, paste_details } = req.body;
    if (!pengerjaan_id) {
      return res.status(400).json({ success: false, message: 'pengerjaan_id wajib disertakan' });
    }

    // Ambil ulangan_id untuk melepaskan slot antrean
    const pengerjaanBefore = db.prepare('SELECT ulangan_id FROM pengerjaan WHERE id = ?').get(pengerjaan_id);

    // Eksekusi submit melalui antrean penulisan aman dengan fallback eksekusi langsung
    let result;
    try {
      result = await waitingRoomService.queueSubmit(async () => {
        return studentService.submitExam(pengerjaan_id, jawaban, paste_count, Boolean(is_auto_submit), paste_details);
      });
    } catch (queueErr) {
      console.warn('⚠️ Antrean submit padat/timeout, memproses submit langsung:', queueErr.message);
      result = studentService.submitExam(pengerjaan_id, jawaban, paste_count, Boolean(is_auto_submit), paste_details);
    }

    // Lepaskan 1 slot untuk antrean ruang tunggu
    if (pengerjaanBefore?.ulangan_id) {
      waitingRoomService.releaseSlot(pengerjaanBefore.ulangan_id);
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post('/api/siswa/draft', (req, res) => {
  try {
    const { pengerjaan_id, jawaban, paste_count, paste_details } = req.body;
    const result = studentService.saveDraft(pengerjaan_id, jawaban, paste_count, paste_details);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Heartbeat & presence pengerjaan siswa (mendeteksi aktif vs terputus/dc)
app.post('/api/siswa/ping', (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }
    const pengerjaan_id = body?.pengerjaan_id;
    const status = body?.status || 'active';
    const result = studentService.recordPing(pengerjaan_id, status);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.get('/api/siswa/sesi/:pengerjaan_id', (req, res) => {
  try {
    const session = studentService.getActiveSession(req.params.pengerjaan_id);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Data sesi pengerjaan tidak ditemukan' });
    }
    res.json({ success: true, data: session });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/siswa/hasil/:pengerjaan_id', (req, res) => {
  try {
    const status = studentService.getPengerjaanStatus(req.params.pengerjaan_id);
    if (!status) {
      return res.status(404).json({ success: false, message: 'Data pengerjaan tidak ditemukan' });
    }
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/siswa/riwayat/:pengerjaan_id', (req, res) => {
  try {
    const list = studentService.getStudentExamHistory(req.params.pengerjaan_id);
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------------------------
// ROUTE: Modul Guru (FR-02 - FR-05, FR-09 - FR-23)
// ----------------------------------------------------
const requireGuru = authService.authMiddleware;

// Ulangan
app.get('/api/guru/ulangan', requireGuru, (req, res) => {
  try {
    const list = examService.getUlanganByGuru(req.guru.guruId);
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/guru/ulangan', requireGuru, (req, res) => {
  try {
    const created = examService.createUlangan(req.guru.guruId, req.body);
    res.json({ success: true, data: created });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.get('/api/guru/ulangan/:id', requireGuru, (req, res) => {
  try {
    const ulangan = examService.getUlanganById(req.params.id, req.guru.guruId);
    if (!ulangan) return res.status(404).json({ success: false, message: 'Ulangan tidak ditemukan' });
    res.json({ success: true, data: ulangan });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/guru/ulangan/:id', requireGuru, (req, res) => {
  try {
    const updated = examService.updateUlangan(req.params.id, req.guru.guruId, req.body);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.delete('/api/guru/ulangan/:id', requireGuru, (req, res) => {
  try {
    examService.deleteUlangan(req.params.id, req.guru.guruId);
    res.json({ success: true, message: 'Ulangan berhasil dihapus' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Generator Sebaran WhatsApp Resmi & To-The-Point (AI & Template Default)
app.post('/api/guru/ulangan/:id/generate-broadcast', requireGuru, async (req, res) => {
  try {
    const ulangan = examService.getUlanganById(req.params.id, req.guru.guruId);
    if (!ulangan) {
      return res.status(404).json({ success: false, message: 'Ulangan tidak ditemukan' });
    }
    const host = req.get('host') || 'localhost:3000';
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    const baseUrl = `${proto}://${host}`;
    const { use_ai } = req.body || {};

    let text;
    if (use_ai) {
      text = await geminiService.generateWhatsAppBroadcast(ulangan, baseUrl);
    } else {
      text = geminiService.formatDefaultWhatsAppBroadcast(ulangan, baseUrl);
    }

    res.json({ success: true, text });
  } catch (err) {
    console.error('Error generate broadcast:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Laporan Nilai per Kelas & Ulangan (Cetak / PDF)
app.get('/api/guru/ulangan/:id/laporan', requireGuru, (req, res) => {
  try {
    const laporan = reviewService.getLaporanNilai(req.params.id, req.guru.guruId, req.query.kelas);
    res.json({ success: true, data: laporan });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Soal
app.post('/api/guru/ulangan/:id/soal', requireGuru, (req, res) => {
  try {
    const soal = examService.createSoal(req.params.id, req.body);
    res.json({ success: true, data: soal });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.put('/api/guru/soal/:id', requireGuru, (req, res) => {
  try {
    const soal = examService.updateSoal(req.params.id, req.body);
    res.json({ success: true, data: soal });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.delete('/api/guru/soal/:id', requireGuru, (req, res) => {
  try {
    examService.deleteSoal(req.params.id);
    res.json({ success: true, message: 'Soal berhasil dihapus' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// AI Soal Generator (Dilengkapi Anti-Duplikasi dari Ulangan & Bank Soal)
app.post('/api/guru/generate-soal', requireGuru, async (req, res) => {
  try {
    const {
      mode,
      input_sumber,
      jenjang_kelas,
      jumlah_soal,
      tipe_soal,
      bentuk_soal,
      tingkat_kesulitan,
      target_total_bobot,
      jumlah_isian,
      jumlah_essay,
      is_listening,
      jumlah_listening,
      jumlah_isian_listening,
      jumlah_essay_listening,
      bahasa,
      deskripsi_audio,
      target_context,
      ulangan_id,
      kategori,
      existing_questions
    } = req.body;

    if (!input_sumber || input_sumber.trim() === '') {
      return res.status(400).json({ success: false, message: 'Topik atau teks materi wajib diisi' });
    }

    // Tentukan kategori / bab / buku pokok untuk pencocokan yang akurat & hemat token
    const rawCat = (kategori && typeof kategori === 'string' && kategori.trim()) 
      ? kategori.trim() 
      : (mode === 'topik' ? input_sumber.trim().split('\n')[0].substring(0, 35) : '');

    // Kumpulkan butir pertanyaan terdahulu HANYA dari kategori / bab / buku yang sama
    const collectedExistingQuestions = [];
    if (Array.isArray(existing_questions)) {
      collectedExistingQuestions.push(...existing_questions);
    }

    // 1. Jika dalam konteks ulangan aktif, ambil butir soal terdahulu pada ulangan ini
    if (ulangan_id) {
      try {
        let rowsUlangan = [];
        if (rawCat) {
          rowsUlangan = db.prepare(`
            SELECT pertanyaan FROM soal 
            WHERE ulangan_id = ? 
              AND (kategori LIKE ? OR LOWER(?) LIKE '%' || LOWER(COALESCE(kategori, '')) || '%')
            ORDER BY id DESC LIMIT 12
          `).all(ulangan_id, `%${rawCat}%`, rawCat);
        }
        if (rowsUlangan.length === 0) {
          rowsUlangan = db.prepare('SELECT pertanyaan FROM soal WHERE ulangan_id = ? ORDER BY id DESC LIMIT 12').all(ulangan_id);
        }
        if (rowsUlangan && rowsUlangan.length > 0) {
          collectedExistingQuestions.push(...rowsUlangan.map(r => r.pertanyaan));
        }
      } catch (errU) {
        console.warn('Gagal membaca soal ulangan untuk anti-duplikasi:', errU.message);
      }
    }

    // 2. Jika dalam konteks bank_soal, HANYA ambil soal dari kategori yang sama persis / relevan
    const guruId = req.guru?.guruId;
    if (guruId && (target_context === 'bank_soal' || !ulangan_id)) {
      try {
        if (rawCat) {
          const bankMatches = db.prepare(`
            SELECT pertanyaan FROM bank_soal 
            WHERE guru_id = ? 
              AND (LOWER(kategori) = LOWER(?) OR LOWER(kategori) LIKE ? OR LOWER(sub_topik) LIKE ?)
            ORDER BY id DESC LIMIT 12
          `).all(guruId, rawCat, `%${rawCat}%`, `%${rawCat}%`);
          if (bankMatches && bankMatches.length > 0) {
            collectedExistingQuestions.push(...bankMatches.map(r => r.pertanyaan));
          }
        }
        // HEMAT TOKEN: Jangan ambil soal acak/topik lain jika belum ada kategori yang cocok!
      } catch (errB) {
        console.warn('Gagal membaca soal bank_soal untuk anti-duplikasi:', errB.message);
      }
    }

    // Bersihkan & format ringkas butir soal terdahulu (mendukung konteks soal cerita hingga 220 karakter)
    const uniqueExistingQuestions = Array.from(new Set(
      collectedExistingQuestions
        .map(q => String(q || '').trim())
        .filter(Boolean)
        .map(q => {
          if (q.length <= 220) return q;
          // Untuk soal cerita panjang, pertahankan konteks narasi awal dan kalimat tanya penutupnya
          return q.substring(0, 140).trim() + ' ... [Tanya]: ' + q.substring(q.length - 70).trim();
        })
    )).slice(0, 12);

    const result = await geminiService.generateQuestions({
      mode,
      input_sumber,
      jenjang_kelas,
      jumlah_soal,
      tipe_soal,
      bentuk_soal,
      tingkat_kesulitan,
      target_total_bobot,
      jumlah_isian,
      jumlah_essay,
      is_listening,
      jumlah_listening,
      jumlah_isian_listening,
      jumlah_essay_listening,
      bahasa: is_listening ? (bahasa || 'Bahasa Inggris') : 'Bahasa Indonesia',
      deskripsi_audio,
      kategori: rawCat,
      existing_questions: uniqueExistingQuestions
    });

    res.json(result);
  } catch (err) {
    console.error('Error generate soal AI:', err);
    res.status(err.status === 429 ? 429 : 500).json({ success: false, message: err.message });
  }
});

// ==================== ENDPOINT BANK SOAL GURU ====================
// Ambil semua soal dari Bank Soal milik guru (dengan filter kategori/kesulitan/listening/search)
app.get('/api/guru/bank-soal', requireGuru, (req, res) => {
  try {
    const items = bankSoalService.getAll(req.guru.guruId, req.query);
    res.json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Ambil daftar kategori unik dari Bank Soal
app.get('/api/guru/bank-soal/categories', requireGuru, (req, res) => {
  try {
    const categories = bankSoalService.getCategories(req.guru.guruId);
    res.json({ success: true, data: categories });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Ambil detail 1 butir Bank Soal
app.get('/api/guru/bank-soal/:id', requireGuru, (req, res) => {
  try {
    const item = bankSoalService.getById(req.params.id, req.guru.guruId);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Soal bank tidak ditemukan' });
    }
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Tambah soal baru ke Bank Soal
app.post('/api/guru/bank-soal', requireGuru, (req, res) => {
  try {
    const created = bankSoalService.create(req.guru.guruId, req.body);
    res.status(201).json({ success: true, data: created, message: 'Soal berhasil ditambahkan ke Bank Soal' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Tambah banyak butir soal sekaligus ke Bank Soal (misal dari AI Generator)
app.post('/api/guru/bank-soal/bulk', requireGuru, (req, res) => {
  try {
    const { soal } = req.body;
    if (!Array.isArray(soal) || soal.length === 0) {
      return res.status(400).json({ success: false, message: 'Daftar butir soal wajib disertakan' });
    }
    const created = bankSoalService.createBatch(req.guru.guruId, soal);
    res.status(201).json({ success: true, data: created, message: `${created.length} butir soal berhasil disimpan ke Bank Soal` });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Perbarui soal di Bank Soal
app.put('/api/guru/bank-soal/:id', requireGuru, (req, res) => {
  try {
    const updated = bankSoalService.update(req.params.id, req.guru.guruId, req.body);
    res.json({ success: true, data: updated, message: 'Soal di Bank Soal berhasil diperbarui' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Hapus soal dari Bank Soal
app.delete('/api/guru/bank-soal/:id', requireGuru, (req, res) => {
  try {
    bankSoalService.delete(req.params.id, req.guru.guruId);
    res.json({ success: true, message: 'Soal berhasil dihapus dari Bank Soal' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Salin soal dari paket ulangan aktif ke Bank Soal
app.post('/api/guru/bank-soal/copy-from-exam/:soalId', requireGuru, (req, res) => {
  try {
    const copied = bankSoalService.copyFromExamSoal(req.params.soalId, req.guru.guruId, req.body.kategori);
    res.json({ success: true, data: copied, message: 'Soal berhasil disimpan ke Bank Soal' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Salin banyak butir soal sekaligus dari ulangan aktif ke Bank Soal
app.post('/api/guru/bank-soal/copy-batch-from-exam', requireGuru, (req, res) => {
  try {
    const { ulangan_id, soal_ids, kategori } = req.body;
    if (!ulangan_id || !Array.isArray(soal_ids) || soal_ids.length === 0) {
      return res.status(400).json({ success: false, message: 'ID ulangan dan daftar ID soal wajib disertakan' });
    }
    const copiedList = bankSoalService.copyBatchFromExam(ulangan_id, soal_ids, req.guru.guruId, kategori);
    res.json({ success: true, data: copiedList, message: `${copiedList.length} butir soal berhasil disimpan ke Bank Soal` });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Impor sekumpulan soal dari Bank Soal ke Ulangan aktif
app.post('/api/guru/bank-soal/import-to-exam', requireGuru, (req, res) => {
  try {
    const { ulangan_id, bank_soal_ids } = req.body;
    if (!ulangan_id || !Array.isArray(bank_soal_ids) || bank_soal_ids.length === 0) {
      return res.status(400).json({ success: false, message: 'ID ulangan dan daftar ID bank soal wajib disertakan' });
    }
    const imported = bankSoalService.importToExam(ulangan_id, req.guru.guruId, bank_soal_ids);
    res.json({ success: true, data: imported, message: `${imported.length} soal berhasil diimpor ke paket ulangan` });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// AI Cerdas Pemilih Soal dari Bank Soal
app.post('/api/guru/bank-soal/ai-pick', requireGuru, (req, res) => {
  try {
    const { ulangan_id } = req.body;
    const result = bankSoalService.aiSmartPick(req.guru.guruId, ulangan_id, req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Upload & Parse File Dokumen Sumber Soal (PDF, Word DOCX, Excel XLSX/CSV, TXT)
app.post('/api/guru/parse-file', requireGuru, async (req, res) => {
  try {
    const { base64, filename } = req.body;
    if (!base64) {
      return res.status(400).json({ success: false, message: 'Data berkas (base64) wajib disertakan' });
    }
    const result = await fileParserService.parseFile(base64, filename || 'document.txt');
    res.json(result);
  } catch (err) {
    console.error('Error parse file:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// Profil Guru & Pengaturan Kontak (WhatsApp)
app.get('/api/guru/profile', requireGuru, (req, res) => {
  try {
    const profile = authService.getGuruProfile(req.guru.guruId);
    res.json({ success: true, data: profile });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/guru/profile', requireGuru, (req, res) => {
  try {
    const updated = authService.updateGuruProfile(req.guru.guruId, req.body);
    res.json({ success: true, data: updated, message: 'Profil guru berhasil diperbarui' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Master Kelas Guru
app.get('/api/guru/kelas', requireGuru, (req, res) => {
  try {
    const list = classService.getKelasByGuru(req.guru.guruId);
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/guru/kelas', requireGuru, (req, res) => {
  try {
    const { nama_kelas } = req.body;
    const created = classService.createKelas(req.guru.guruId, nama_kelas);
    res.json({ success: true, data: created });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.delete('/api/guru/kelas/:id', requireGuru, (req, res) => {
  try {
    classService.deleteKelas(req.params.id, req.guru.guruId);
    res.json({ success: true, message: 'Kelas berhasil dihapus' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Peserta & Review
app.get('/api/guru/ulangan/:id/peserta', requireGuru, (req, res) => {
  try {
    const list = reviewService.getPengerjaanListByUlangan(req.params.id, req.guru.guruId);
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.get('/api/guru/pengerjaan/:id', requireGuru, (req, res) => {
  try {
    const detail = reviewService.getPengerjaanDetail(req.params.id, req.guru.guruId);
    res.json({ success: true, data: detail });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.delete('/api/guru/pengerjaan/:id', requireGuru, (req, res) => {
  try {
    const result = reviewService.deletePengerjaan(req.params.id, req.guru.guruId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Finalisasi pengerjaan siswa terputus (DC) oleh guru
app.post('/api/guru/pengerjaan/:id/force-submit', requireGuru, (req, res) => {
  try {
    const result = studentService.forceSubmitByGuru(req.params.id, req.guru.guruId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post('/api/guru/jawaban/:id/review', requireGuru, (req, res) => {
  try {
    const result = reviewService.updateJawabanReview(req.params.id, req.guru.guruId, req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post('/api/guru/pengerjaan/:id/accept-ai', requireGuru, (req, res) => {
  try {
    const updated = reviewService.acceptAllAiScores(req.params.id, req.guru.guruId);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post('/api/guru/ulangan/:id/release', requireGuru, (req, res) => {
  try {
    const { isReleased, kelas, pengerjaan_id } = req.body;
    const result = reviewService.toggleReleasePengerjaan(req.params.id, req.guru.guruId, Boolean(isReleased), kelas || null, pengerjaan_id || null);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Rilis / Tarik Rilis Nilai Perorangan Siswa
app.post('/api/guru/pengerjaan/:id/release', requireGuru, (req, res) => {
  try {
    const { isReleased } = req.body;
    const result = reviewService.toggleReleaseSinglePengerjaan(req.params.id, req.guru.guruId, Boolean(isReleased));
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Penilaian AI Perorangan (Review AI per Siswa)
app.post('/api/guru/pengerjaan/:id/ai/start', requireGuru, async (req, res) => {
  try {
    const result = await queueService.startReviewSingle(req.params.id, req.guru.guruId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Antrean AI (Start, Stop, Status)
app.post('/api/guru/ulangan/:id/ai/start', requireGuru, async (req, res) => {
  try {
    const result = await queueService.startReview(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint pemrosesan per langkah antrean AI (optimal untuk Serverless Vercel & real-time progress)
app.post('/api/guru/ulangan/:id/ai/process-next', requireGuru, async (req, res) => {
  try {
    const result = await queueService.processNextAnswer(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/guru/ulangan/:id/ai/stop', requireGuru, (req, res) => {
  try {
    const result = queueService.stopReview(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/guru/ulangan/:id/ai/status', requireGuru, (req, res) => {
  try {
    const status = queueService.getQueueStatus(req.params.id);
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Helper model status
app.get('/api/guru/ai/model-info', requireGuru, async (req, res) => {
  try {
    const activeModel = await geminiService.getAvailableModel();
    res.json({ success: true, model: activeModel });
  } catch (err) {
    res.json({ success: true, model: 'gemini-2.0-flash' });
  }
});

// ----------------------------------------------------
// ROUTE: Modul Admin (Manajemen Guru & Konfigurasi AI)
// ----------------------------------------------------
const requireAdmin = authService.adminAuthMiddleware;

// Login Admin
app.post('/api/admin/login', (req, res) => {
  const { username, password, remember_me } = req.body;
  const isRemember = remember_me === true || remember_me === 'true' || remember_me === 1 || remember_me === '1';
  const result = authService.loginAdmin(username, password, isRemember);
  if (!result.success) {
    return res.status(401).json(result);
  }

  const isSecure = Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https');
  const maxAge = isRemember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  res.cookie('admin_token', result.token, {
    httpOnly: true,
    maxAge,
    sameSite: isSecure ? 'none' : 'lax',
    secure: isSecure
  });

  res.json(result);
});

// Profil Admin
app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ success: true, admin: req.admin });
});

// Logout Admin
app.post('/api/admin/logout', (req, res) => {
  const token = req.cookies?.admin_token || req.headers['authorization']?.replace('Bearer ', '');
  authService.logout(token);
  res.clearCookie('admin_token');
  res.json({ success: true, message: 'Berhasil logout admin' });
});

// CRUD Guru
app.get('/api/admin/guru', requireAdmin, (req, res) => {
  try {
    const list = adminService.getAllGuru();
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/guru', requireAdmin, (req, res) => {
  try {
    const { nama, email, password } = req.body;
    const result = adminService.createGuru(nama, email, password);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.put('/api/admin/guru/:id', requireAdmin, (req, res) => {
  try {
    const result = adminService.updateGuru(req.params.id, req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.delete('/api/admin/guru/:id', requireAdmin, (req, res) => {
  try {
    const result = adminService.deleteGuru(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Konfigurasi & Uji AI Key (Backward-compatibility single key)
app.get('/api/admin/ai-config', requireAdmin, (req, res) => {
  try {
    const config = adminService.getAiConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/ai-config', requireAdmin, (req, res) => {
  try {
    const { api_key } = req.body;
    const result = adminService.updateAiConfig(api_key);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/ai-config/test', requireAdmin, async (req, res) => {
  try {
    const { api_key } = req.body;
    const result = await adminService.testAiConnection(api_key);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// Multi-Key Gemini API Management (Backup & Failover)
app.get('/api/admin/ai-keys', requireAdmin, (req, res) => {
  try {
    const keys = adminService.getAllAiKeys();
    res.json({ success: true, data: keys });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/ai-keys', requireAdmin, (req, res) => {
  try {
    const { label, api_key, priority } = req.body;
    const result = adminService.addAiKey(label, api_key, priority);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.put('/api/admin/ai-keys/:id', requireAdmin, (req, res) => {
  try {
    const result = adminService.updateAiKey(req.params.id, req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.delete('/api/admin/ai-keys/:id', requireAdmin, (req, res) => {
  try {
    const result = adminService.deleteAiKey(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/ai-keys/:id/test', requireAdmin, async (req, res) => {
  try {
    const result = await adminService.testSpecificKey(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ==========================================
// ROUTE: Backup & Restore Database (Admin)
// ==========================================
app.get('/api/admin/database/backup', requireAdmin, async (req, res) => {
  try {
    const dataDir = db.getDataDir();
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const timestamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const filename = `ulangan_ai_backup_${timestamp}.sqlite`;
    const tempBackupPath = path.join(dataDir, `export_${timestamp}_${Math.random().toString(36).substring(2, 7)}.sqlite`);

    await db.backupDatabaseToFile(tempBackupPath);

    res.download(tempBackupPath, filename, (err) => {
      if (fs.existsSync(tempBackupPath)) {
        try { fs.unlinkSync(tempBackupPath); } catch (e) {}
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal membuat file cadangan: ' + err.message });
  }
});

app.post('/api/admin/database/restore', requireAdmin, (req, res) => {
  try {
    const { file_base64 } = req.body;
    if (!file_base64) {
      return res.status(400).json({ success: false, message: 'File cadangan tidak ditemukan pada request.' });
    }

    const buf = Buffer.from(file_base64, 'base64');
    const result = db.restoreDatabaseFromBuffer(buf);

    res.json({
      success: true,
      message: 'Database berhasil dipulihkan secara penuh.',
      summary: result.summary
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});


// Export app untuk testing atau jalankan server jika dipanggil langsung
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[Sistem Ulangan AI] Server berjalan di http://localhost:${PORT}`);
    console.log(`[Google Sites Embed Ready] Header CSP frame-ancestors aktif.`);

    // Jadwal periodik pembersihan sesi DC kosong (>1 jam atau lewat durasi) & auto-finalize
    setInterval(() => {
      try {
        studentService.cleanAbandonedSessions();
      } catch (e) {
        console.error('[CRON CLEANUP ERROR]', e.message);
      }
    }, 2 * 60 * 1000);
  });
}

module.exports = app;
