const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true' || !!process.env.NOW_REGION;
const dataDir = isVercel ? '/tmp' : path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'database.sqlite');
const db = new Database(dbPath);

// Enable WAL mode & foreign keys & busy timeout
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guru (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      nama TEXT NOT NULL,
      password TEXT DEFAULT NULL,
      no_wa TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ulangan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guru_id INTEGER NOT NULL,
      judul TEXT NOT NULL,
      mata_pelajaran TEXT NOT NULL,
      tingkat_kelas TEXT NOT NULL,
      deskripsi TEXT,
      kode_ujian TEXT UNIQUE NOT NULL,
      status TEXT CHECK(status IN ('draft', 'dibuka', 'ditutup', 'selesai')) DEFAULT 'draft',
      jumlah_soal_tampil INTEGER DEFAULT NULL,
      acak_soal INTEGER DEFAULT 0,
      tanggal_mulai DATETIME,
      tanggal_selesai DATETIME,
      durasi_menit INTEGER DEFAULT NULL,
      kkm INTEGER DEFAULT 75,
      instruksi_remedial TEXT DEFAULT NULL,
      link_remedial TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (guru_id) REFERENCES guru(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS soal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ulangan_id INTEGER NOT NULL,
      nomor INTEGER NOT NULL,
      jenis TEXT CHECK(jenis IN ('isian', 'essay')) NOT NULL,
      pertanyaan TEXT NOT NULL,
      gambar_url TEXT DEFAULT NULL,
      kunci_jawaban TEXT,
      rubrik TEXT,
      bobot REAL NOT NULL CHECK(bobot > 0),
      tingkat_kelas TEXT,
      tingkat_kesulitan TEXT,
      urutan INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ulangan_id) REFERENCES ulangan(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS peserta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ulangan_id INTEGER NOT NULL,
      nama TEXT NOT NULL,
      kelas TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ulangan_id) REFERENCES ulangan(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pengerjaan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ulangan_id INTEGER NOT NULL,
      peserta_id INTEGER NOT NULL,
      status TEXT CHECK(status IN ('mengerjakan', 'submitted')) DEFAULT 'mengerjakan',
      soal_ids TEXT DEFAULT NULL,
      paste_count INTEGER DEFAULT 0,
      auto_submitted INTEGER DEFAULT 0,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      submitted_at DATETIME,
      nilai_ai REAL,
      nilai_final REAL,
      released_at DATETIME,
      FOREIGN KEY (ulangan_id) REFERENCES ulangan(id) ON DELETE CASCADE,
      FOREIGN KEY (peserta_id) REFERENCES peserta(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS jawaban (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pengerjaan_id INTEGER NOT NULL,
      soal_id INTEGER NOT NULL,
      jawaban_siswa TEXT,
      status_penilaian TEXT CHECK(status_penilaian IN ('menunggu', 'diproses', 'selesai', 'gagal')) DEFAULT 'menunggu',
      skor_rekomendasi REAL,
      skor_maksimum REAL,
      status_jawaban TEXT CHECK(status_jawaban IN ('benar', 'parsial', 'salah', 'perlu_review')),
      alasan_ai TEXT,
      model_ai TEXT,
      attempt_count INTEGER DEFAULT 0,
      last_error TEXT,
      reviewed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pengerjaan_id) REFERENCES pengerjaan(id) ON DELETE CASCADE,
      FOREIGN KEY (soal_id) REFERENCES soal(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS review_guru (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jawaban_id INTEGER NOT NULL,
      guru_id INTEGER NOT NULL,
      skor_ai REAL,
      skor_final REAL NOT NULL,
      keputusan TEXT CHECK(keputusan IN ('diterima', 'diubah')) NOT NULL,
      catatan_guru TEXT,
      reviewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (jawaban_id) REFERENCES jawaban(id) ON DELETE CASCADE,
      FOREIGN KEY (guru_id) REFERENCES guru(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS antrean_review (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jawaban_id INTEGER UNIQUE NOT NULL,
      status TEXT CHECK(status IN ('menunggu', 'diproses', 'selesai', 'gagal')) DEFAULT 'menunggu',
      attempt_count INTEGER DEFAULT 0,
      next_attempt_at DATETIME,
      locked_at DATETIME,
      completed_at DATETIME,
      error_message TEXT,
      FOREIGN KEY (jawaban_id) REFERENCES jawaban(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_ai TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 1,
      last_tested_at DATETIME,
      last_success_at DATETIME,
      last_error TEXT,
      delay_normal INTEGER DEFAULT 7,
      delay_rate_limit INTEGER DEFAULT 20,
      max_retry INTEGER DEFAULT 3
    );
    CREATE TABLE IF NOT EXISTS kelas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guru_id INTEGER NOT NULL,
      nama_kelas TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (guru_id) REFERENCES guru(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ulangan_kelas (
      ulangan_id INTEGER NOT NULL,
      kelas_id INTEGER NOT NULL,
      PRIMARY KEY (ulangan_id, kelas_id),
      FOREIGN KEY (ulangan_id) REFERENCES ulangan(id) ON DELETE CASCADE,
      FOREIGN KEY (kelas_id) REFERENCES kelas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      nama TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS gemini_api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      api_key TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 1,
      status TEXT DEFAULT 'ready',
      last_tested_at DATETIME,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migrasi aman untuk database yang sudah ada
  try { db.exec('ALTER TABLE ulangan ADD COLUMN jumlah_soal_tampil INTEGER DEFAULT NULL;'); } catch (e) {}
  try { db.exec('ALTER TABLE ulangan ADD COLUMN acak_soal INTEGER DEFAULT 0;'); } catch (e) {}
  try { db.exec('ALTER TABLE pengerjaan ADD COLUMN soal_ids TEXT DEFAULT NULL;'); } catch (e) {}
  try { db.exec('ALTER TABLE pengerjaan ADD COLUMN paste_count INTEGER DEFAULT 0;'); } catch (e) {}
  try { db.exec('ALTER TABLE soal ADD COLUMN gambar_url TEXT DEFAULT NULL;'); } catch (e) {}
  try { db.exec('ALTER TABLE guru ADD COLUMN password TEXT DEFAULT NULL;'); } catch (e) {}
  try { db.exec('ALTER TABLE ulangan ADD COLUMN durasi_menit INTEGER DEFAULT NULL;'); } catch (e) {}
  try { db.exec('ALTER TABLE pengerjaan ADD COLUMN auto_submitted INTEGER DEFAULT 0;'); } catch (e) {}
  try { db.exec('ALTER TABLE ulangan ADD COLUMN kkm INTEGER DEFAULT 75;'); } catch (e) {}
  try { db.exec('ALTER TABLE guru ADD COLUMN no_wa TEXT DEFAULT NULL;'); } catch (e) {}
  try { db.exec('ALTER TABLE ulangan ADD COLUMN instruksi_remedial TEXT DEFAULT NULL;'); } catch (e) {}
  try { db.exec('ALTER TABLE ulangan ADD COLUMN link_remedial TEXT DEFAULT NULL;'); } catch (e) {}

  // Seed initial guru if table is empty
  const teacherEmail = process.env.TEACHER_EMAIL || 'guru@sekolah.id';
  const teacherName = process.env.TEACHER_NAME || 'Guru Pengampu';
  const teacherPassword = process.env.TEACHER_PASSWORD || 'guru123';
  const teacherWa = process.env.TEACHER_WA || '081234567890';

  let guru = db.prepare('SELECT id, password, no_wa FROM guru WHERE email = ?').get(teacherEmail);
  if (!guru) {
    const info = db.prepare('INSERT INTO guru (email, nama, password, no_wa) VALUES (?, ?, ?, ?)').run(teacherEmail, teacherName, teacherPassword, teacherWa);
    guru = { id: info.lastInsertRowid };
  } else {
    if (!guru.password) {
      db.prepare('UPDATE guru SET password = ? WHERE id = ?').run(teacherPassword, guru.id);
    }
    if (!guru.no_wa) {
      db.prepare('UPDATE guru SET no_wa = ? WHERE id = ?').run(teacherWa, guru.id);
    }
  }

  // Seed initial admin
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const adminName = process.env.ADMIN_NAME || 'Administrator Utama';
  let admin = db.prepare('SELECT id FROM admin WHERE username = ?').get(adminUsername);
  if (!admin) {
    db.prepare('INSERT INTO admin (username, password, nama) VALUES (?, ?, ?)').run(adminUsername, adminPassword, adminName);
  }

  // Seed initial app_settings for gemini_api_key if available in environment
  let initialKey = '';
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY') {
    initialKey = process.env.GEMINI_API_KEY;
    const existingKey = db.prepare("SELECT value FROM app_settings WHERE key = 'gemini_api_key'").get();
    if (!existingKey) {
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('gemini_api_key', ?)").run(process.env.GEMINI_API_KEY);
    }
  } else {
    const existingKey = db.prepare("SELECT value FROM app_settings WHERE key = 'gemini_api_key'").get();
    if (existingKey) initialKey = existingKey.value;
  }

  // Seed initial gemini_api_keys if table empty
  const keyCount = db.prepare('SELECT COUNT(*) as c FROM gemini_api_keys').get().c;
  if (keyCount === 0 && initialKey && initialKey !== 'YOUR_GEMINI_API_KEY') {
    db.prepare(`
      INSERT INTO gemini_api_keys (label, api_key, is_active, priority, status)
      VALUES ('Kunci Utama (Default)', ?, 1, 1, 'ready')
    `).run(initialKey);
  }

  // Seed initial sample kelas if empty
  const kelasCount = db.prepare('SELECT COUNT(*) as c FROM kelas WHERE guru_id = ?').get(guru.id);
  if (kelasCount.c === 0) {
    const defaultClasses = ['10 MIPA 1', '10 MIPA 2', '11 MIPA 1', '12 MIPA 1'];
    const insertK = db.prepare('INSERT INTO kelas (guru_id, nama_kelas) VALUES (?, ?)');
    for (const kc of defaultClasses) {
      insertK.run(guru.id, kc);
    }
  }
}

initDatabase();

module.exports = db;
