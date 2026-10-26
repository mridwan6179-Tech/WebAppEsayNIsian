const path = require('path');
const fs = require('fs');
require('dotenv').config();

// NOTE: better-sqlite3 hanya diload secara lazy (di dalam blok else / fungsi restore)
// agar tidak crash di Vercel serverless Linux saat env Turso sudah diset.

const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true' || !!process.env.NOW_REGION;
const dataDir = isVercel ? '/tmp' : path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const isTest = process.env.NODE_ENV === 'test' || process.argv.some(arg => arg.includes('test'));
const tursoUrl = isTest ? null : process.env.TURSO_DATABASE_URL;
const tursoToken = isTest ? null : process.env.TURSO_AUTH_TOKEN;
const cloudDatabaseConfigured = Boolean(tursoUrl && tursoToken);
const cloudSyncState = {
  status: cloudDatabaseConfigured ? 'pending' : 'disabled',
  last_attempt_at: null,
  last_success_at: null,
  error_code: null,
  error_detail: null
};

function resolveTursoMode({ isVercel: runningOnVercel, hasUrl, hasToken }) {
  if (!hasUrl || !hasToken) return 'sqlite';
  return runningOnVercel ? 'remote' : 'embedded';
}

function classifySyncError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('auth')) return 'auth';
  if (msg.includes('429') || msg.includes('limit exceeded') || msg.includes('concurrency') || msg.includes('busy') || msg.includes('locked')) return 'rate_limit';
  if (msg.includes('fetch') || msg.includes('timeout') || msg.includes('socket') || msg.includes('dns') || msg.includes('econn') || msg.includes('network') || msg.includes('connection')) return 'network';
  return 'sync_failed';
}

function safeSyncErrorDetail(err) {
  const raw = String(err?.message || err || '').replace(/https?:\/\/\S+/gi, '<url>');
  return raw.replace(/[A-Za-z0-9_-]{32,}/g, '<redacted>').slice(0, 160) || 'unknown';
}

let db;
let dbPath;

const tursoMode = resolveTursoMode({
  isVercel,
  hasUrl: Boolean(tursoUrl),
  hasToken: Boolean(tursoToken)
});

if (tursoMode === 'remote') {
  const { createRemoteDatabase } = require('./remoteDatabase');
  console.log('📡 Menghubungkan ke Turso Cloud Database melalui HTTP worker...');

  let currentDb = createRemoteDatabase({ url: tursoUrl, authToken: tursoToken });

  function isHranaStreamError(err) {
    if (!err) return false;
    const msg = String(err.message || err);
    return (
      msg.includes('stream not found') ||
      msg.includes('Hrana') ||
      msg.includes('connection closed') ||
      msg.includes('connection reset') ||
      msg.includes('socket hang up') ||
      msg.includes('broken pipe') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('query database timeout') ||
      msg.includes('fetch failed') ||
      (msg.includes('status=404') && msg.includes('stream'))
    );
  }

  function reconnectTurso() {
    console.warn('🔄 Mendeteksi stream/koneksi Turso kedaluwarsa atau terputus (Hrana), menyambung ulang instance Libsql...');
    try {
      const previousDb = currentDb;
      currentDb = createRemoteDatabase({ url: tursoUrl, authToken: tursoToken });
      if (typeof previousDb?.close === 'function') previousDb.close();
    } catch (e) {
      console.error('⚠️ Gagal menyambung ulang ke Turso:', e.message);
    }
  }

  function isTursoConcurrencyError(err) {
    if (!err) return false;
    const msg = String(err.message || err);
    return msg.includes('429') || msg.includes('limit exceeded') || msg.includes('concurrency') || msg.includes('PullFrame') || msg.includes('locked') || msg.includes('busy');
  }

  function sleepSync(ms) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (e) {
      const end = Date.now() + ms;
      while (Date.now() < end) {}
    }
  }

  function executeWithRetry(fn, sql = '', maxRetries = 3) {
    let lastErr;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return fn();
      } catch (err) {
        lastErr = err;
        if (isHranaStreamError(err)) {
          console.warn(`🔄 Mendeteksi kendala koneksi Turso/Hrana (percobaan ${attempt + 1}/${maxRetries}):`, err.message);
          reconnectTurso();
          sleepSync(200 * (attempt + 1));
        } else if (isTursoConcurrencyError(err)) {
          console.warn(`⚠️ Turso concurrency busy/429 (percobaan ${attempt + 1}/${maxRetries}):`, err.message);
          sleepSync(150 * (attempt + 1));
        } else {
          throw err;
        }
      }
    }
    throw lastErr;
  }

  db = {
    prepare(sql) {
      return {
        all(...args) {
          return executeWithRetry(() => currentDb.prepare(sql).all(...args), sql);
        },
        get(...args) {
          return executeWithRetry(() => currentDb.prepare(sql).get(...args), sql);
        },
        run(...args) {
          return executeWithRetry(() => currentDb.prepare(sql).run(...args), sql);
        }
      };
    },
    exec(sql) {
      return executeWithRetry(() => currentDb.exec(sql), sql);
    },
    pragma(sql) {
      return executeWithRetry(() => currentDb.pragma(sql), sql);
    },
    sync() {
      cloudSyncState.last_attempt_at = new Date().toISOString();
      // Remote Turso connections are already authoritative; there is no local
      // replica file to sync in Vercel.
      if (tursoMode === 'remote' || typeof currentDb.sync !== 'function') {
        cloudSyncState.status = 'ok';
        cloudSyncState.last_success_at = new Date().toISOString();
        cloudSyncState.error_code = null;
        cloudSyncState.error_detail = null;
        return true;
      }
      try {
        if (typeof currentDb.sync === 'function') {
          const result = currentDb.sync();
          cloudSyncState.status = 'ok';
          cloudSyncState.last_success_at = new Date().toISOString();
          cloudSyncState.error_code = null;
          cloudSyncState.error_detail = null;
          return result;
        }
      } catch (err) {
        cloudSyncState.status = 'error';
        cloudSyncState.error_code = classifySyncError(err);
        cloudSyncState.error_detail = safeSyncErrorDetail(err);
        if (isTursoConcurrencyError(err)) {
          console.warn('⚠️ Turso replica sync concurrency 429 ditangguhkan:', err.message);
          return;
        }
        if (isHranaStreamError(err)) {
          reconnectTurso();
          if (typeof currentDb.sync === 'function') {
            try {
              const result = currentDb.sync();
              cloudSyncState.status = 'ok';
              cloudSyncState.last_success_at = new Date().toISOString();
              cloudSyncState.error_code = null;
              cloudSyncState.error_detail = null;
              return result;
            } catch (retryErr) {
              cloudSyncState.status = 'error';
              cloudSyncState.error_code = classifySyncError(retryErr);
              cloudSyncState.error_detail = safeSyncErrorDetail(retryErr);
              console.warn('⚠️ db.sync() retry notice:', retryErr.message);
            }
          }
        } else {
          console.warn('⚠️ db.sync() notice:', err.message);
        }
      }
    },
    transaction(fn) {
      const wrapped = function(...args) {
        return fn(...args);
      };
      wrapped.default = wrapped;
      wrapped.deferred = wrapped;
      wrapped.immediate = wrapped;
      wrapped.exclusive = wrapped;
      return wrapped;
    }
  };
} else if (tursoMode === 'embedded') {
  const LibsqlDatabase = require('libsql');
  dbPath = path.join(dataDir, 'turso.sqlite');
  console.log('📡 Menghubungkan ke Turso Cloud Database (libSQL Embedded Replica)...');
  const currentDb = new LibsqlDatabase(dbPath, { syncUrl: tursoUrl, authToken: tursoToken });
  db = {
    prepare(sql) {
      return {
        all(...args) { return currentDb.prepare(sql).all(...args); },
        get(...args) { return currentDb.prepare(sql).get(...args); },
        run(...args) { return currentDb.prepare(sql).run(...args); }
      };
    },
    exec(sql) { return currentDb.exec(sql); },
    pragma(sql) { return currentDb.pragma(sql); },
    sync() { return currentDb.sync(); },
    transaction(fn) {
      const wrapped = (...args) => fn(...args);
      wrapped.default = wrapped;
      wrapped.deferred = wrapped;
      wrapped.immediate = wrapped;
      wrapped.exclusive = wrapped;
      return wrapped;
    }
  };
} else {
  // Lazy-load hanya di mode lokal (tidak ada env Turso). Di Vercel, ini tidak akan pernah dieksekusi
  // selama TURSO_DATABASE_URL & TURSO_AUTH_TOKEN sudah diset di dashboard Vercel.
  const BetterSqlite3 = require('better-sqlite3');
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

// ─────────────────────────────────────────────────────────
// OPTIMALISASI PERFORMA SQLite
// Pragma ini mempercepat query SELECT yang sering (monitor siswa, antrean AI, dll.)
// Aman untuk production dan tidak mengubah konsistensi data
// ─────────────────────────────────────────────────────────
try {
  db.pragma('synchronous = NORMAL');    // Lebih cepat dari FULL, masih aman dengan WAL mode
  db.pragma('cache_size = -16000');     // 16 MB page cache di RAM (default: hanya 2 MB)
  db.pragma('temp_store = MEMORY');     // Temp tables (sorting/grouping) di RAM, bukan disk
  db.pragma('mmap_size = 134217728');   // 128 MB memory-mapped I/O untuk baca data lebih cepat
} catch (e) {
  console.warn('⚠️ Performance pragma notice:', e.message);
}


let isSyncing = false;
let lastSyncTime = 0;
db.syncCloud = function(force = false) {
  if (typeof db.sync !== 'function' || isSyncing) return;
  const now = Date.now();
  // Throttle sinkronisasi: minimal jeda 60 detik jika normal, 15 detik jika force
  // Ini menghemat kuota bandwidth hingga 90%+ dan mencegah lock loop pada database
  const minInterval = force ? 15000 : 60000;
  if (now - lastSyncTime < minInterval) return;

  lastSyncTime = now;
  isSyncing = true;
  // Mutasi penting harus menunggu sync selesai sebelum serverless function berhenti.
  // Sinkronisasi rutin tetap dijalankan di background agar request baca tetap cepat.
  if (force) {
    try {
      db.sync();
    } catch (e) {
      console.warn('⚠️ Turso sync notice:', e.message);
    } finally {
      isSyncing = false;
    }
    return;
  }

  setImmediate(() => {
    try {
      db.sync();
    } catch (e) {
      console.warn('⚠️ Turso background sync notice:', e.message);
    } finally {
      isSyncing = false;
    }
  });
};

db.getRuntimeInfo = function() {
  return {
    mode: cloudDatabaseConfigured ? 'turso' : 'sqlite',
    connection: tursoMode,
    cloud_configured: cloudDatabaseConfigured,
    sync_status: cloudSyncState.status,
    last_sync_at: cloudSyncState.last_success_at,
    sync_error: cloudSyncState.error_code,
    sync_error_detail: cloudSyncState.error_detail
  };
};
db.resolveTursoMode = resolveTursoMode;

function initDatabase() {
  // Refresh an existing /tmp replica too. Vercel can reuse the file across
  // invocations while its contents are older than the Turso source of truth.
  if (typeof db.sync === 'function') {
    try {
      db.sync();
    } catch (e) {
      console.warn('⚠️ Initial replica sync notice:', e.message);
    }
  }

  let hasSchema = false;
  try {
    hasSchema = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='guru'").get());
  } catch (e) {}

  if (!hasSchema && typeof db.sync === 'function') {
    try {
      db.sync();
      hasSchema = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='guru'").get());
    } catch (e) {
      console.warn('⚠️ Initial replica sync notice:', e.message);
    }
  }

  const existingObjects = new Set();
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all();
    for (const r of rows) {
      if (r.name) existingObjects.add(r.name.toLowerCase());
    }
  } catch (e) {}

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
      jumlah_soal_pg INTEGER DEFAULT NULL,
      jumlah_soal_pg_kompleks INTEGER DEFAULT NULL,
      jumlah_soal_isian INTEGER DEFAULT NULL,
      jumlah_soal_essay INTEGER DEFAULT NULL,
      jumlah_soal_koding INTEGER DEFAULT NULL,
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
      konten_kisi_kisi TEXT DEFAULT NULL,
      tampilkan_kisi_kisi INTEGER DEFAULT 0,
      tampilkan_teks_listening INTEGER DEFAULT 0,
      skor_langsung_ai INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (guru_id) REFERENCES guru(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS soal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ulangan_id INTEGER NOT NULL,
      nomor INTEGER NOT NULL,
      jenis TEXT CHECK(jenis IN ('isian', 'essay', 'pilihan_ganda', 'koding_game')) NOT NULL,
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
      paste_details TEXT DEFAULT NULL,
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
      paste_count INTEGER DEFAULT 0,
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
      jenis TEXT CHECK(jenis IN ('isian', 'essay', 'pilihan_ganda', 'koding_game')) NOT NULL,
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

  // Tabel Fitur Baru: Tugas Rangkuman Berbantuan AI
  if (!existingObjects.has('tugas_rangkuman') || !existingObjects.has('pengerjaan_rangkuman') || !existingObjects.has('antrean_rangkuman')) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tugas_rangkuman (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guru_id INTEGER NOT NULL,
          judul TEXT NOT NULL,
          mata_pelajaran TEXT NOT NULL,
          tingkat_kelas TEXT NOT NULL,
          deskripsi TEXT,
          kode_tugas TEXT UNIQUE NOT NULL,
          tipe_media TEXT CHECK(tipe_media IN ('youtube', 'video_url', 'pdf_url', 'teks')) NOT NULL DEFAULT 'youtube',
          media_url TEXT,
          media_teks TEXT,
          batas_minimum_kata INTEGER DEFAULT 100,
          batas_maksimum_kata INTEGER DEFAULT 500,
          master_rangkuman TEXT,
          poin_kunci TEXT,
          tanggal_mulai DATETIME,
          tanggal_selesai DATETIME,
          status TEXT CHECK(status IN ('draft', 'dibuka', 'ditutup', 'selesai')) DEFAULT 'draft',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (guru_id) REFERENCES guru(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS pengerjaan_rangkuman (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tugas_id INTEGER NOT NULL,
          nama_siswa TEXT NOT NULL,
          kelas_siswa TEXT NOT NULL,
          teks_rangkuman TEXT NOT NULL,
          jumlah_kata INTEGER DEFAULT 0,
          status TEXT CHECK(status IN ('submitted', 'dinilai')) DEFAULT 'submitted',
          skor_ai REAL DEFAULT NULL,
          skor_final REAL DEFAULT NULL,
          status_kelulusan TEXT CHECK(status_kelulusan IN ('belum_final', 'lulus', 'revisi', 'final')) DEFAULT 'belum_final',
          feedback_ai TEXT,
          detail_poin_ai TEXT,
          model_ai TEXT,
          status_antrean TEXT CHECK(status_antrean IN ('menunggu', 'diproses', 'selesai', 'gagal')) DEFAULT 'menunggu',
          posisi_antrean INTEGER DEFAULT 0,
          submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          reviewed_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (tugas_id) REFERENCES tugas_rangkuman(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS antrean_rangkuman (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pengerjaan_id INTEGER UNIQUE NOT NULL,
          status TEXT CHECK(status IN ('menunggu', 'diproses', 'selesai', 'gagal')) DEFAULT 'menunggu',
          attempt_count INTEGER DEFAULT 0,
          locked_at DATETIME,
          completed_at DATETIME,
          error_message TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (pengerjaan_id) REFERENCES pengerjaan_rangkuman(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_tugas_rangkuman_guru ON tugas_rangkuman(guru_id);
        CREATE INDEX IF NOT EXISTS idx_tugas_rangkuman_kode ON tugas_rangkuman(kode_tugas);
        CREATE INDEX IF NOT EXISTS idx_pengerjaan_rangkuman_tugas ON pengerjaan_rangkuman(tugas_id);
        CREATE INDEX IF NOT EXISTS idx_antrean_rangkuman_status ON antrean_rangkuman(status);
      `);
    } catch (e) {
      console.warn('⚠️ Gagal inisialisasi tabel rangkuman:', e.message);
    }
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
  safeAddColumn('pengerjaan', 'paste_details', 'TEXT DEFAULT NULL');
  safeAddColumn('jawaban', 'paste_count', 'INTEGER DEFAULT 0');
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
  safeAddColumn('ulangan', 'konten_kisi_kisi', 'TEXT DEFAULT NULL');
  safeAddColumn('ulangan', 'tampilkan_kisi_kisi', 'INTEGER DEFAULT 0');
  safeAddColumn('ulangan', 'tampilkan_teks_listening', 'INTEGER DEFAULT 0');
  safeAddColumn('soal', 'tampilkan_teks_listening', 'INTEGER DEFAULT NULL');
  safeAddColumn('bank_soal', 'tampilkan_teks_listening', 'INTEGER DEFAULT 0');
  safeAddColumn('pengerjaan', 'last_active_at', 'DATETIME');
  // Token acak yang mengikat browser ke pemilik satu percobaan ujian.
  safeAddColumn('pengerjaan', 'student_session_token', 'TEXT DEFAULT NULL');
  // Klaim atomik untuk mencegah dua retry memproses attempt yang sama bersamaan.
  safeAddColumn('pengerjaan', 'submit_lock_token', 'TEXT DEFAULT NULL');
  safeAddColumn('pengerjaan', 'submit_started_at', 'DATETIME DEFAULT NULL');
  // Klaim lintas-instance agar retry submit tidak membuka dua slot antrean.
  safeAddColumn('pengerjaan', 'submit_slot_released_at', 'DATETIME DEFAULT NULL');

  // Migrasi: kolom PIN sekali pakai untuk ulangan
  safeAddColumn('ulangan', 'pin_aktif', 'INTEGER DEFAULT 0');
  safeAddColumn('ulangan', 'token_ujian', 'INTEGER DEFAULT NULL');
  safeAddColumn('peserta', 'pin_siswa', 'TEXT DEFAULT NULL');
  safeAddColumn('peserta', 'pin_used_at', 'DATETIME DEFAULT NULL');
  safeAddColumn('peserta', 'pin_device_id', 'TEXT DEFAULT NULL');

  // Migrasi: kolom Remedial Langsung Mandiri (Siswa < KKM)
  safeAddColumn('ulangan', 'remedial_langsung', 'INTEGER DEFAULT 0');
  safeAddColumn('pengerjaan', 'original_soal_ids', 'TEXT DEFAULT NULL');
  safeAddColumn('pengerjaan', 'remedial_ke', 'INTEGER DEFAULT 0');
  safeAddColumn('pengerjaan', 'pre_remedial_nilai_final', 'REAL DEFAULT NULL');
  safeAddColumn('pengerjaan', 'pre_remedial_nilai_ai', 'REAL DEFAULT NULL');
  safeAddColumn('pengerjaan', 'pre_remedial_submitted_at', 'TEXT DEFAULT NULL');
  safeAddColumn('pengerjaan', 'pre_remedial_released_at', 'TEXT DEFAULT NULL');
  safeAddColumn('pengerjaan', 'remedial_started_at', 'DATETIME DEFAULT NULL');
  safeAddColumn('pengerjaan', 'is_in_remedial', 'INTEGER DEFAULT 0');
  safeAddColumn('jawaban', 'pre_remedial_jawaban', 'TEXT DEFAULT NULL');
  safeAddColumn('jawaban', 'pre_remedial_skor', 'REAL DEFAULT NULL');
  safeAddColumn('jawaban', 'pre_remedial_status_jawaban', 'TEXT DEFAULT NULL');
  safeAddColumn('jawaban', 'pre_remedial_alasan_ai', 'TEXT DEFAULT NULL');

  // Migrasi: Batas Percobaan Ujian & Kebijakan Nilai Tertinggi
  safeAddColumn('ulangan', 'maksimal_percobaan', 'INTEGER DEFAULT 1');
  safeAddColumn('ulangan', 'kebijakan_nilai', "TEXT DEFAULT 'tertinggi'");
  safeAddColumn('pengerjaan', 'attempt_ke', 'INTEGER DEFAULT 1');
  safeAddColumn('pengerjaan', 'nilai_terbaik', 'REAL DEFAULT NULL');

  if (!existingObjects.has('idx_jawaban_pengerjaan_soal')) {
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
  }

  safeAddColumn('ulangan', 'jenis_ulangan', "TEXT DEFAULT 'campuran'");
  safeAddColumn('ulangan', 'jumlah_paket', 'INTEGER DEFAULT 1');
  safeAddColumn('ulangan', 'bobot_pg', 'REAL DEFAULT 60');
  safeAddColumn('ulangan', 'bobot_essay', 'REAL DEFAULT 40');
  safeAddColumn('ulangan', 'opsi_pg_count', 'INTEGER DEFAULT 4');
  safeAddColumn('ulangan', 'jumlah_soal_pg', 'INTEGER DEFAULT NULL');
  safeAddColumn('ulangan', 'jumlah_soal_pg_kompleks', 'INTEGER DEFAULT NULL');
  safeAddColumn('ulangan', 'jumlah_soal_koding', 'INTEGER DEFAULT NULL');
  safeAddColumn('ulangan', 'skor_langsung_ai', 'INTEGER DEFAULT 0');

  safeAddColumn('soal', 'opsi_a', 'TEXT DEFAULT NULL');
  safeAddColumn('soal', 'opsi_b', 'TEXT DEFAULT NULL');
  safeAddColumn('soal', 'opsi_c', 'TEXT DEFAULT NULL');
  safeAddColumn('soal', 'opsi_d', 'TEXT DEFAULT NULL');
  safeAddColumn('soal', 'opsi_e', 'TEXT DEFAULT NULL');
  safeAddColumn('soal', 'kunci_pg', 'TEXT DEFAULT NULL');

  safeAddColumn('bank_soal', 'opsi_a', 'TEXT DEFAULT NULL');
  safeAddColumn('bank_soal', 'opsi_b', 'TEXT DEFAULT NULL');
  safeAddColumn('bank_soal', 'opsi_c', 'TEXT DEFAULT NULL');
  safeAddColumn('bank_soal', 'opsi_d', 'TEXT DEFAULT NULL');
  safeAddColumn('bank_soal', 'opsi_e', 'TEXT DEFAULT NULL');
  safeAddColumn('bank_soal', 'kunci_pg', 'TEXT DEFAULT NULL');

  safeAddColumn('pengerjaan', 'paket_diambil', "TEXT DEFAULT 'A'");
  safeAddColumn('pengerjaan', 'skor_pg', 'REAL DEFAULT NULL');
  safeAddColumn('pengerjaan', 'skor_essay', 'REAL DEFAULT NULL');
  safeAddColumn('pengerjaan', 'skor_koding', 'REAL DEFAULT NULL');
  safeAddColumn('pengerjaan', 'metode_koreksi_pg', "TEXT DEFAULT 'online'");

  safeAddColumn('ulangan', 'bobot_koding', 'REAL DEFAULT 0');
  safeAddColumn('soal', 'game_data', 'TEXT DEFAULT NULL');
  safeAddColumn('bank_soal', 'game_data', 'TEXT DEFAULT NULL');
  safeAddColumn('jawaban', 'jawaban_koding', 'TEXT DEFAULT NULL');

  safeAddColumn('pengerjaan', 'sesi_id', 'INTEGER DEFAULT NULL');
  safeAddColumn('pengerjaan', 'nama_sesi', 'TEXT DEFAULT NULL');

  // Tabel Baru: Multi-Sesi Ujian (Beda Kelas, Tanggal, Jam, dan Token)
  if (!existingObjects.has('ulangan_sesi')) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ulangan_sesi (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ulangan_id INTEGER NOT NULL,
          nama_sesi TEXT NOT NULL,
          kode_sesi TEXT UNIQUE NOT NULL,
          kelas TEXT DEFAULT NULL,
          waktu_mulai DATETIME DEFAULT NULL,
          waktu_selesai DATETIME DEFAULT NULL,
          kuota_peserta INTEGER DEFAULT NULL,
          status TEXT CHECK(status IN ('aktif', 'nonaktif')) DEFAULT 'aktif',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (ulangan_id) REFERENCES ulangan(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ulangan_sesi_ulangan ON ulangan_sesi(ulangan_id);
        CREATE INDEX IF NOT EXISTS idx_ulangan_sesi_kode ON ulangan_sesi(kode_sesi);
      `);
    } catch (e) {
      console.warn('⚠️ Gagal inisialisasi tabel ulangan_sesi:', e.message);
    }
  }

  // Tabel Baru: Multi-Paket Soal & Log Scan Kamera LJK
  if (!existingObjects.has('paket_soal') || !existingObjects.has('omr_scan_log')) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS paket_soal (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ulangan_id INTEGER NOT NULL,
          nama_paket TEXT NOT NULL,
          urutan_soal_ids TEXT NOT NULL,
          kunci_jawaban_map TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (ulangan_id) REFERENCES ulangan(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_paket_soal_ulangan ON paket_soal(ulangan_id);

        CREATE TABLE IF NOT EXISTS omr_scan_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ulangan_id INTEGER NOT NULL,
          pengerjaan_id INTEGER DEFAULT NULL,
          nama_siswa TEXT,
          kelas TEXT,
          paket TEXT DEFAULT 'A',
          skor_pg REAL,
          total_soal INTEGER,
          total_benar INTEGER,
          raw_answers TEXT,
          image_data TEXT DEFAULT NULL,
          scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (ulangan_id) REFERENCES ulangan(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_omr_scan_ulangan ON omr_scan_log(ulangan_id);
      `);
    } catch (e) {
      console.warn('⚠️ Gagal inisialisasi tabel paket_soal / omr_scan_log:', e.message);
    }
  }

  // Tabel PIN Sekali Pakai (Anti Multi-Perangkat)
  if (!existingObjects.has('pin_sessions')) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pin_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ulangan_id INTEGER NOT NULL,
          peserta_id INTEGER DEFAULT NULL,
          nama_siswa TEXT DEFAULT NULL,
          kelas_siswa TEXT DEFAULT NULL,
          pin TEXT NOT NULL,
          device_id TEXT DEFAULT NULL,
          is_used INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          used_at DATETIME DEFAULT NULL,
          FOREIGN KEY (ulangan_id) REFERENCES ulangan(id) ON DELETE CASCADE,
          FOREIGN KEY (peserta_id) REFERENCES peserta(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pin_sessions_ulangan ON pin_sessions(ulangan_id);
        CREATE INDEX IF NOT EXISTS idx_pin_sessions_pin ON pin_sessions(ulangan_id, pin);
      `);
    } catch (e) {
      console.warn('⚠️ Gagal inisialisasi tabel pin_sessions:', e.message);
    }
  }

  // Migrasi penyesuaian kolom nama_siswa & kelas_siswa jika tabel pin_sessions dibuat sebelumnya
  try {
    safeAddColumn('pin_sessions', 'nama_siswa', 'TEXT DEFAULT NULL');
    safeAddColumn('pin_sessions', 'kelas_siswa', 'TEXT DEFAULT NULL');
  } catch (e) {}

  // Pastikan peserta_id pada pin_sessions dapat bernilai NULL (agar guru bisa generate pool PIN sebelum siswa mulai)
  try {
    const pinCols = db.pragma('table_info("pin_sessions")');
    const pesertaCol = pinCols.find(c => c.name.toLowerCase() === 'peserta_id');
    if (pesertaCol && pesertaCol.notnull === 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pin_sessions_migrated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ulangan_id INTEGER NOT NULL,
          peserta_id INTEGER DEFAULT NULL,
          nama_siswa TEXT DEFAULT NULL,
          kelas_siswa TEXT DEFAULT NULL,
          pin TEXT NOT NULL,
          device_id TEXT DEFAULT NULL,
          is_used INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          used_at DATETIME DEFAULT NULL,
          FOREIGN KEY (ulangan_id) REFERENCES ulangan(id) ON DELETE CASCADE,
          FOREIGN KEY (peserta_id) REFERENCES peserta(id) ON DELETE SET NULL
        );
        INSERT OR IGNORE INTO pin_sessions_migrated (id, ulangan_id, peserta_id, pin, device_id, is_used, created_at, used_at)
        SELECT id, ulangan_id, peserta_id, pin, device_id, is_used, created_at, used_at FROM pin_sessions;
        DROP TABLE pin_sessions;
        ALTER TABLE pin_sessions_migrated RENAME TO pin_sessions;
        CREATE INDEX IF NOT EXISTS idx_pin_sessions_ulangan ON pin_sessions(ulangan_id);
        CREATE INDEX IF NOT EXISTS idx_pin_sessions_pin ON pin_sessions(ulangan_id, pin);
      `);
    }
  } catch (e) {}

  // Update CHECK constraint soal & bank_soal agar mendukung 'pilihan_ganda' dan 'koding_game'
  try {
    const soalSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='soal'").get()?.sql;
    if (soalSql && !soalSql.includes("'koding_game'")) {
      db.exec('PRAGMA foreign_keys = OFF;');
      let newSql = soalSql;
      if (newSql.includes("jenis IN ('isian', 'essay', 'pilihan_ganda')")) {
        newSql = newSql.replace("jenis IN ('isian', 'essay', 'pilihan_ganda')", "jenis IN ('isian', 'essay', 'pilihan_ganda', 'koding_game')");
      } else if (newSql.includes("jenis IN ('isian', 'essay')")) {
        newSql = newSql.replace("jenis IN ('isian', 'essay')", "jenis IN ('isian', 'essay', 'pilihan_ganda', 'koding_game')");
      }
      newSql = newSql.replace("CREATE TABLE soal (", "CREATE TABLE soal_new (")
                     .replace('CREATE TABLE "soal" (', 'CREATE TABLE "soal_new" (');
      db.exec(newSql);
      db.exec("INSERT INTO soal_new SELECT * FROM soal;");
      db.exec("DROP TABLE soal;");
      db.exec("ALTER TABLE soal_new RENAME TO soal;");
      db.exec('PRAGMA foreign_keys = ON;');
    }
  } catch (e) {
    console.warn('⚠️ Notice migration check constraint soal koding_game:', e.message);
  }

  try {
    const bankSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bank_soal'").get()?.sql;
    if (bankSql && !bankSql.includes("'koding_game'")) {
      db.exec('PRAGMA foreign_keys = OFF;');
      let newBankSql = bankSql;
      if (newBankSql.includes("jenis IN ('isian', 'essay', 'pilihan_ganda')")) {
        newBankSql = newBankSql.replace("jenis IN ('isian', 'essay', 'pilihan_ganda')", "jenis IN ('isian', 'essay', 'pilihan_ganda', 'koding_game')");
      } else if (newBankSql.includes("jenis IN ('isian', 'essay')")) {
        newBankSql = newBankSql.replace("jenis IN ('isian', 'essay')", "jenis IN ('isian', 'essay', 'pilihan_ganda', 'koding_game')");
      }
      newBankSql = newBankSql.replace("CREATE TABLE bank_soal (", "CREATE TABLE bank_soal_new (")
                             .replace('CREATE TABLE "bank_soal" (', 'CREATE TABLE "bank_soal_new" (');
      db.exec(newBankSql);
      db.exec("INSERT INTO bank_soal_new SELECT * FROM bank_soal;");
      db.exec("DROP TABLE bank_soal;");
      db.exec("ALTER TABLE bank_soal_new RENAME TO bank_soal;");
      db.exec('PRAGMA foreign_keys = ON;');
    }
  } catch (e) {
    console.warn('⚠️ Notice migration check constraint bank_soal koding_game:', e.message);
  }

  // Tambahkan UNIQUE index agar tidak akan pernah ada duplikasi butir soal per pengerjaan
  if (!existingObjects.has('idx_jawaban_pengerjaan_soal')) {
    try {
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_jawaban_pengerjaan_soal ON jawaban(pengerjaan_id, soal_id);");
    } catch (e) {}
  }

  // ─────────────────────────────────────────────────────────
  // OPTIMALISASI INDEX DATABASE
  // Index tambahan untuk mempercepat query yang paling sering dipanggil:
  //   - Monitor siswa sedang mengerjakan (polling setiap 10 detik saat ujian berlangsung)
  //   - Antrean AI (query FIFO yang sering dieksekusi)
  //   - Validasi kode ujian & log pengumpulan
  // ─────────────────────────────────────────────────────────
  const additionalIndexes = [
    { name: 'idx_pengerjaan_student_session_token', sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_pengerjaan_student_session_token ON pengerjaan(student_session_token) WHERE student_session_token IS NOT NULL;" },
    // Untuk query monitor siswa: WHERE ulangan_id = ? AND status = 'mengerjakan'
    { name: 'idx_pengerjaan_ulangan_status', sql: "CREATE INDEX IF NOT EXISTS idx_pengerjaan_ulangan_status ON pengerjaan(ulangan_id, status);" },
    // Untuk query last_active_at / DC detection: ORDER BY last_active_at DESC
    { name: 'idx_pengerjaan_last_active', sql: "CREATE INDEX IF NOT EXISTS idx_pengerjaan_last_active ON pengerjaan(ulangan_id, last_active_at);" },
    // Untuk query log pengumpulan: WHERE ulangan_id = ? AND status = 'submitted' ORDER BY submitted_at
    { name: 'idx_pengerjaan_submitted_at', sql: "CREATE INDEX IF NOT EXISTS idx_pengerjaan_submitted_at ON pengerjaan(ulangan_id, submitted_at);" },
    // Untuk antrean AI: WHERE status = 'menunggu' ORDER BY locked_at
    { name: 'idx_antrean_status_locked', sql: "CREATE INDEX IF NOT EXISTS idx_antrean_status_locked ON antrean_review(status, locked_at);" },
    // Untuk validasi ulangan: WHERE kode_ujian = ? (sangat sering dipanggil saat siswa masuk)
    { name: 'idx_ulangan_kode_ujian', sql: "CREATE INDEX IF NOT EXISTS idx_ulangan_kode_ujian ON ulangan(kode_ujian);" },
    // Untuk query daftar ulangan guru: WHERE guru_id = ? ORDER BY created_at
    { name: 'idx_ulangan_guru_id', sql: "CREATE INDEX IF NOT EXISTS idx_ulangan_guru_id ON ulangan(guru_id, created_at);" },
    // Untuk query soal ujian: WHERE ulangan_id = ? ORDER BY urutan
    { name: 'idx_soal_ulangan_urutan', sql: "CREATE INDEX IF NOT EXISTS idx_soal_ulangan_urutan ON soal(ulangan_id, urutan);" },
    // Untuk query jawaban siswa: WHERE pengerjaan_id = ? (sering dipanggil saat submit & review)
    { name: 'idx_jawaban_pengerjaan_id', sql: "CREATE INDEX IF NOT EXISTS idx_jawaban_pengerjaan_id ON jawaban(pengerjaan_id);" },
    // Optimasi query hitung total peserta & komposisi soal per ulangan (dashboard guru)
    { name: 'idx_peserta_ulangan', sql: "CREATE INDEX IF NOT EXISTS idx_peserta_ulangan ON peserta(ulangan_id);" },
    { name: 'idx_soal_ulangan_jenis', sql: "CREATE INDEX IF NOT EXISTS idx_soal_ulangan_jenis ON soal(ulangan_id, jenis);" },
    { name: 'idx_jawaban_penilaian', sql: "CREATE INDEX IF NOT EXISTS idx_jawaban_penilaian ON jawaban(status_penilaian);" },
  ];

  for (const idx of additionalIndexes) {
    if (!existingObjects.has(idx.name)) {
      try {
        db.exec(idx.sql);
      } catch (e) {
        // Index mungkin sudah ada atau tidak kompatibel: abaikan, jangan crash server
        console.warn(`⚠️ Notice index ${idx.name}:`, e.message);
      }
    }
  }

  // Seed initial guru, admin, keys, kelas safely
  try {
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
  } catch (e) {
    console.warn('⚠️ Notice initial seed:', e.message);
  }
}

async function backupDatabaseToFile(targetPath) {
  // db.backup() hanya tersedia di better-sqlite3, tidak di libsql/Turso embedded replica.
  // Di mode Turso (Vercel), backup file langsung tidak tersedia — data sudah ada di cloud Turso.
  if (typeof db.backup !== 'function') {
    throw new Error(
      'Backup file lokal tidak tersedia di mode database cloud (Turso). ' +
      'Data kamu sudah tersimpan aman di Turso Cloud. ' +
      'Gunakan fitur export dari dashboard Turso untuk backup manual.'
    );
  }
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.warn('WAL checkpoint warning:', err.message);
  }
  await db.backup(targetPath);
  return targetPath;
}

function restoreDatabaseFromBuffer(buffer) {
  // Validasi ukuran buffer
  if (!buffer || buffer.length < 100) {
    throw new Error('File terlalu kecil atau kosong untuk database SQLite.');
  }

  const magic = buffer.slice(0, 16).toString('utf8');
  if (magic !== 'SQLite format 3\0') {
    throw new Error('Format file tidak valid. Harap unggah file SQLite database (.sqlite atau .db).');
  }

  const tempRestorePath = path.join(dataDir, `temp_restore_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.sqlite`);
  fs.writeFileSync(tempRestorePath, buffer);

  // Lazy-load BetterSqlite3 untuk verifikasi file cadangan
  // (hanya digunakan di sini untuk membaca file temp, bukan untuk koneksi utama)
  let BetterSqlite3Local;
  try {
    BetterSqlite3Local = require('better-sqlite3');
  } catch (e) {
    // Di Vercel tanpa better-sqlite3, skip verifikasi via BetterSqlite3
    BetterSqlite3Local = null;
  }

  let testTempDb;
  if (BetterSqlite3Local) {
    try {
      testTempDb = new BetterSqlite3Local(tempRestorePath, { readonly: true });
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
