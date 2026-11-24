'use strict';

// Bundesweite gesetzliche Feiertage in Deutschland.
// Landesspezifische Feiertage können über die Umgebungsvariable EXTRA_HOLIDAYS
// ergänzt werden (z. B. "01-06,11-01" für Heilige Drei Könige und Allerheiligen).

function easterSunday(year) {
  // Anonymer Gregorianischer Algorithmus (Meeus/Jones/Butcher)
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

const cache = new Map();

function holidays(year) {
  if (cache.has(year)) return cache.get(year);
  const easter = easterSunday(year);
  const list = [
    [`${year}-01-01`, 'Neujahr'],
    [iso(addDays(easter, -2)), 'Karfreitag'],
    [iso(addDays(easter, 1)), 'Ostermontag'],
    [`${year}-05-01`, 'Tag der Arbeit'],
    [iso(addDays(easter, 39)), 'Christi Himmelfahrt'],
    [iso(addDays(easter, 50)), 'Pfingstmontag'],
    [`${year}-10-03`, 'Tag der Deutschen Einheit'],
    [`${year}-12-25`, '1. Weihnachtstag'],
    [`${year}-12-26`, '2. Weihnachtstag'],
  ];
  const extra = (process.env.EXTRA_HOLIDAYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{2}-\d{2}$/.test(s));
  for (const md of extra) list.push([`${year}-${md}`, 'Feiertag']);
  const map = new Map(list);
  cache.set(year, map);
  return map;
}

function isHoliday(dateStr) {
  return holidays(Number(dateStr.slice(0, 4))).has(dateStr);
}

/** Zählt Arbeitstage (Mo–Fr ohne Feiertage) zwischen zwei ISO-Daten inklusive. */
function countWorkdays(start, end) {
  let d = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  let n = 0;
  while (d <= last) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && !isHoliday(iso(d))) n++;
    d = addDays(d, 1);
  }
  return n;
}

module.exports = { holidays, isHoliday, countWorkdays };
