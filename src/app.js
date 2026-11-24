'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { hashPassword, verifyPassword } = require('./db');
const { holidays, countWorkdays } = require('./holidays');

const SESSION_DAYS = 14;
const COOKIE = 'sid';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TYPES = ['sick', 'vacation', 'time'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function today() {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

function str(v, max = 1000) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    email: u.email || '',
    role: u.role,
    vacation_days: u.vacation_days,
    must_change_password: !!u.must_change_password,
    active: !!u.active,
  };
}

function rowToRequest(r) {
  return {
    id: r.id,
    user_id: r.user_id,
    user_name: r.user_name,
    type: r.type,
    start_date: r.start_date,
    end_date: r.end_date,
    days: r.days,
    data: JSON.parse(r.data || '{}'),
    note: r.note,
    status: r.status,
    admin_comment: r.admin_comment,
    decided_by_name: r.decided_by_name || null,
    decided_at: r.decided_at,
    created_at: r.created_at,
  };
}

function createApp(db, opts = {}) {
  const app = express();
  const secureCookie = !!opts.secureCookie;
  const loginAttempts = new Map(); // key -> {count, until}

  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:"
    );
    next();
  });

  // --- Sitzung -------------------------------------------------------------
  const q = {
    session: db.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`
    ),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  };

  app.use((req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.user = token ? q.session.get(token, Date.now()) || null : null;
    req.token = token;
    next();
  });

  // Schutz vor CSRF: schreibende API-Aufrufe müssen JSON senden
  // (Formulare fremder Seiten können das nicht) und vom selben Origin stammen.
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (!req.is('application/json')) return next(new HttpError(415, 'JSON erwartet'));
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) {
        return next(new HttpError(403, 'Ungültiger Ursprung'));
      }
    }
    next();
  });

  function requireUser(req, res, next) {
    if (!req.user) return next(new HttpError(401, 'Bitte anmelden'));
    next();
  }
  function requireAdmin(req, res, next) {
    if (!req.user) return next(new HttpError(401, 'Bitte anmelden'));
    if (req.user.role !== 'admin') return next(new HttpError(403, 'Keine Berechtigung'));
    next();
  }

  function setSessionCookie(res, token, maxAgeSec) {
    const parts = [
      `${COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSec}`,
    ];
    if (secureCookie) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  // --- Authentifizierung ---------------------------------------------------
  app.post('/api/login', (req, res, next) => {
    const username = str(req.body.username, 100).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const key = `${req.ip}|${username}`;
    const att = loginAttempts.get(key);
    if (att && att.until > Date.now()) {
      return next(new HttpError(429, 'Zu viele Fehlversuche. Bitte in einigen Minuten erneut versuchen.'));
    }
    const user = q.userByName.get(username);
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      const count = (att?.count || 0) + 1;
      loginAttempts.set(key, { count, until: count >= 5 ? Date.now() + 5 * 60000 : 0 });
      return next(new HttpError(401, 'Benutzername oder Passwort falsch'));
    }
    loginAttempts.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
      token,
      user.id,
      Date.now() + SESSION_DAYS * 86400000
    );
    setSessionCookie(res, token, SESSION_DAYS * 86400);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/logout', (req, res) => {
    if (req.token) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    setSessionCookie(res, '', 0);
    res.json({ ok: true });
  });

  function balance(userId, year) {
    const u = q.userById.get(userId);
    const sum = (status) =>
      db
        .prepare(
          `SELECT COALESCE(SUM(days),0) AS n FROM requests
           WHERE user_id = ? AND type = 'vacation' AND status = ? AND substr(start_date,1,4) = ?`
        )
        .get(userId, status, String(year)).n;
    const approved = sum('approved');
    const pending = sum('pending');
    const sickDays = db
      .prepare(
        `SELECT COALESCE(SUM(days),0) AS n FROM requests
         WHERE user_id = ? AND type = 'sick' AND status IN ('pending','approved')
           AND substr(start_date,1,4) = ?`
      )
      .get(userId, String(year)).n;
    return {
      year,
      entitlement: u.vacation_days,
      approved,
      pending,
      remaining: u.vacation_days - approved,
      sick_days: sickDays,
    };
  }

  app.get('/api/me', requireUser, (req, res) => {
    const year = Number(req.query.year) || Number(today().slice(0, 4));
    res.json({ user: publicUser(req.user), balance: balance(req.user.id, year), today: today() });
  });

  app.post('/api/me/password', requireUser, (req, res, next) => {
    const oldPw = typeof req.body.old_password === 'string' ? req.body.old_password : '';
    const newPw = typeof req.body.new_password === 'string' ? req.body.new_password : '';
    if (!verifyPassword(oldPw, req.user.password_hash)) {
      return next(new HttpError(400, 'Aktuelles Passwort ist falsch'));
    }
    if (newPw.length < 8) return next(new HttpError(400, 'Das neue Passwort muss mindestens 8 Zeichen haben'));
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(
      hashPassword(newPw),
      req.user.id
    );
    // Andere Sitzungen abmelden
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.token);
    res.json({ ok: true });
  });

  app.get('/api/holidays', requireUser, (req, res) => {
    const year = Number(req.query.year) || Number(today().slice(0, 4));
    res.json([...holidays(year)].map(([date, name]) => ({ date, name })));
  });

  app.get('/api/workdays', requireUser, (req, res, next) => {
    const { start, end } = req.query;
    if (!isValidDate(start) || !isValidDate(end) || end < start) {
      return next(new HttpError(400, 'Ungültiger Zeitraum'));
    }
    res.json({ days: countWorkdays(start, end) });
  });

  // --- Anträge -------------------------------------------------------------
  const SELECT_REQ = `
    SELECT r.*, u.name AS user_name, d.name AS decided_by_name
    FROM requests r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN users d ON d.id = r.decided_by`;

  function getRequest(id) {
    const row = db.prepare(`${SELECT_REQ} WHERE r.id = ?`).get(id);
    return row ? rowToRequest(row) : null;
  }

  function checkOverlap(userId, start, end, excludeTypes = ['sick', 'vacation']) {
    const placeholders = excludeTypes.map(() => '?').join(',');
    return db
      .prepare(
        `SELECT type, start_date, end_date FROM requests
         WHERE user_id = ? AND type IN (${placeholders}) AND status IN ('pending','approved')
           AND start_date <= ? AND end_date >= ? LIMIT 1`
      )
      .get(userId, ...excludeTypes, end, start);
  }

  const LABEL = { sick: 'Krankmeldung', vacation: 'Urlaubsantrag', time: 'Zeitkorrektur' };

  app.get('/api/requests', requireUser, (req, res) => {
    const where = [];
    const params = [];
    const all = req.user.role === 'admin' && req.query.all === '1';
    if (!all) {
      where.push('r.user_id = ?');
      params.push(req.user.id);
    } else if (req.query.user_id) {
      where.push('r.user_id = ?');
      params.push(Number(req.query.user_id));
    }
    if (TYPES.includes(req.query.type)) {
      where.push('r.type = ?');
      params.push(req.query.type);
    }
    if (['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status)) {
      where.push('r.status = ?');
      params.push(req.query.status);
    }
    if (isValidDate(req.query.from)) {
      where.push('r.end_date >= ?');
      params.push(req.query.from);
    }
    if (isValidDate(req.query.to)) {
      where.push('r.start_date <= ?');
      params.push(req.query.to);
    }
    const sql = `${SELECT_REQ} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY r.start_date DESC, r.id DESC LIMIT 1000`;
    res.json(db.prepare(sql).all(...params).map(rowToRequest));
  });

  app.post('/api/requests', requireUser, (req, res, next) => {
    const b = req.body || {};
    const type = b.type;
    if (!TYPES.includes(type)) return next(new HttpError(400, 'Unbekannte Antragsart'));
    const note = str(b.note, 2000);
    let start = b.start_date;
    let end = b.end_date || b.start_date;
    let days = 0;
    let data = {};

    if (!isValidDate(start) || !isValidDate(end)) return next(new HttpError(400, 'Bitte gültige Daten angeben'));
    if (end < start) return next(new HttpError(400, 'Das Enddatum liegt vor dem Startdatum'));

    if (type === 'sick' || type === 'vacation') {
      if (start.slice(0, 4) !== end.slice(0, 4)) {
        return next(new HttpError(400, 'Bitte Zeiträume über den Jahreswechsel getrennt eintragen'));
      }
      days = countWorkdays(start, end);
      if (days === 0) return next(new HttpError(400, 'Im gewählten Zeitraum liegen keine Arbeitstage'));
      const overlap = checkOverlap(req.user.id, start, end);
      if (overlap) {
        return next(
          new HttpError(409, `Überschneidung mit bestehender ${LABEL[overlap.type]} (${overlap.start_date} – ${overlap.end_date})`)
        );
      }
    }

    if (type === 'sick') {
      const lim = new Date(today() + 'T00:00:00Z');
      lim.setUTCDate(lim.getUTCDate() - 30);
      if (start < lim.toISOString().slice(0, 10)) {
        return next(new HttpError(400, 'Krankmeldungen können höchstens 30 Tage rückwirkend erfasst werden'));
      }
      data = { doctor_visit: !!b.doctor_visit, child_sick: !!b.child_sick };
    }

    if (type === 'vacation') {
      if (start < today()) return next(new HttpError(400, 'Urlaub kann nicht rückwirkend beantragt werden'));
      const bal = balance(req.user.id, Number(start.slice(0, 4)));
      if (days > bal.remaining - bal.pending) {
        return next(
          new HttpError(400, `Nicht genügend Resturlaub (verfügbar: ${bal.remaining - bal.pending} Tage, beantragt: ${days})`)
        );
      }
      data = { substitute: str(b.substitute, 200) };
    }

    if (type === 'time') {
      end = start;
      if (start > today()) return next(new HttpError(400, 'Zeitkorrekturen sind nur für vergangene Tage möglich'));
      const tStart = b.time_start;
      const tEnd = b.time_end;
      const brk = Number(b.break_minutes || 0);
      if (!TIME_RE.test(tStart || '') || !TIME_RE.test(tEnd || '')) {
        return next(new HttpError(400, 'Bitte Kommen- und Gehen-Zeit im Format HH:MM angeben'));
      }
      if (tEnd <= tStart) return next(new HttpError(400, 'Die Gehen-Zeit muss nach der Kommen-Zeit liegen'));
      if (!Number.isInteger(brk) || brk < 0 || brk > 600) return next(new HttpError(400, 'Ungültige Pausenzeit'));
      const [h1, m1] = tStart.split(':').map(Number);
      const [h2, m2] = tEnd.split(':').map(Number);
      const worked = h2 * 60 + m2 - (h1 * 60 + m1) - brk;
      if (worked <= 0) return next(new HttpError(400, 'Die Pause ist länger als die Arbeitszeit'));
      if (!note) return next(new HttpError(400, 'Bitte einen Grund für die Korrektur angeben'));
      data = {
        time_start: tStart,
        time_end: tEnd,
        break_minutes: brk,
        worked_minutes: worked,
        reason: str(b.reason, 100),
      };
      days = Math.round((worked / 60) * 100) / 100; // Stunden
    }

    const info = db
      .prepare(
        `INSERT INTO requests (user_id, type, start_date, end_date, days, data, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(req.user.id, type, start, end, days, JSON.stringify(data), note);
    res.status(201).json(getRequest(info.lastInsertRowid));
  });

  app.post('/api/requests/:id/cancel', requireUser, (req, res, next) => {
    const r = getRequest(Number(req.params.id));
    if (!r || (r.user_id !== req.user.id && req.user.role !== 'admin')) {
      return next(new HttpError(404, 'Antrag nicht gefunden'));
    }
    const canCancel =
      r.status === 'pending' || (r.status === 'approved' && r.type === 'vacation' && r.start_date > today());
    if (!canCancel) return next(new HttpError(400, 'Dieser Antrag kann nicht mehr storniert werden'));
    db.prepare(`UPDATE requests SET status = 'cancelled' WHERE id = ?`).run(r.id);
    res.json(getRequest(r.id));
  });

  app.post('/api/requests/:id/decide', requireAdmin, (req, res, next) => {
    const r = getRequest(Number(req.params.id));
    if (!r) return next(new HttpError(404, 'Antrag nicht gefunden'));
    const status = req.body.status;
    if (!['approved', 'rejected'].includes(status)) return next(new HttpError(400, 'Ungültiger Status'));
    if (r.status !== 'pending') return next(new HttpError(400, 'Antrag wurde bereits bearbeitet'));
    db.prepare(
      `UPDATE requests SET status = ?, admin_comment = ?, decided_by = ?, decided_at = datetime('now')
       WHERE id = ?`
    ).run(status, str(req.body.comment, 1000), req.user.id, r.id);
    res.json(getRequest(r.id));
  });

  // --- Mitarbeiterverwaltung ----------------------------------------------
  app.get('/api/users', requireAdmin, (req, res) => {
    const year = Number(today().slice(0, 4));
    const users = db.prepare('SELECT * FROM users ORDER BY active DESC, name').all();
    res.json(users.map((u) => ({ ...publicUser(u), balance: balance(u.id, year) })));
  });

  function tempPassword() {
    return crypto.randomBytes(6).toString('base64url');
  }

  app.post('/api/users', requireAdmin, (req, res, next) => {
    const username = str(req.body.username, 50).toLowerCase();
    const name = str(req.body.name, 100);
    if (!/^[a-z0-9._-]{2,50}$/.test(username)) {
      return next(new HttpError(400, 'Benutzername: 2–50 Zeichen, nur a–z, 0–9, Punkt, Binde- und Unterstrich'));
    }
    if (!name) return next(new HttpError(400, 'Bitte einen Namen angeben'));
    if (q.userByName.get(username)) return next(new HttpError(409, 'Benutzername ist bereits vergeben'));
    const role = req.body.role === 'admin' ? 'admin' : 'employee';
    const vacation = Number(req.body.vacation_days ?? 30);
    if (!(vacation >= 0 && vacation <= 100)) return next(new HttpError(400, 'Ungültiger Urlaubsanspruch'));
    const pw = tempPassword();
    const info = db
      .prepare(
        `INSERT INTO users (username, name, email, password_hash, role, vacation_days, must_change_password)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
      .run(username, name, str(req.body.email, 200), hashPassword(pw), role, vacation);
    res.status(201).json({ user: publicUser(q.userById.get(info.lastInsertRowid)), temp_password: pw });
  });

  app.patch('/api/users/:id', requireAdmin, (req, res, next) => {
    const u = q.userById.get(Number(req.params.id));
    if (!u) return next(new HttpError(404, 'Mitarbeiter nicht gefunden'));
    const b = req.body || {};
    const name = b.name !== undefined ? str(b.name, 100) : u.name;
    if (!name) return next(new HttpError(400, 'Bitte einen Namen angeben'));
    const email = b.email !== undefined ? str(b.email, 200) : u.email;
    const role = b.role !== undefined ? (b.role === 'admin' ? 'admin' : 'employee') : u.role;
    const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
    const vacation = b.vacation_days !== undefined ? Number(b.vacation_days) : u.vacation_days;
    if (!(vacation >= 0 && vacation <= 100)) return next(new HttpError(400, 'Ungültiger Urlaubsanspruch'));
    if (u.id === req.user.id && (role !== 'admin' || !active)) {
      return next(new HttpError(400, 'Sie können sich nicht selbst die Admin-Rechte entziehen oder deaktivieren'));
    }
    db.prepare('UPDATE users SET name = ?, email = ?, role = ?, active = ?, vacation_days = ? WHERE id = ?').run(
      name,
      email,
      role,
      active,
      vacation,
      u.id
    );
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    let temp_password;
    if (b.reset_password) {
      temp_password = tempPassword();
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(
        hashPassword(temp_password),
        u.id
      );
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    res.json({ user: publicUser(q.userById.get(u.id)), temp_password });
  });

  // --- Abwesenheitsübersicht & Export -------------------------------------
  app.get('/api/absences', requireAdmin, (req, res, next) => {
    const from = isValidDate(req.query.from) ? req.query.from : today();
    const to = isValidDate(req.query.to) ? req.query.to : from;
    if (to < from) return next(new HttpError(400, 'Ungültiger Zeitraum'));
    const rows = db
      .prepare(
        `${SELECT_REQ} WHERE r.type IN ('sick','vacation') AND r.status IN ('pending','approved')
         AND r.start_date <= ? AND r.end_date >= ? ORDER BY u.name, r.start_date`
      )
      .all(to, from);
    res.json(rows.map(rowToRequest));
  });

  app.get('/api/export.csv', requireAdmin, (req, res) => {
    const year = Number(req.query.year) || Number(today().slice(0, 4));
    const rows = db
      .prepare(`${SELECT_REQ} WHERE substr(r.start_date,1,4) = ? ORDER BY u.name, r.start_date`)
      .all(String(year))
      .map(rowToRequest);
    const STATUS = { pending: 'offen', approved: 'genehmigt', rejected: 'abgelehnt', cancelled: 'storniert' };
    const esc = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // Formel-Injection in Excel verhindern
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [
      ['Mitarbeiter', 'Art', 'Von', 'Bis', 'Tage/Stunden', 'Kommen', 'Gehen', 'Pause (Min)', 'Status', 'Bemerkung', 'Kommentar Admin', 'Bearbeitet von', 'Erstellt am'],
    ];
    for (const r of rows) {
      lines.push([
        r.user_name,
        LABEL[r.type],
        r.start_date,
        r.end_date,
        String(r.days).replace('.', ','),
        r.data.time_start || '',
        r.data.time_end || '',
        r.data.break_minutes ?? '',
        STATUS[r.status],
        r.note,
        r.admin_comment,
        r.decided_by_name || '',
        r.created_at,
      ]);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="abwesenheiten-${year}.csv"`);
    res.send('﻿' + lines.map((l) => l.map(esc).join(';')).join('\r\n'));
  });

  // --- Statische Dateien & Fehler -----------------------------------------
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Nicht gefunden')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Interner Fehler' : err.message });
  });

  return app;
}

module.exports = { createApp };
