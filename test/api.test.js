'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, ensureAdmin } = require('../src/db');
const { createApp } = require('../src/app');
const { countWorkdays, isHoliday } = require('../src/holidays');

let server;
let base;

function iso(d) {
  return d.toISOString().slice(0, 10);
}
function inDays(n) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
// nächster Montag in mind. 14 Tagen, damit Urlaub in der Zukunft liegt (gleiches Jahr nicht garantiert)
function futureMonday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 14);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

class Client {
  constructor() {
    this.cookie = '';
  }
  async req(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: this.cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data };
  }
}

before(async () => {
  const db = openDb(':memory:');
  ensureAdmin(db, 'admin-pass');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('Feiertage und Arbeitstage', () => {
  assert.ok(isHoliday('2026-04-03')); // Karfreitag 2026
  assert.ok(isHoliday('2026-05-14')); // Himmelfahrt 2026
  assert.ok(isHoliday('2026-10-03'));
  // KW 52/2026: Mo 21.12. – So 27.12., 25./26. sind Feiertage
  assert.equal(countWorkdays('2026-12-21', '2026-12-27'), 4);
});

test('kompletter Ablauf: Admin legt Mitarbeiter an, Mitarbeiter stellt Anträge, Admin entscheidet', async () => {
  const admin = new Client();
  assert.equal((await admin.req('POST', '/api/login', { username: 'admin', password: 'falsch' })).status, 401);
  assert.equal((await admin.req('POST', '/api/login', { username: 'admin', password: 'admin-pass' })).status, 200);

  const created = await admin.req('POST', '/api/users', { name: 'Max Muster', username: 'max', vacation_days: 30 });
  assert.equal(created.status, 201);
  const tempPw = created.data.temp_password;

  const max = new Client();
  const login = await max.req('POST', '/api/login', { username: 'max', password: tempPw });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.must_change_password, true);
  assert.equal(
    (await max.req('POST', '/api/me/password', { old_password: tempPw, new_password: 'neues-passwort' })).status,
    200
  );

  // Mitarbeiter darf keine Admin-Funktionen nutzen
  assert.equal((await max.req('GET', '/api/users')).status, 403);

  // Krankmeldung
  const sick = await max.req('POST', '/api/requests', {
    type: 'sick',
    start_date: inDays(0),
    end_date: inDays(2),
    doctor_visit: true,
  });
  assert.equal(sick.status, 201, JSON.stringify(sick.data));
  assert.equal(sick.data.data.doctor_visit, true);

  // Urlaub (Mo–Fr)
  const mon = futureMonday();
  const fri = new Date(mon);
  fri.setUTCDate(fri.getUTCDate() + 4);
  const vac = await max.req('POST', '/api/requests', {
    type: 'vacation',
    start_date: iso(mon),
    end_date: iso(fri),
    substitute: 'Erika',
  });
  assert.equal(vac.status, 201, JSON.stringify(vac.data));
  assert.equal(vac.data.days, countWorkdays(iso(mon), iso(fri)));

  // Überschneidung wird abgelehnt
  const overlap = await max.req('POST', '/api/requests', { type: 'vacation', start_date: iso(mon), end_date: iso(mon) });
  assert.equal(overlap.status, 409);

  // Zu viel Urlaub
  const tooMuch = await max.req('POST', '/api/requests', {
    type: 'vacation',
    start_date: `${mon.getUTCFullYear()}-12-01`,
    end_date: `${mon.getUTCFullYear()}-12-31`,
  });
  assert.ok([400, 409].includes(tooMuch.status));

  // Zeitkorrektur
  const time = await max.req('POST', '/api/requests', {
    type: 'time',
    start_date: inDays(-1),
    time_start: '08:00',
    time_end: '16:30',
    break_minutes: 30,
    note: 'Stempeluhr defekt',
  });
  assert.equal(time.status, 201, JSON.stringify(time.data));
  assert.equal(time.data.data.worked_minutes, 480);

  const noReason = await max.req('POST', '/api/requests', {
    type: 'time',
    start_date: inDays(-1),
    time_start: '08:00',
    time_end: '16:00',
  });
  assert.equal(noReason.status, 400);

  // Admin sieht offene Anträge und genehmigt den Urlaub
  const pending = await admin.req('GET', '/api/requests?all=1&status=pending');
  assert.equal(pending.data.length, 3);
  const dec = await admin.req('POST', `/api/requests/${vac.data.id}/decide`, { status: 'approved', comment: 'Viel Spaß' });
  assert.equal(dec.status, 200);
  assert.equal(dec.data.status, 'approved');
  assert.equal(dec.data.decided_by_name, 'Administrator');

  // Zweite Entscheidung nicht möglich
  assert.equal((await admin.req('POST', `/api/requests/${vac.data.id}/decide`, { status: 'rejected' })).status, 400);

  // Mitarbeiter sieht nur eigene Anträge
  const mine = await max.req('GET', '/api/requests?all=1');
  assert.equal(mine.data.length, 3);
  assert.ok(mine.data.every((r) => r.user_id === login.data.user.id));

  // Zeitkorrektur stornieren
  const cancel = await max.req('POST', `/api/requests/${time.data.id}/cancel`, {});
  assert.equal(cancel.data.status, 'cancelled');

  // Abwesenheiten heute enthalten die Krankmeldung
  const abs = await admin.req('GET', `/api/absences?from=${inDays(0)}&to=${inDays(0)}`);
  assert.ok(abs.data.some((r) => r.id === sick.data.id));

  // CSV-Export
  const csv = await admin.req('GET', `/api/export.csv?year=${inDays(0).slice(0, 4)}`);
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Max Muster/);

  // Deaktivierter Mitarbeiter kann sich nicht anmelden
  await admin.req('PATCH', `/api/users/${login.data.user.id}`, { active: false });
  assert.equal((await new Client().req('POST', '/api/login', { username: 'max', password: 'neues-passwort' })).status, 401);
});

test('schreibende Anfragen ohne JSON werden abgewiesen (CSRF-Schutz)', async () => {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=admin-pass',
  });
  assert.equal(res.status, 415);
});
