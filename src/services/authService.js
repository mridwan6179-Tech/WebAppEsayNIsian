const crypto = require('crypto');
const db = require('../config/database');
require('dotenv').config();

// In-memory or database token store for sessions
const activeSessions = new Map();

const authService = {
  // Login Guru (Mendukung kredensial dari database guru maupun fallback env & Remember Me)
  login(email, password, rememberMe = false) {
    const cleanEmail = (email || '').trim();
    const cleanPassword = (password || '').trim();

    const envEmail = process.env.TEACHER_EMAIL || 'guru@sekolah.id';
    const envPassword = process.env.TEACHER_PASSWORD || 'guru123';

    let guru = db.prepare('SELECT id, email, nama, password, no_wa FROM guru WHERE LOWER(email) = LOWER(?)').get(cleanEmail);

    let isValid = false;
    if (guru) {
      if (guru.password && guru.password === cleanPassword) {
        isValid = true;
      } else if (!guru.password && cleanEmail.toLowerCase() === envEmail.toLowerCase() && cleanPassword === envPassword) {
        isValid = true;
        db.prepare('UPDATE guru SET password = ? WHERE id = ?').run(cleanPassword, guru.id);
      }
    } else if (cleanEmail.toLowerCase() === envEmail.toLowerCase() && cleanPassword === envPassword) {
      // Auto-create teacher if env matches
      const info = db.prepare('INSERT INTO guru (email, nama, password, no_wa) VALUES (?, ?, ?, ?)').run(envEmail, process.env.TEACHER_NAME || 'Guru Pengampu', envPassword, process.env.TEACHER_WA || '081234567890');
      guru = { id: info.lastInsertRowid, email: envEmail, nama: process.env.TEACHER_NAME || 'Guru Pengampu', no_wa: process.env.TEACHER_WA || '081234567890' };
      isValid = true;
    }

    if (!isValid || !guru) {
      return { success: false, message: 'Email atau password guru salah' };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const isRemember = Boolean(rememberMe);
    const duration = isRemember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000; // 30 hari atau 24 jam
    const expiresAt = Date.now() + duration;

    activeSessions.set(token, {
      guruId: guru.id,
      email: guru.email,
      nama: guru.nama,
      no_wa: guru.no_wa || '',
      role: 'guru',
      rememberMe: isRemember,
      expiresAt
    });

    return {
      success: true,
      token,
      rememberMe: isRemember,
      expiresInDays: isRemember ? 30 : 1,
      guru: { id: guru.id, email: guru.email, nama: guru.nama, no_wa: guru.no_wa || '' }
    };
  },

  // Login Admin (Mendukung Remember Me)
  loginAdmin(username, password, rememberMe = false) {
    const cleanUser = (username || '').trim();
    const cleanPass = (password || '').trim();

    const envAdminUser = process.env.ADMIN_USERNAME || 'admin';
    const envAdminPass = process.env.ADMIN_PASSWORD || 'admin123';

    let admin = db.prepare('SELECT id, username, password, nama FROM admin WHERE LOWER(username) = LOWER(?)').get(cleanUser);

    let isValid = false;
    if (admin) {
      if (admin.password === cleanPass) {
        isValid = true;
      }
    } else if (cleanUser.toLowerCase() === envAdminUser.toLowerCase() && cleanPass === envAdminPass) {
      const info = db.prepare('INSERT INTO admin (username, password, nama) VALUES (?, ?, ?)').run(envAdminUser, envAdminPass, process.env.ADMIN_NAME || 'Administrator');
      admin = { id: info.lastInsertRowid, username: envAdminUser, nama: process.env.ADMIN_NAME || 'Administrator' };
      isValid = true;
    }

    if (!isValid || !admin) {
      return { success: false, message: 'Username atau password admin salah' };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const isRemember = Boolean(rememberMe);
    const duration = isRemember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const expiresAt = Date.now() + duration;

    activeSessions.set(token, {
      adminId: admin.id,
      username: admin.username,
      nama: admin.nama,
      role: 'admin',
      rememberMe: isRemember,
      expiresAt
    });

    return {
      success: true,
      token,
      rememberMe: isRemember,
      expiresInDays: isRemember ? 30 : 1,
      admin: { id: admin.id, username: admin.username, nama: admin.nama }
    };
  },

  verifyToken(token) {
    if (!token) return null;
    const session = activeSessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      activeSessions.delete(token);
      return null;
    }
    return session;
  },

  logout(token) {
    if (token) {
      activeSessions.delete(token);
    }
    return true;
  },

  authMiddleware(req, res, next) {
    const token = req.cookies?.auth_token || req.headers['authorization']?.replace('Bearer ', '');
    const session = authService.verifyToken(token);

    if (!session || (session.role !== 'guru' && session.role !== 'admin')) {
      return res.status(401).json({
        success: false,
        message: 'Akses ditolak. Silakan login terlebih dahulu.'
      });
    }

    req.guru = session;
    next();
  },

  adminAuthMiddleware(req, res, next) {
    const token = req.cookies?.admin_token || req.cookies?.auth_token || req.headers['authorization']?.replace('Bearer ', '');
    const session = authService.verifyToken(token);

    if (!session || session.role !== 'admin') {
      return res.status(401).json({
        success: false,
        message: 'Akses ditolak. Khusus akun Administrator.'
      });
    }

    req.admin = session;
    next();
  },

  getGuruProfile(guruId) {
    const guru = db.prepare('SELECT id, email, nama, no_wa, created_at FROM guru WHERE id = ?').get(guruId);
    if (!guru) throw new Error('Guru tidak ditemukan');
    return guru;
  },

  updateGuruProfile(guruId, data) {
    const guru = db.prepare('SELECT id FROM guru WHERE id = ?').get(guruId);
    if (!guru) throw new Error('Guru tidak ditemukan');

    const { nama, no_wa, password } = data;
    const updates = [];
    const params = [];

    if (nama !== undefined && String(nama).trim()) {
      updates.push('nama = ?');
      params.push(String(nama).trim());
    }
    if (no_wa !== undefined) {
      updates.push('no_wa = ?');
      params.push(no_wa ? String(no_wa).trim() : null);
    }
    if (password !== undefined && String(password).trim()) {
      updates.push('password = ?');
      params.push(String(password).trim());
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(guruId);
      db.prepare(`UPDATE guru SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    return this.getGuruProfile(guruId);
  }
};

module.exports = authService;
