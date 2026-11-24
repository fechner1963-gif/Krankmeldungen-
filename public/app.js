'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const main = $('#main');
  const state = { user: null, balance: null, today: null, pendingCount: 0 };

  const TYPE_LABEL = { sick: 'Krankmeldung', vacation: 'Urlaub', time: 'Zeitkorrektur' };
  const STATUS_LABEL = {
    sick: { pending: 'Gemeldet', approved: 'Bestätigt', rejected: 'Abgelehnt', cancelled: 'Storniert' },
    vacation: { pending: 'Offen', approved: 'Genehmigt', rejected: 'Abgelehnt', cancelled: 'Storniert' },
    time: { pending: 'Offen', approved: 'Genehmigt', rejected: 'Abgelehnt', cancelled: 'Storniert' },
  };
  const TIME_REASONS = [
    'Stempeln vergessen',
    'Falsch gestempelt',
    'Dienstgang / Außentermin',
    'Homeoffice',
    'Dienstreise',
    'Sonstiges',
  ];

  // ---------- Hilfsfunktionen ----------
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.slice(0, 10).split('-');
    return `${d}.${m}.${y}`;
  }
  function fmtRange(a, b) {
    return a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`;
  }
  function fmtNum(n) {
    return Number(n).toLocaleString('de-DE', { maximumFractionDigits: 2 });
  }
  function fmtMinutes(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h}:${String(m).padStart(2, '0')} h`;
  }
  function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 6000 : 3500);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* kein JSON */
    }
    if (!res.ok) {
      if (res.status === 401 && path !== '/api/login') {
        state.user = null;
        renderLogin();
      }
      const err = new Error((data && data.error) || `Fehler ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function formData(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    }
    return out;
  }

  function badge(r) {
    return `<span class="badge ${r.status}">${esc(STATUS_LABEL[r.type][r.status])}</span>`;
  }

  function detail(r) {
    const parts = [];
    if (r.type === 'sick') {
      parts.push(`${fmtNum(r.days)} Arbeitstag(e)`);
      if (r.data.doctor_visit) parts.push('Arztbesuch / eAU');
      if (r.data.child_sick) parts.push('Kind krank');
    } else if (r.type === 'vacation') {
      parts.push(`${fmtNum(r.days)} Urlaubstag(e)`);
      if (r.data.substitute) parts.push(`Vertretung: ${r.data.substitute}`);
    } else if (r.type === 'time') {
      parts.push(`${r.data.time_start}–${r.data.time_end}, Pause ${r.data.break_minutes} Min. = ${fmtMinutes(r.data.worked_minutes)}`);
      if (r.data.reason) parts.push(r.data.reason);
    }
    return parts.map(esc).join(' · ');
  }

  function openDialog(html, onSubmit) {
    const dlg = $('#dialog');
    const form = $('#dialog-form');
    form.innerHTML = html;
    dlg.showModal();
    form.onsubmit = async (e) => {
      const submitter = e.submitter;
      if (submitter && submitter.value === 'cancel') return; // schließt den Dialog
      e.preventDefault();
      try {
        const keepOpen = await onSubmit(formData(form), submitter && submitter.value);
        if (!keepOpen) dlg.close();
      } catch (err) {
        toast(err.message, true);
      }
    };
    const first = form.querySelector('input, textarea, select');
    if (first) first.focus();
  }

  // ---------- Navigation ----------
  const ROUTES = {
    home: { title: 'Übersicht', render: renderHome },
    sick: { title: 'Krank melden', render: renderSick },
    vacation: { title: 'Urlaub', render: renderVacation },
    time: { title: 'Zeitkorrektur', render: renderTime },
    inbox: { title: 'Anträge', render: renderInbox, admin: true },
    absences: { title: 'Abwesenheiten', render: renderAbsences, admin: true },
    users: { title: 'Mitarbeiter', render: renderUsers, admin: true },
    account: { title: 'Konto', render: renderAccount },
  };

  function currentRoute() {
    const r = location.hash.replace(/^#\/?/, '') || 'home';
    const route = ROUTES[r];
    if (!route || (route.admin && state.user.role !== 'admin')) return 'home';
    return r;
  }

  function renderNav() {
    const cur = currentRoute();
    $('#nav').innerHTML = Object.entries(ROUTES)
      .filter(([, r]) => !r.admin || state.user.role === 'admin')
      .map(([key, r]) => {
        const count = key === 'inbox' && state.pendingCount ? `<span class="badge-count">${state.pendingCount}</span>` : '';
        return `<a href="#/${key}" class="${key === cur ? 'active' : ''}">${esc(r.title)}${count}</a>`;
      })
      .join('');
    $('#who-name').textContent = state.user.name;
  }

  async function refreshMe() {
    const me = await api('/api/me');
    state.user = me.user;
    state.balance = me.balance;
    state.today = me.today;
    if (state.user.role === 'admin') {
      const pending = await api('/api/requests?all=1&status=pending');
      state.pendingCount = pending.length;
    }
  }

  async function route() {
    if (!state.user) return;
    if (state.user.must_change_password) return renderForcePassword();
    $('#topbar').classList.remove('hidden');
    const key = currentRoute();
    renderNav();
    document.title = `${ROUTES[key].title} – Mitarbeiterportal`;
    main.innerHTML = '<div class="empty">Lädt …</div>';
    try {
      await ROUTES[key].render();
    } catch (err) {
      if (err.status !== 401) main.innerHTML = `<div class="card">${esc(err.message)}</div>`;
    }
  }

  window.addEventListener('hashchange', route);

  // ---------- Anmeldung ----------
  function renderLogin() {
    $('#topbar').classList.add('hidden');
    document.title = 'Anmelden – Mitarbeiterportal';
    main.innerHTML = `
      <div class="login-wrap">
        <div class="brand">Mitarbeiterportal</div>
        <form class="card" id="login-form">
          <h1>Anmelden</h1>
          <label>Benutzername<input name="username" autocomplete="username" required autocapitalize="none"></label>
          <label>Passwort<input name="password" type="password" autocomplete="current-password" required></label>
          <button type="submit">Anmelden</button>
        </form>
      </div>`;
    $('#login-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/login', { method: 'POST', body: formData(e.target) });
        await refreshMe();
        if (!location.hash) location.hash = '#/home';
        route();
      } catch (err) {
        toast(err.message, true);
      }
    };
    $('#login-form input').focus();
  }

  function passwordForm(id) {
    return `
      <form class="card" id="${id}">
        <label>Aktuelles Passwort<input name="old_password" type="password" autocomplete="current-password" required></label>
        <label>Neues Passwort <span class="hint">(mind. 8 Zeichen)</span><input name="new_password" type="password" autocomplete="new-password" minlength="8" required></label>
        <label>Neues Passwort wiederholen<input name="new_password2" type="password" autocomplete="new-password" minlength="8" required></label>
        <button type="submit">Passwort ändern</button>
      </form>`;
  }

  function bindPasswordForm(form, after) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const d = formData(form);
      if (d.new_password !== d.new_password2) return toast('Die neuen Passwörter stimmen nicht überein', true);
      try {
        await api('/api/me/password', { method: 'POST', body: d });
        toast('Passwort wurde geändert');
        form.reset();
        after && after();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  function renderForcePassword() {
    $('#topbar').classList.add('hidden');
    main.innerHTML = `
      <div class="login-wrap">
        <div class="brand">Mitarbeiterportal</div>
        <h1>Willkommen, ${esc(state.user.name)}!</h1>
        <p class="lead">Bitte vergeben Sie vor der ersten Nutzung ein eigenes Passwort.</p>
        ${passwordForm('pw-form')}
      </div>`;
    bindPasswordForm($('#pw-form'), async () => {
      await refreshMe();
      route();
    });
  }

  // ---------- Übersicht ----------
  function requestTable(rows, { showUser = false, adminActions = false } = {}) {
    if (!rows.length) return '<div class="empty">Keine Einträge vorhanden.</div>';
    const today = state.today;
    const body = rows
      .map((r) => {
        const canCancel =
          !adminActions &&
          (r.status === 'pending' || (r.status === 'approved' && r.type === 'vacation' && r.start_date > today));
        const actions = adminActions
          ? r.status === 'pending'
            ? `<div class="buttons">
                 <button class="small ok" data-decide="approved" data-id="${r.id}">${r.type === 'sick' ? 'Bestätigen' : 'Genehmigen'}</button>
                 <button class="small danger" data-decide="rejected" data-id="${r.id}">Ablehnen</button>
               </div>`
            : ''
          : canCancel
            ? `<button class="small secondary" data-cancel="${r.id}">Stornieren</button>`
            : '';
        const comments = [
          r.note ? `<div class="muted">Bemerkung: ${esc(r.note)}</div>` : '',
          r.admin_comment ? `<div class="muted">Antwort: ${esc(r.admin_comment)}</div>` : '',
          r.decided_by_name ? `<div class="muted">bearbeitet von ${esc(r.decided_by_name)}, ${fmtDate(r.decided_at)}</div>` : '',
        ].join('');
        return `<tr>
          ${showUser ? `<td data-label="Mitarbeiter"><strong>${esc(r.user_name)}</strong></td>` : ''}
          <td data-label="Art"><span class="type ${r.type}">${TYPE_LABEL[r.type]}</span></td>
          <td data-label="Zeitraum">${fmtRange(r.start_date, r.end_date)}<div class="muted">eingereicht ${fmtDate(r.created_at)}</div></td>
          <td data-label="Details">${detail(r)}${comments}</td>
          <td data-label="Status">${badge(r)}</td>
          <td>${actions}</td>
        </tr>`;
      })
      .join('');
    return `<div class="table-wrap"><table class="responsive">
      <thead><tr>${showUser ? '<th>Mitarbeiter</th>' : ''}<th>Art</th><th>Zeitraum</th><th>Details</th><th>Status</th><th></th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }

  function bindRequestActions(root, reload) {
    root.querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Diesen Antrag wirklich stornieren?')) return;
        try {
          await api(`/api/requests/${btn.dataset.cancel}/cancel`, { method: 'POST', body: {} });
          toast('Antrag storniert');
          reload();
        } catch (err) {
          toast(err.message, true);
        }
      };
    });
    root.querySelectorAll('[data-decide]').forEach((btn) => {
      btn.onclick = () => {
        const approve = btn.dataset.decide === 'approved';
        openDialog(
          `<h2>${approve ? 'Antrag genehmigen' : 'Antrag ablehnen'}</h2>
           <label>Kommentar an den Mitarbeiter <span class="hint">(optional)</span>
             <textarea name="comment" maxlength="1000"></textarea></label>
           <div class="buttons">
             <button type="submit" class="${approve ? 'ok' : 'danger'}">${approve ? 'Genehmigen' : 'Ablehnen'}</button>
             <button type="submit" value="cancel" class="secondary" formnovalidate>Abbrechen</button>
           </div>`,
          async (d) => {
            await api(`/api/requests/${btn.dataset.id}/decide`, {
              method: 'POST',
              body: { status: btn.dataset.decide, comment: d.comment },
            });
            toast(approve ? 'Antrag genehmigt' : 'Antrag abgelehnt');
            await refreshMe();
            renderNav();
            reload();
          }
        );
      };
    });
  }

  async function renderHome() {
    await refreshMe();
    renderNav();
    const b = state.balance;
    const rows = await api(`/api/requests?from=${b.year}-01-01`);
    const pending = rows.filter((r) => r.status === 'pending').length;
    main.innerHTML = `
      <h1>Hallo ${esc(state.user.name)}</h1>
      <div class="actions-grid">
        <a class="action-tile sick" href="#/sick"><strong>Krank melden</strong><span>Arbeitsunfähigkeit mitteilen</span></a>
        <a class="action-tile vacation" href="#/vacation"><strong>Urlaub beantragen</strong><span>Freie Tage einreichen</span></a>
        <a class="action-tile time" href="#/time"><strong>Zeitkorrektur</strong><span>Arbeitszeit nachtragen oder berichtigen</span></a>
      </div>
      <div class="grid">
        <div class="stat"><div class="label">Resturlaub ${b.year}</div><div class="value">${fmtNum(b.remaining)}</div><div class="sub">von ${fmtNum(b.entitlement)} Tagen</div></div>
        <div class="stat"><div class="label">Urlaub beantragt (offen)</div><div class="value">${fmtNum(b.pending)}</div><div class="sub">Tage in Prüfung</div></div>
        <div class="stat"><div class="label">Krankheitstage ${b.year}</div><div class="value">${fmtNum(b.sick_days)}</div><div class="sub">Arbeitstage</div></div>
        <div class="stat"><div class="label">Offene Anträge</div><div class="value">${pending}</div><div class="sub">warten auf Bearbeitung</div></div>
      </div>
      <div class="card" id="my-requests">
        <h2>Meine Meldungen &amp; Anträge</h2>
        ${requestTable(rows)}
      </div>`;
    bindRequestActions($('#my-requests'), renderHome);
  }

  // ---------- Formulare ----------
  function bindWorkdayPreview(form, target, extra) {
    const update = async () => {
      const s = form.start_date.value;
      const e = form.end_date.value || s;
      if (!s || e < s) {
        target.textContent = e && s && e < s ? 'Das Enddatum liegt vor dem Startdatum.' : 'Bitte Zeitraum wählen.';
        return;
      }
      try {
        const { days } = await api(`/api/workdays?start=${s}&end=${e}`);
        target.textContent = `${days} Arbeitstag(e) im gewählten Zeitraum${extra ? extra(days) : ''}.`;
      } catch (err) {
        target.textContent = err.message;
      }
    };
    form.start_date.addEventListener('change', () => {
      if (!form.end_date.value || form.end_date.value < form.start_date.value) form.end_date.value = form.start_date.value;
      form.end_date.min = form.start_date.value;
      update();
    });
    form.end_date.addEventListener('change', update);
    update();
  }

  async function submitRequest(form, body, okMsg) {
    try {
      await api('/api/requests', { method: 'POST', body });
      toast(okMsg);
      location.hash = '#/home';
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function renderSick() {
    await refreshMe();
    const t = state.today;
    main.innerHTML = `
      <h1>Krank melden</h1>
      <p class="lead">Teilen Sie hier Ihre Arbeitsunfähigkeit mit. Ihre Vorgesetzten werden sofort informiert.</p>
      <form class="card" id="sick-form">
        <div class="row">
          <label>Krank seit<input type="date" name="start_date" value="${t}" min="${addDays(t, -30)}" required></label>
          <label>Voraussichtlich bis<input type="date" name="end_date" value="${t}" min="${t}" required></label>
        </div>
        <div class="info" id="sick-days"></div>
        <label class="check"><input type="checkbox" name="doctor_visit"> Ich war / gehe beim Arzt (elektronische AU-Bescheinigung)</label>
        <label class="check"><input type="checkbox" name="child_sick"> Krankheit des Kindes (Kinderkrankentage)</label>
        <label>Bemerkung <span class="hint">(optional – keine Diagnose angeben)</span>
          <textarea name="note" maxlength="2000" placeholder="z. B. Übergabe offener Aufgaben, Erreichbarkeit"></textarea></label>
        <div class="info">Hinweis: Ab dem 4. Kalendertag (oder früher, falls vereinbart) ist eine ärztliche Bescheinigung erforderlich.
          Bei Verlängerung bitte eine neue Krankmeldung ab dem Folgetag einreichen.</div>
        <button type="submit">Krankmeldung absenden</button>
      </form>`;
    const form = $('#sick-form');
    bindWorkdayPreview(form, $('#sick-days'));
    form.onsubmit = (e) => {
      e.preventDefault();
      submitRequest(form, { type: 'sick', ...formData(form) }, 'Krankmeldung wurde übermittelt. Gute Besserung!');
    };
  }

  async function renderVacation() {
    await refreshMe();
    const b = state.balance;
    const t = state.today;
    const avail = b.remaining - b.pending;
    const holidays = await api(`/api/holidays?year=${b.year}`);
    main.innerHTML = `
      <h1>Urlaub beantragen</h1>
      <div class="grid">
        <div class="stat"><div class="label">Verfügbar ${b.year}</div><div class="value">${fmtNum(avail)}</div><div class="sub">Tage (Resturlaub abzgl. offener Anträge)</div></div>
        <div class="stat"><div class="label">Genehmigt</div><div class="value">${fmtNum(b.approved)}</div><div class="sub">von ${fmtNum(b.entitlement)} Tagen</div></div>
      </div>
      <br>
      <form class="card" id="vac-form">
        <div class="row">
          <label>Erster Urlaubstag<input type="date" name="start_date" min="${t}" required></label>
          <label>Letzter Urlaubstag<input type="date" name="end_date" min="${t}" required></label>
        </div>
        <div class="info" id="vac-days"></div>
        <label>Vertretung <span class="hint">(optional)</span><input name="substitute" maxlength="200"></label>
        <label>Bemerkung <span class="hint">(optional)</span><textarea name="note" maxlength="2000"></textarea></label>
        <button type="submit">Urlaub beantragen</button>
      </form>
      <div class="card">
        <h2>Feiertage ${b.year} <span class="muted">(werden nicht als Urlaubstage gezählt)</span></h2>
        <div class="muted">${holidays.map((h) => `${fmtDate(h.date)} ${esc(h.name)}`).join(' · ')}</div>
      </div>`;
    const form = $('#vac-form');
    bindWorkdayPreview(form, $('#vac-days'), (days) =>
      days > avail ? ` – mehr als verfügbar (${fmtNum(avail)})` : ` – danach verbleiben ${fmtNum(avail - days)} Tage`
    );
    form.onsubmit = (e) => {
      e.preventDefault();
      submitRequest(form, { type: 'vacation', ...formData(form) }, 'Urlaubsantrag wurde eingereicht');
    };
  }

  async function renderTime() {
    await refreshMe();
    const t = state.today;
    main.innerHTML = `
      <h1>Zeitkorrektur beantragen</h1>
      <p class="lead">Fehlende oder falsche Buchungen nachtragen. Die Korrektur wird nach Genehmigung übernommen.</p>
      <form class="card" id="time-form">
        <div class="row">
          <label>Datum<input type="date" name="start_date" value="${t}" max="${t}" required></label>
          <label>Grund<select name="reason">${TIME_REASONS.map((r) => `<option>${esc(r)}</option>`).join('')}</select></label>
        </div>
        <div class="row">
          <label>Kommen<input type="time" name="time_start" value="08:00" required></label>
          <label>Gehen<input type="time" name="time_end" value="16:30" required></label>
          <label>Pause (Minuten)<input type="number" name="break_minutes" value="30" min="0" max="600" step="5" required></label>
        </div>
        <div class="info" id="time-sum"></div>
        <label>Begründung<textarea name="note" maxlength="2000" required placeholder="Was soll korrigiert werden und warum?"></textarea></label>
        <button type="submit">Korrektur beantragen</button>
      </form>`;
    const form = $('#time-form');
    const sum = $('#time-sum');
    const update = () => {
      const [h1, m1] = form.time_start.value.split(':').map(Number);
      const [h2, m2] = form.time_end.value.split(':').map(Number);
      const worked = h2 * 60 + m2 - (h1 * 60 + m1) - Number(form.break_minutes.value || 0);
      sum.textContent = Number.isFinite(worked) && worked > 0 ? `Arbeitszeit: ${fmtMinutes(worked)}` : 'Bitte gültige Zeiten eingeben.';
      sum.classList.toggle('warn', worked > 600);
      if (worked > 600) sum.textContent += ' – Achtung: mehr als 10 Stunden (ArbZG)';
      else if (worked > 360 && Number(form.break_minutes.value) < (worked > 540 ? 45 : 30)) {
        sum.classList.add('warn');
        sum.textContent += ' – Hinweis: gesetzliche Mindestpause beachten (30 Min. ab 6 h, 45 Min. ab 9 h)';
      }
    };
    ['time_start', 'time_end', 'break_minutes'].forEach((n) => form[n].addEventListener('input', update));
    update();
    form.onsubmit = (e) => {
      e.preventDefault();
      const d = formData(form);
      d.break_minutes = Number(d.break_minutes);
      submitRequest(form, { type: 'time', ...d }, 'Zeitkorrektur wurde eingereicht');
    };
  }

  // ---------- Admin: Anträge ----------
  const inboxFilter = { status: 'pending', type: '', user_id: '' };

  async function renderInbox() {
    const users = await api('/api/users');
    const qs = new URLSearchParams({ all: '1' });
    for (const [k, v] of Object.entries(inboxFilter)) if (v) qs.set(k, v);
    const rows = await api(`/api/requests?${qs}`);
    const opt = (val, label, cur) => `<option value="${esc(val)}" ${String(cur) === String(val) ? 'selected' : ''}>${esc(label)}</option>`;
    main.innerHTML = `
      <h1>Anträge bearbeiten</h1>
      <div class="card" id="inbox">
        <div class="filters">
          <label>Status<select id="f-status">
            ${opt('', 'Alle', inboxFilter.status)}${opt('pending', 'Offen', inboxFilter.status)}
            ${opt('approved', 'Genehmigt / bestätigt', inboxFilter.status)}${opt('rejected', 'Abgelehnt', inboxFilter.status)}
            ${opt('cancelled', 'Storniert', inboxFilter.status)}</select></label>
          <label>Art<select id="f-type">
            ${opt('', 'Alle', inboxFilter.type)}${opt('sick', 'Krankmeldung', inboxFilter.type)}
            ${opt('vacation', 'Urlaub', inboxFilter.type)}${opt('time', 'Zeitkorrektur', inboxFilter.type)}</select></label>
          <label>Mitarbeiter<select id="f-user">${opt('', 'Alle', inboxFilter.user_id)}
            ${users.map((u) => opt(u.id, u.name, inboxFilter.user_id)).join('')}</select></label>
          <a class="btn secondary" href="/api/export.csv?year=${state.today.slice(0, 4)}">CSV-Export ${state.today.slice(0, 4)}</a>
        </div>
        ${requestTable(rows, { showUser: true, adminActions: true })}
      </div>`;
    const bind = (id, key) => {
      $(id).onchange = (e) => {
        inboxFilter[key] = e.target.value;
        renderInbox();
      };
    };
    bind('#f-status', 'status');
    bind('#f-type', 'type');
    bind('#f-user', 'user_id');
    bindRequestActions($('#inbox'), renderInbox);
  }

  // ---------- Admin: Abwesenheiten ----------
  const absRange = { from: null, to: null };

  async function renderAbsences() {
    const t = state.today;
    if (!absRange.from) {
      const d = new Date(t + 'T00:00:00Z');
      const monday = addDays(t, -((d.getUTCDay() + 6) % 7));
      absRange.from = monday;
      absRange.to = addDays(monday, 13);
    }
    const [todayRows, rows] = await Promise.all([
      api(`/api/absences?from=${t}&to=${t}`),
      api(`/api/absences?from=${absRange.from}&to=${absRange.to}`),
    ]);
    const list = (rs) =>
      rs.length
        ? `<div class="table-wrap"><table class="responsive"><tbody>${rs
            .map(
              (r) => `<tr><td data-label="Mitarbeiter"><strong>${esc(r.user_name)}</strong></td>
                <td data-label="Art"><span class="type ${r.type}">${TYPE_LABEL[r.type]}</span></td>
                <td data-label="Zeitraum">${fmtRange(r.start_date, r.end_date)}</td>
                <td data-label="Status">${badge(r)}</td></tr>`
            )
            .join('')}</tbody></table></div>`
        : '<div class="empty">Keine Abwesenheiten.</div>';
    main.innerHTML = `
      <h1>Abwesenheiten</h1>
      <div class="card"><h2>Heute (${fmtDate(t)}) abwesend: ${todayRows.length}</h2>${list(todayRows)}</div>
      <div class="card">
        <div class="filters">
          <label>Von<input type="date" id="a-from" value="${absRange.from}"></label>
          <label>Bis<input type="date" id="a-to" value="${absRange.to}"></label>
        </div>
        ${list(rows)}
      </div>`;
    const change = () => {
      const f = $('#a-from').value;
      const to = $('#a-to').value;
      if (f && to && to >= f) {
        absRange.from = f;
        absRange.to = to;
        renderAbsences();
      }
    };
    $('#a-from').onchange = change;
    $('#a-to').onchange = change;
  }

  // ---------- Admin: Mitarbeiter ----------
  function showTempPassword(user, pw) {
    openDialog(
      `<h2>Zugangsdaten für ${esc(user.name)}</h2>
       <p>Bitte geben Sie diese Daten an den Mitarbeiter weiter. Das Passwort muss bei der ersten Anmeldung geändert werden
       und wird hier nur einmal angezeigt.</p>
       <p>Benutzername: <strong>${esc(user.username)}</strong></p>
       <div class="temp-pw">${esc(pw)}</div><br>
       <button type="submit" value="cancel">Schließen</button>`,
      async () => false
    );
  }

  async function renderUsers() {
    const users = await api('/api/users');
    main.innerHTML = `
      <h1>Mitarbeiter</h1>
      <div class="card">
        <h2>Neuen Mitarbeiter anlegen</h2>
        <form id="new-user">
          <div class="row">
            <label>Name<input name="name" required maxlength="100" placeholder="Vorname Nachname"></label>
            <label>Benutzername<input name="username" required pattern="[a-zA-Z0-9._\\-]{2,50}" placeholder="z. B. m.mueller" autocapitalize="none"></label>
            <label>E-Mail <span class="hint">(optional)</span><input name="email" type="email" maxlength="200"></label>
            <label>Urlaubstage / Jahr<input name="vacation_days" type="number" min="0" max="100" step="0.5" value="30" required></label>
            <label>Rolle<select name="role"><option value="employee">Mitarbeiter</option><option value="admin">Administrator</option></select></label>
          </div>
          <button type="submit">Anlegen</button>
        </form>
      </div>
      <div class="card">
        <div class="table-wrap"><table class="responsive">
          <thead><tr><th>Name</th><th>Benutzer</th><th>Rolle</th><th>Urlaub ${state.today.slice(0, 4)}</th><th>Krankheitstage</th><th></th></tr></thead>
          <tbody>${users
            .map(
              (u) => `<tr>
                <td data-label="Name"><strong>${esc(u.name)}</strong>${u.active ? '' : ' <span class="badge cancelled">deaktiviert</span>'}
                  ${u.email ? `<div class="muted">${esc(u.email)}</div>` : ''}</td>
                <td data-label="Benutzer">${esc(u.username)}</td>
                <td data-label="Rolle">${u.role === 'admin' ? 'Administrator' : 'Mitarbeiter'}</td>
                <td data-label="Urlaub">${fmtNum(u.balance.remaining)} von ${fmtNum(u.balance.entitlement)} übrig
                  ${u.balance.pending ? `<div class="muted">${fmtNum(u.balance.pending)} beantragt</div>` : ''}</td>
                <td data-label="Krankheitstage">${fmtNum(u.balance.sick_days)}</td>
                <td><button class="small secondary" data-edit="${u.id}">Bearbeiten</button></td>
              </tr>`
            )
            .join('')}</tbody></table></div>
      </div>`;

    const form = $('#new-user');
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const d = formData(form);
        d.vacation_days = Number(d.vacation_days);
        const res = await api('/api/users', { method: 'POST', body: d });
        await renderUsers();
        showTempPassword(res.user, res.temp_password);
      } catch (err) {
        toast(err.message, true);
      }
    };

    main.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.onclick = () => {
        const u = users.find((x) => String(x.id) === btn.dataset.edit);
        openDialog(
          `<h2>${esc(u.name)} bearbeiten</h2>
           <label>Name<input name="name" value="${esc(u.name)}" required maxlength="100"></label>
           <label>E-Mail<input name="email" type="email" value="${esc(u.email)}" maxlength="200"></label>
           <label>Urlaubstage / Jahr<input name="vacation_days" type="number" min="0" max="100" step="0.5" value="${u.vacation_days}" required></label>
           <label>Rolle<select name="role">
             <option value="employee" ${u.role === 'employee' ? 'selected' : ''}>Mitarbeiter</option>
             <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrator</option></select></label>
           <label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Konto aktiv</label>
           <div class="buttons">
             <button type="submit" value="save">Speichern</button>
             <button type="submit" value="reset" class="secondary">Passwort zurücksetzen</button>
             <button type="submit" value="cancel" class="secondary" formnovalidate>Abbrechen</button>
           </div>`,
          async (d, action) => {
            if (action === 'reset' && !confirm(`Passwort für ${u.name} wirklich zurücksetzen?`)) return true;
            d.vacation_days = Number(d.vacation_days);
            if (action === 'reset') d.reset_password = true;
            const res = await api(`/api/users/${u.id}`, { method: 'PATCH', body: d });
            await renderUsers();
            if (res.temp_password) {
              $('#dialog').close();
              showTempPassword(res.user, res.temp_password);
              return true;
            }
            toast('Gespeichert');
            return false;
          }
        );
      };
    });
  }

  // ---------- Konto ----------
  async function renderAccount() {
    main.innerHTML = `
      <h1>Mein Konto</h1>
      <div class="card">
        <div><strong>${esc(state.user.name)}</strong></div>
        <div class="muted">Benutzername: ${esc(state.user.username)} · ${state.user.role === 'admin' ? 'Administrator' : 'Mitarbeiter'}</div>
      </div>
      <h2>Passwort ändern</h2>
      ${passwordForm('pw-form')}`;
    bindPasswordForm($('#pw-form'));
  }

  // ---------- Start ----------
  $('#logout').onclick = async () => {
    try {
      await api('/api/logout', { method: 'POST', body: {} });
    } catch {
      /* ignorieren */
    }
    state.user = null;
    location.hash = '';
    renderLogin();
  };

  (async () => {
    try {
      await refreshMe();
      route();
    } catch {
      renderLogin();
    }
  })();
})();
