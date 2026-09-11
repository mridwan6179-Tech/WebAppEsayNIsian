const BetterSqlite3 = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true' || !!process.env.NOW_REGION;
const dataDir = isVercel ? '/tmp' : path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const isTest = process.env.NODE_ENV === 'test' || process.argv.some(arg => arg.includes('test'));
const tursoUrl = isTest ? null : process.env.TURSO_DATABASE_URL;
const tursoToken = isTest ? null : process.env.TURSO_AUTH_TOKEN;

let db;
let dbPath;

if (tursoUrl && tursoToken) {
  const LibsqlDatabase = require('libsql');
  dbPath = path.join(dataDir, 'turso.sqlite');
  console.log('📡 Menghubungkan ke Turso Cloud Database (libSQL Embedded Replica)...');
  db = new LibsqlDatabase(dbPath, {
    syncUrl: tursoUrl,
    authToken: tursoToken,
    syncInterval: 60000 // Sinkronisasi otomatis setiap 60 detik
  });
  if (typeof db.sync === 'function') {
    // Jalankan sinkronisasi awal secara non-blocking agar server langsung bisa menerima request
    setImmediate(() => {
      try {
        db.sync();
        console.log('✅ Sinkronisasi latar belakang Turso Cloud (AWS Tokyo) berhasil!');
      } catch (err) {
        console.warn('⚠️ Sinkronisasi latar belakang Turso:', err.message);
      }
    });
  }

  // libSQL embedded replica tidak mendukung transaksi manual "BEGIN " via exec()
  // Bungkus db.transaction agar kompatibel dengan better-sqlite3 tanpa memicu InvalidParserState("Init")
  db.transaction = function(fn) {
    const wrapped = function(...args) {
      return fn(...args);
    };
    wrapped.default = wrapped;
    wrapped.deferred = wrapped;
    wrapped.immediate = wrapped;
    wrapped.exclusive = wrapped;
    return wrapped;
  };
} else {
  dbPath = path.join(dataDir, 'database.sqlite');
  db = new BetterSqlite3(dbPath);
}

// Enable WAL mode & foreign keys & busy timeout
try {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
} catch (e) {
  console.warn('⚠️ Pragma setting notice:', e.message);
}

let isSyncing = false;
let lastSyncTime = 0;
db.syncCloud = function(force = false) {
  if (typeof db.sync !== 'function' || isSyncing) return;
  const now = Date.now();
  const minInterval = force ? 10000 : 30000;
  if (now - lastSyncTime < minInterval) return;

  lastSyncTime = now;
  isSyncing = true;
  // Jalankan sinkronisasi di background tanpa memblokir event loop dan respons Express
  setImmediate(() => {
    try {
      db.sync();
    } catch (e) {
      console.warn('⚠️ Turso background sync:', e.message);
    } finally {
      isSyncing = false;
    }
  });
};

function initDatabase() {
  const hasSchema = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='guru'").get());
  if (!hasSchema) {
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
      jumlah_soal_isian INTEGER DEFAULT NULL,
      jumlah_soal_essay INTEGER DEFAULT NULL,
      jumlah_soal_listening INTEGER DEFAULT NULL,
      acak_soal INTEGER DEFAULT 0,
      tanggal_mulai DATETIME,
      tanggal_selesai DATETIME,
      durasi_menit INTEGER DEFAULT NULL,
      kkm INTEGER DEFAULT 75,
      instruksi_remedial TEXT DEFAULT NULL,
      link_remedial TEXT DEFAULT NULL,
      zona_waktu TEXT DEFAULT 'WIB',
      izinkan_singkatan INTEGER DEFAULT 0,
      izinkan_informal INTEGER DEFAULT 0,
      toleransi_typo INTEGER DEFAULT 1,
      instruksi_penilaian_khusus TEXT DEFAULT NULL,
      tampilkan_simbol INTEGER DEFAULT 1,
      link_kisi_kisi TEXT DEFAULT NULL,
      tampilkan_kisi_kisi INTEGER DEFAULT 0,
      tampilkan_teks_listening INTEGER DEFAULT 0,
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
      last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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

    CREATE TABLE IF NOT EXISTS bank_soal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guru_id INTEGER NOT NULL,
      kategori TEXT NOT NULL,
      sub_topik TEXT DEFAULT NULL,
      tingkat_kelas TEXT DEFAULT NULL,
      jenis TEXT CHECK(jenis IN ('isian', 'essay')) NOT NULL,
      pertanyaan TEXT NOT NULL,
      kunci_jawaban TEXT DEFAULT NULL,
      rubrik TEXT DEFAULT NULL,
      pembahasan TEXT DEFAULT NULL,
      tingkat_kesulitan TEXT DEFAULT 'sedang',
      bobot_standar REAL DEFAULT 10,
      gambar_url TEXT DEFAULT NULL,
      audio_url TEXT DEFAULT NULL,
      audio_script TEXT DEFAULT NULL,
      is_listening INTEGER DEFAULT 0,
      bahasa TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (guru_id) REFERENCES guru(id) ON DELETE CASCADE
    );
  `);
  }

  // Migrasi cerdas: Periksa ketersediaan kolom via local pragma sebelum mengeksekusi ALTER TABLE
  // Mencegah puluhan round-trip remote yang memblokir server saat startup
  const tableColumnsMap = new Map();
  function hasColumn(tableName, colName) {
    if (!tableColumnsMap.has(tableName)) {
      try {
        const info = db.pragma(`table_info("${tableName}")`);
        tableColumnsMap.set(tableName, new Set(info.map(c => c.name.toLowerCase())));
      } catch (e) {
        tableColumnsMap.set(tableName, new Set());
      }
    }
    return tableColumnsMap.get(tableName).has(colName.toLowerCase());
  }

  function safeAddColumn(tableName, colName, colDef) {
    if (!hasColumn(tableName, colName)) {
      try {
        db.exec(`ALTER TABLE "${tableName}" ADD COLUMN ${colName} ${colDef};`);
        tableColumnsMap.get(tableName).add(colName.toLowerCase());
      } catch (e) {}
    }
  }

  safeAddColumn('ulangan', 'jumlah_soal_tampil', 'INTEGER DEFAULT NULL');
  safeAddColumn('ulangan', 'acak_soal', 'INTEGER DEFAULT 0');
  safeAddColumn('pengerjaan', 'soal_ids', 'TEXT DEFAULT NULL');
  safeAddColumn('pengerjaan', 'paste_count', 'INTEGER DEFAULT 0');
  safeAddColumn('soal', 'gambar_url', 'TEXT DEFAULT NULL');
  safeAddColumn('guru', 'password', 'TEXT DEFAULT NULL');
  safeAddColumn('ulangan', 'durasi_menit', 'INTEGER DEFAULT NULL');
  safeAddColumn('pengerjaan', 'auto_submitted', 'INTEGER DEFAULT 0');
  safeAddColumn('ulangan', 'kkm', 'INTEGER DEFAULT 75');
  safeAddColumn('guru', 'no_wa', 'TEXT DEFAULT NULL');
  safeAddColumn('ulangan', 'instruksi_remedial', 'TEXT DEFAULT NULL');
  safeAddColumn('ulangan', 'link_remedial', 'TEXT DEFAULT NULL');
  safeAddColumn('ulangan', 'zona_waktu', "TEXT DEFAULT 'WIB'");
  safeAddColumn('ulangan', 'izinkan_singkatan', 'INTEGER DEFAULT 0');
  safeAddColumn('ulangan', 'izinkan_informal', 'INTEGER DEFAULT 0');
  safeAddColumn('ulangan', 'toleransi_typo', 'INTEGER DEFAULT 1');
  safeAddColumn('ulangan', 'instruksi_penilaian_khusus', 'TEXT DEFAULT NULL');
  safeAddColumn('ulangan', 'jumlah_soal_isian', 'INTEGER DEFAULT NULL');
  safeAddColumn('ulangan', 'jumlah_soal_essay', 'INTEGER DEFAULT NULL');
  safeAddColumn('ulangan', 'jumlah_soal_listening', 'INTEGER DEFAULT NULL');
  safeAddColumn('soal', 'pembahasan', 'TEXT DEFAULT NULL');
  safeAddColumn('soal', 'audio_url', 'TEXT DEFAULT NULL');
  safeAddColumn('soal', 'audio_script', 'TEXT DEFAULT NULL');
  safeAddColumn('soal', 'is_listening', 'INTEGER DEFAULT 0');
  safeAddColumn('soal', 'bahasa', 'TEXT DEFAULT NULL');
  safeAddColumn('soal', 'kategori', 'TEXT DEFAULT NULL');
  safeAddColumn('bank_soal', 'audio_url', 'TEXT DEFAULT NULL');
  safeAddColumn('bank_soal', 'audio_script', 'TEXT DEFAULT NULL');
  safeAddColumn('bank_soal', 'is_listening', 'INTEGER DEFAULT 0');
  safeAddColumn('bank_soal', 'bahasa', 'TEXT DEFAULT NULL');
  safeAddColumn('ulangan', 'tampilkan_simbol', 'INTEGER DEFAULT 1');
  safeAddColumn('ulangan', 'link_kisi_kisi', 'TEXT DEFAULT NULL');
  safeAddColumn('ulangan', 'tampilkan_kisi_kisi', 'INTEGER DEFAULT 0');
  safeAddColumn('ulangan', 'tampilkan_teks_listening', 'INTEGER DEFAULT 0');
  safeAddColumn('soal', 'tampilkan_teks_listening', 'INTEGER DEFAULT NULL');
  safeAddColumn('bank_soal', 'tampilkan_teks_listening', 'INTEGER DEFAULT 0');
  safeAddColumn('pengerjaan', 'last_active_at', 'DATETIME');

  try {
    db.exec("UPDATE pengerjaan SET last_active_at = COALESCE(last_active_at, started_at, CURRENT_TIMESTAMP) WHERE last_active_at IS NULL;");
  } catch (e) {}

  try {
    db.exec("UPDATE ulangan SET tampilkan_kisi_kisi = 1 WHERE link_kisi_kisi IS NOT NULL AND TRIM(link_kisi_kisi) != '' AND (tampilkan_kisi_kisi IS NULL OR tampilkan_kisi_kisi = 0);");
  } catch (e) {}

  // Bersihkan data duplikat jawaban (jika ada soal_id yang ter-insert lebih dari 1 kali untuk pengerjaan yang sama)
  try {
    db.exec(`
      DELETE FROM jawaban 
      WHERE id NOT IN (
        SELECT MIN(id) 
        FROM jawaban 
        GROUP BY pengerjaan_id, soal_id
      );
    `);
  } catch (e) {}

  // Tambahkan UNIQUE index agar tidak akan pernah ada duplikasi butir soal per pengerjaan
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_jawaban_pengerjaan_soal ON jawaban(pengerjaan_id, soal_id);");
  } catch (e) {}

  // Seed initial guru if table is empty
  const teacherEmail = process.env.TEACHER_EMAIL || 'mridwan700611@gmail.com';
  const teacherName = process.env.TEACHER_NAME || 'Muhammad Ridwan, S.Kom';
  const teacherPassword = process.env.TEACHER_PASSWORD || 'Guru123';
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
  const rawEnvKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
    .split(/[\n,;]+/)
    .map(k => k.trim())
    .filter(k => k && k !== 'YOUR_GEMINI_API_KEY');

  let initialKey = rawEnvKeys[0] || '';
  if (!initialKey) {
    const existingKey = db.prepare("SELECT value FROM app_settings WHERE key = 'gemini_api_key'").get();
    if (existingKey?.value && existingKey.value !== 'YOUR_GEMINI_API_KEY') {
      initialKey = existingKey.value;
    }
  } else {
    const existingKey = db.prepare("SELECT value FROM app_settings WHERE key = 'gemini_api_key'").get();
    if (!existingKey) {
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('gemini_api_key', ?)").run(initialKey);
    }
  }

  // Seed initial gemini_api_keys if table empty (mendukung multiple keys dipisah koma)
  const keyCount = db.prepare('SELECT COUNT(*) as c FROM gemini_api_keys').get().c;
  if (keyCount === 0 && (rawEnvKeys.length > 0 || initialKey)) {
    const insertKeyStmt = db.prepare(`
      INSERT INTO gemini_api_keys (label, api_key, priority)
      VALUES (?, ?, ?)
    `);
    if (rawEnvKeys.length > 0) {
      rawEnvKeys.forEach((k, idx) => {
        insertKeyStmt.run(
          idx === 0 ? 'Kunci Utama (Default)' : `Kunci Cadangan ${idx}`,
          k,
          idx + 1
        );
      });
    } else if (initialKey) {
      insertKeyStmt.run('Kunci Utama (Default)', initialKey, 1);
    }
  }

  // Seed initial sample kelas if empty
  const kelasCount = db.prepare('SELECT COUNT(*) as c FROM kelas WHERE guru_id = ?').get(guru.id);
  if (kelasCount.c === 0) {
    const defaultClasses = [
      '7A', '7B', '7C', '7D',
      '8A', '8B', '8C', '8D',
      '9A', '9B', '9C', '9D'
    ];
    const insertK = db.prepare('INSERT INTO kelas (guru_id, nama_kelas) VALUES (?, ?)');
    for (const kc of defaultClasses) {
      insertK.run(guru.id, kc);
    }
  }
}

async function backupDatabaseToFile(targetPath) {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.warn('WAL checkpoint warning:', err.message);
  }
  await db.backup(targetPath);
  return targetPath;
}

function restoreDatabaseFromBuffer(buffer) {
  if (!buffer || buffer.length < 100) {
    throw new Error('File terlalu kecil atau kosong untuk database SQLite.');
  }

  const magic = buffer.slice(0, 16).toString('utf8');
  if (magic !== 'SQLite format 3\0') {
    throw new Error('Format file tidak valid. Harap unggah file SQLite database (.sqlite atau .db).');
  }

  const tempRestorePath = path.join(dataDir, `temp_restore_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.sqlite`);
  fs.writeFileSync(tempRestorePath, buffer);

  let testTempDb;
  try {
    testTempDb = new BetterSqlite3(tempRestorePath, { readonly: true });
    const tables = testTempDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length === 0) {
      throw new Error('File database tidak memiliki tabel data yang valid.');
    }
    testTempDb.close();
    testTempDb = null;
  } catch (err) {
    if (testTempDb) try { testTempDb.close(); } catch (e) {}
    if (fs.existsSync(tempRestorePath)) {
      try { fs.unlinkSync(tempRestorePath); } catch (e) {}
    }
    throw new Error('Gagal memverifikasi file cadangan: ' + err.message);
  }

  try {
    db.pragma('foreign_keys = OFF');
    const attachPath = tempRestorePath.replace(/\\/g, '/');
    db.exec(`ATTACH DATABASE '${attachPath.replace(/'/g, "''")}' AS src;`);

    const srcTables = db.prepare("SELECT name, sql FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();

    const restoreTx = db.transaction(() => {
      // Hapus tabel lama di database utama
      const currentTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      for (const ct of currentTables) {
        db.exec(`DROP TABLE IF EXISTS "${ct.name}";`);
      }
      // Buat ulang skema dan salin data dari file cadangan
      for (const t of srcTables) {
        db.exec(t.sql);
        db.exec(`INSERT INTO "${t.name}" SELECT * FROM src."${t.name}";`);
      }
    });

    restoreTx();
    db.exec('DETACH DATABASE src;');
    db.pragma('foreign_keys = ON');
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {}

    // Sinkronkan ke cloud Turso jika aktif
    db.syncCloud();

    // Hitung ringkasan data yang berhasil dipulihkan
    const summary = {};
    for (const t of ['guru', 'ulangan', 'soal', 'sesi_ujian', 'jawaban', 'gemini_api_keys', 'kelas']) {
      try {
        const row = db.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get();
        summary[t] = row ? row.c : 0;
      } catch (e) {
        summary[t] = 0;
      }
    }

    return { success: true, summary };
  } finally {
    if (fs.existsSync(tempRestorePath)) {
      try { fs.unlinkSync(tempRestorePath); } catch (e) {}
    }
  }
}

db.backupDatabaseToFile = backupDatabaseToFile;
db.restoreDatabaseFromBuffer = restoreDatabaseFromBuffer;
db.getDataDir = () => dataDir;
db.getDbPath = () => dbPath;

initDatabase();

module.exports = db;
