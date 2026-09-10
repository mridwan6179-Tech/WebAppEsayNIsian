const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
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

  const maxAge = isRemember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

  // Simpan token di HTTP-Only Cookie
  res.cookie('auth_token', result.token, {
    httpOnly: true,
    maxAge,
    sameSite: 'none',
    secure: true // Diperlukan saat di-embed di iframe HTTPS Google Sites
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

app.post('/api/siswa/submit', (req, res) => {
  try {
    const { pengerjaan_id, jawaban, paste_count, is_auto_submit } = req.body;
    if (!pengerjaan_id) {
      return res.status(400).json({ success: false, message: 'pengerjaan_id wajib disertakan' });
    }

    // Ambil ulangan_id untuk melepaskan slot antrean
    const pengerjaanBefore = db.prepare('SELECT ulangan_id FROM pengerjaan WHERE id = ?').get(pengerjaan_id);
    const result = studentService.submitExam(pengerjaan_id, jawaban, paste_count, Boolean(is_auto_submit));

    // Lepaskan 1 slot untuk antrean ruang tunggu
    if (pengerjaanBefore?.ulangan_id) {
      waitingRoomService.releaseSlot(pengerjaanBefore.ulangan_id);
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
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

// AI Soal Generator
app.post('/api/guru/generate-soal', requireGuru, async (req, res) => {
  try {
    const {
      mode,
      input_sumber,
      jenjang_kelas,
      jumlah_soal,
      tipe_soal,
      tingkat_kesulitan,
      target_total_bobot,
      jumlah_isian,
      jumlah_essay
    } = req.body;

    if (!input_sumber || input_sumber.trim() === '') {
      return res.status(400).json({ success: false, message: 'Topik atau teks materi wajib diisi' });
    }

    const result = await geminiService.generateQuestions({
      mode,
      input_sumber,
      jenjang_kelas,
      jumlah_soal,
      tipe_soal,
      tingkat_kesulitan,
      target_total_bobot,
      jumlah_isian,
      jumlah_essay
    });

    res.json(result);
  } catch (err) {
    console.error('Error generate soal AI:', err);
    res.status(err.status === 429 ? 429 : 500).json({ success: false, message: err.message });
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
    const { isReleased } = req.body;
    const result = reviewService.toggleReleasePengerjaan(req.params.id, req.guru.guruId, Boolean(isReleased));
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

// Export app untuk testing atau jalankan server jika dipanggil langsung
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[Sistem Ulangan AI] Server berjalan di http://localhost:${PORT}`);
    console.log(`[Google Sites Embed Ready] Header CSP frame-ancestors aktif.`);
  });
}

module.exports = app;
