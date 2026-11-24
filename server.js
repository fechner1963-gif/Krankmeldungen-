'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { openDb, ensureAdmin } = require('./src/db');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'app.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = openDb(DB_FILE);

const initialPw = ensureAdmin(db, process.env.ADMIN_PASSWORD);
if (initialPw) {
  console.log('------------------------------------------------------------');
  console.log(' Erster Start: Administrator-Konto wurde angelegt');
  console.log('   Benutzername: admin');
  console.log(`   Passwort:     ${initialPw}`);
  console.log(' Bitte nach der ersten Anmeldung das Passwort ändern.');
  console.log('------------------------------------------------------------');
}

const app = createApp(db, { secureCookie: process.env.SECURE_COOKIE === '1' });
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.listen(PORT, () => {
  console.log(`Mitarbeiterportal läuft auf http://localhost:${PORT}`);
});
