# Mitarbeiterportal – Krankmeldung, Urlaub & Zeitkorrektur

Eine Web-App, über die sich Mitarbeiter selbst **krank melden**, **Urlaub beantragen** und
**Zeitkorrekturen beantragen** können. Vorgesetzte oder die Personalabteilung bearbeiten die Anträge
an einer zentralen Stelle. Die App funktioniert im Browser auf PC, Tablet und Smartphone.

## Funktionen

**Für Mitarbeiter**
- **Krank melden**: Zeitraum (bis zu 30 Tage rückwirkend), Angabe zu Arztbesuch/eAU oder Kinderkrankentagen, Bemerkung
- **Urlaub beantragen**: zählt die Arbeitstage automatisch (Mo–Fr ohne bundesweite Feiertage), zeigt den Resturlaub an und
  prüft, ob genug Urlaub übrig ist und ob sich der Antrag mit anderen Einträgen überschneidet
- **Zeitkorrektur**: Datum, Kommen/Gehen, Pause, Grund; berechnet die Arbeitszeit und weist auf ArbZG-Pausen hin
- Übersicht über eigene Anträge mit Status, Resturlaub und Krankheitstagen; offene Anträge lassen sich stornieren
- Eigenes Passwort ändern (wird beim ersten Login verlangt)

**Für Administratoren / Vorgesetzte**
- Posteingang mit allen Anträgen, filterbar nach Status, Art und Mitarbeiter
- Anträge genehmigen oder ablehnen, mit Kommentar an den Mitarbeiter
- Abwesenheitsübersicht: wer ist heute oder in einem Zeitraum krank oder im Urlaub
- Mitarbeiter anlegen, bearbeiten und deaktivieren, Urlaubsanspruch festlegen, Passwort zurücksetzen
- CSV-Export pro Jahr (öffnet direkt in Excel)

## Installation & Start

Voraussetzung: **Node.js 22.13 oder neuer** (keine weitere Datenbank nötig, die Daten liegen in einer SQLite-Datei).

```bash
npm install
npm start
```

Danach im Browser `http://localhost:3000` öffnen. Beim **ersten Start** wird ein Administrator angelegt.
Benutzername und Startpasswort stehen in der Konsole. Alternativ kann das Startpasswort mit
`ADMIN_PASSWORD=... npm start` vorgegeben werden.

Danach im Menü **Mitarbeiter** die Mitarbeiter anlegen. Die App zeigt für jeden Mitarbeiter ein einmaliges
Startpasswort an, das bei der ersten Anmeldung geändert werden muss.

### Einstellungen (Umgebungsvariablen)

| Variable          | Bedeutung                                                                 | Standard        |
|-------------------|---------------------------------------------------------------------------|-----------------|
| `PORT`            | Port des Webservers                                                       | `3000`          |
| `DB_FILE`         | Pfad der Datenbankdatei                                                   | `data/app.db`   |
| `ADMIN_PASSWORD`  | Startpasswort des Admins (nur beim allerersten Start)                     | zufällig        |
| `EXTRA_HOLIDAYS`  | Zusätzliche Feiertage des Bundeslands als `MM-TT`, kommagetrennt          | –               |
| `SECURE_COOKIE`   | `1` setzen, wenn die App über HTTPS läuft                                 | aus             |
| `TRUST_PROXY`     | `1` setzen, wenn die App hinter einem Reverse Proxy (nginx o. Ä.) läuft   | aus             |

Beispiel für Bayern: `EXTRA_HOLIDAYS=01-06,08-15,11-01`, für NRW: `EXTRA_HOLIDAYS=11-01`.
Fronleichnam (bewegliches Datum) bitte jährlich ergänzen oder im Code (`src/holidays.js`) hinterlegen.

### Betrieb im Unternehmen

- Für den Zugriff von außen (z. B. vom Smartphone zu Hause) die App auf einem Server hinter einem
  HTTPS-Reverse-Proxy betreiben und `SECURE_COOKIE=1` sowie `TRUST_PROXY=1` setzen.
- **Backup**: regelmäßig die Datei `data/app.db` sichern.
- **Datenschutz**: Krankmeldungen sind Gesundheitsdaten (Art. 9 DSGVO). Zugriff haben nur Admins.
  Mitarbeiter werden im Formular darauf hingewiesen, **keine Diagnosen** einzutragen.

## Tests

```bash
npm test
```

## Aufbau

```
server.js          Startpunkt (Konfiguration, erster Admin)
src/app.js         REST-API (Express): Login, Anträge, Mitarbeiter, Export
src/db.js          SQLite-Schema, Passwort-Hashing (scrypt)
src/holidays.js    Feiertage & Arbeitstage
public/            Oberfläche (HTML/CSS/JavaScript ohne Build-Schritt)
test/              API-Tests
```
