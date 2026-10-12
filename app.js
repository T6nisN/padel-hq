(() => {
  'use strict';

  const CFG = window.PADEL_CONFIG;
  const PLAYERS = CFG.players;
  const BY_ID = Object.fromEntries(PLAYERS.map(p => [p.id, p]));
  const CONFIGURED = Boolean(CFG.supabaseUrl && CFG.supabaseAnonKey);
  const BEERS_PER_LOSS = CFG.beersPerLoss ?? 1;

  // ---------- browser storage (can throw in private mode, so always guarded) ----------
  const ls = {
    get(k, fallback = null) {
      try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // Session = { token, player, is_admin }, issued by the database's login().
  // is_admin here only decides which buttons to show; the database enforces it.
  const SESSION_KEY = 'padelhq.session';
  const session = () => ls.get(SESSION_KEY);
  const me = () => session()?.player ?? null;
  const isAdmin = () => Boolean(session()?.is_admin);

  // ---------- Supabase REST ----------
  const api = {
    async req(path, opts = {}) {
      const res = await fetch(`${CFG.supabaseUrl.replace(/\/$/, '')}/rest/v1/${path}`, {
        ...opts,
        headers: {
          apikey: CFG.supabaseAnonKey,
          // Legacy anon keys are JWTs (eyJ…) and go in Authorization too; new sb_publishable_ keys must not.
          ...(CFG.supabaseAnonKey.startsWith('eyJ') ? { Authorization: `Bearer ${CFG.supabaseAnonKey}` } : {}),
          'Content-Type': 'application/json',
          'x-session': session()?.token ?? '',
          ...(opts.headers || {}),
        },
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    },
    rpc(fn, args = {}) { return this.req(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) }); },
  };

  const store = {
    listMatches: () => api.req('matches?select=*&order=played_at.asc,created_at.asc'),
    listSettlements: () => api.req('settlements?select=*&order=created_at.asc'),
    addMatch: m => api.req('matches', { method: 'POST', body: JSON.stringify(m) }),
    addSettlement: s => api.req('settlements', { method: 'POST', body: JSON.stringify(s) }),
    deleteMatch: id => api.req(`matches?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' }),
    deleteSettlement: id => api.req(`settlements?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };

  // ---------- funny passwords (admin resets) ----------
  const ADJ = ['sweaty', 'wobbly', 'grumpy', 'sneaky', 'crispy', 'soggy', 'turbo', 'lazy', 'spicy', 'fluffy',
    'salty', 'cheeky', 'rusty', 'jolly', 'dizzy', 'chunky', 'sleepy', 'bouncy', 'funky', 'sassy',
    'greasy', 'hairy', 'nervous', 'clumsy', 'smelly', 'moody', 'tipsy', 'fancy', 'squeaky', 'drowsy',
    'giggly', 'cranky', 'wonky', 'sloppy', 'bossy', 'toasty', 'lumpy', 'shiny', 'dramatic', 'suspicious'];
  const NOUN = ['lobster', 'bandeja', 'pickle', 'walrus', 'kebab', 'sauna', 'noodle', 'potato', 'moose', 'penguin',
    'waffle', 'burrito', 'pelican', 'meatball', 'hedgehog', 'pancake', 'avocado', 'racket', 'flamingo', 'sausage',
    'herring', 'goose', 'donut', 'pretzel', 'llama', 'turnip', 'dumpling', 'badger', 'sprat', 'beaver',
    'nacho', 'muffin', 'parsnip', 'wombat', 'trombone', 'cabbage', 'yeti', 'platypus', 'gherkin', 'kilt'];
  const rand = n => crypto.getRandomValues(new Uint32Array(1))[0] % n; // bias is negligible for n ≤ 90
  const funnyPassword = () => `${ADJ[rand(ADJ.length)]}-${NOUN[rand(NOUN.length)]}-${10 + rand(90)}`;

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const who = id => esc(BY_ID[id]?.name ?? id);
  const youOr = id => (id === me() ? 'You' : who(id));
  const team = ids => ids.map(who).join(' / ');
  // Forgiving name match: "tonis", " TÕNIS " and "Tõnis" all work.
  const norm = s => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const beers = n => `<b class="num">${n}</b> <span class="unit">${n === 1 ? 'beer' : 'beers'}</span>`;
  const fmtDate = iso => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const todayStr = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  // ---------- stats ----------
  function compute(matches, settlements) {
    const stats = Object.fromEntries(PLAYERS.map(p => [p.id, {
      id: p.id, played: 0, wins: 0, losses: 0, gf: 0, ga: 0, streak: 0, form: [], partners: {}, beersLost: 0,
    }]));
    // owed[a][b] = beers a owes b, before netting
    const owed = Object.fromEntries(PLAYERS.map(p => [p.id, Object.fromEntries(PLAYERS.map(q => [q.id, 0]))]));

    for (const m of matches) {
      const ids = [...m.team_a, ...m.team_b];
      if (!ids.every(id => stats[id])) continue; // player removed from config — skip
      const winners = m.winner === 'A' ? m.team_a : m.team_b;
      const losers = m.winner === 'A' ? m.team_b : m.team_a;
      const gA = m.sets.reduce((s, [a]) => s + a, 0);
      const gB = m.sets.reduce((s, [, b]) => s + b, 0);

      for (const id of ids) {
        const s = stats[id];
        const onA = m.team_a.includes(id);
        const won = winners.includes(id);
        const partner = (onA ? m.team_a : m.team_b).find(x => x !== id);
        s.played++;
        won ? s.wins++ : s.losses++;
        s.gf += onA ? gA : gB;
        s.ga += onA ? gB : gA;
        s.streak = won ? Math.max(s.streak, 0) + 1 : Math.min(s.streak, 0) - 1;
        s.form.push(won ? 'W' : 'L');
        s.partners[partner] ??= { played: 0, wins: 0 };
        s.partners[partner].played++;
        if (won) s.partners[partner].wins++;
      }
      for (const l of losers) for (const w of winners) {
        owed[l][w] += BEERS_PER_LOSS;
        stats[l].beersLost += BEERS_PER_LOSS;
      }
    }
    for (const s of settlements) {
      if (owed[s.from_player]?.[s.to_player] !== undefined) owed[s.from_player][s.to_player] -= s.beers;
    }

    // Net each pair once: positive means `from` owes `to`.
    const debts = [];
    for (let i = 0; i < PLAYERS.length; i++) {
      for (let j = i + 1; j < PLAYERS.length; j++) {
        const a = PLAYERS[i].id, b = PLAYERS[j].id;
        const net = owed[a][b] - owed[b][a];
        if (net > 0) debts.push({ from: a, to: b, beers: net });
        if (net < 0) debts.push({ from: b, to: a, beers: -net });
      }
    }
    debts.sort((x, y) => y.beers - x.beers);

    const table = Object.values(stats).sort((a, b) =>
      (b.played > 0) - (a.played > 0) ||
      winPct(b) - winPct(a) ||
      b.wins - a.wins ||
      (b.gf - b.ga) - (a.gf - a.ga));

    return { stats, table, debts };
  }
  const winPct = s => (s.played ? s.wins / s.played : 0);

  // ---------- state & rendering ----------
  const state = { matches: [], settlements: [], data: null, tab: ls.get('padelhq.tab', 'matches') };

  async function load() {
    try {
      [state.matches, state.settlements] = await Promise.all([store.listMatches(), store.listSettlements()]);
    } catch (e) {
      toast(`Could not load data: ${e.message}`);
    }
    state.data = compute(state.matches, state.settlements);
    render();
  }

  // UI mirrors the database policies in supabase.sql.
  const can = {
    deleteMatch: m => isAdmin() || m.created_by === me(),
    settle: d => isAdmin() || d.to === me() || d.from === me(),
    undoSettle: s => isAdmin() || s.created_by === me(),
  };

  function render() {
    if (state.tab === 'admin' && !isAdmin()) state.tab = 'matches';
    $('.tabs [data-tab=admin]').hidden = !isAdmin();
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
    const view = $('#view');
    view.innerHTML = ({ matches: viewMatches, table: viewTable, beers: viewBeers, admin: viewAdmin }[state.tab] || viewMatches)();
  }

  function viewMatches() {
    if (!state.matches.length) {
      return `<div class="empty"><p>No matches yet.</p><p class="muted">Hit + after your next game.</p></div>`;
    }
    // Scoreboard: one line per team, one column per set.
    const line = (m, ids, side, won) => `
      <div class="sb-row${won ? ' win' : ''}">
        <span class="sb-team">${team(ids)}</span>
        ${m.sets.map(s => `<span class="sb-set${s[side] > s[1 - side] ? ' hi' : ''}">${s[side]}</span>`).join('')}
        <span class="sb-mark">${won ? 'W' : ''}</span>
      </div>`;
    return `<h2 class="section">Matches</h2>` + [...state.matches].reverse().map(m => `
      <article class="card match">
        <div class="match-meta">
          <span>${fmtDate(m.played_at)}${BY_ID[m.created_by] ? ` · logged by ${esc(BY_ID[m.created_by].name)}` : ''}</span>
          ${can.deleteMatch(m) ? `<button class="link danger" data-action="del-match" data-id="${esc(m.id)}">Delete</button>` : ''}
        </div>
        ${line(m, m.team_a, 0, m.winner === 'A')}
        ${line(m, m.team_b, 1, m.winner === 'B')}
      </article>`).join('');
  }

  function viewTable() {
    const { table } = state.data;
    const rows = table.map((s, i) => {
      // Streak tag only once it's notable: W3+ or L3+.
      const streak = s.streak >= 3 ? `<span class="tag win">W${s.streak}</span>`
        : s.streak <= -3 ? `<span class="tag loss">L${-s.streak}</span>` : '';
      const form = s.form.slice(-5).map(r => `<i class="dot ${r === 'W' ? 'w' : 'l'}" title="${r}"></i>`).join('');
      const partners = Object.entries(s.partners)
        .sort(([, a], [, b]) => b.wins / b.played - a.wins / a.played || b.played - a.played)
        .map(([id, p]) => `${who(id)} ${p.wins}–${p.played - p.wins}`).join(' · ');
      const diff = s.gf - s.ga;
      return `
        <details class="board-row${s.id === me() ? ' me' : ''}">
          <summary>
            <span class="rank">${s.played ? i + 1 : '–'}</span>
            <span class="name">${who(s.id)}${streak}</span>
            <span class="n">${s.wins}</span>
            <span class="n">${s.losses}</span>
            <span class="pct">${s.played ? Math.round(winPct(s) * 100) + '%' : '–'}</span>
          </summary>
          <div class="detail">
            <span class="muted">Games</span><span>${s.gf}–${s.ga} (${diff > 0 ? '+' : ''}${diff})</span>
            <span class="muted">Last 5</span><span>${form || '–'}</span>
            <span class="muted">Beers lost</span><span>${s.beersLost}</span>
            ${partners ? `<span class="muted">With partner</span><span>${partners}</span>` : ''}
          </div>
        </details>`;
    }).join('');
    return `
      <h2 class="section">Leaderboard</h2>
      <div class="card board">
        <div class="board-head"><span>#</span><span>Player</span><span class="n">W</span><span class="n">L</span><span class="pct">Win</span></div>
        ${rows}
      </div>
      <p class="hint">Ranked by win %. Tap a player for details.</p>`;
  }

  function viewBeers() {
    const { debts, table } = state.data;
    // Mine first, then biggest debts.
    const mine = d => (d.from === me() || d.to === me() ? 0 : 1);
    const sorted = [...debts].sort((a, b) => mine(a) - mine(b) || b.beers - a.beers);
    const settleLabel = d => (d.from === me() ? 'I paid' : d.to === me() ? 'Got it' : 'Paid');

    const debtHtml = sorted.length
      ? `<div class="card rows">${sorted.map(d => `
          <div class="ledger-row${mine(d) === 0 ? ' me' : ''}">
            <span class="who"><b>${youOr(d.from)}</b> <span class="muted">${d.from === me() ? 'owe' : 'owes'}</span> <b>${youOr(d.to)}</b></span>
            <span class="amount">${beers(d.beers)}</span>
            ${can.settle(d)
              ? `<button class="btn small" data-action="settle" data-from="${esc(d.from)}" data-to="${esc(d.to)}" data-beers="${d.beers}">${settleLabel(d)}</button>`
              : '<span></span>'}
          </div>`).join('')}</div>`
      : `<div class="empty"><p>All square.</p><p class="muted">Suspicious, but congratulations.</p></div>`;

    const customers = [...table].filter(s => s.beersLost > 0).sort((a, b) => b.beersLost - a.beersLost);
    const customersHtml = customers.length ? `
      <h2 class="section">Best customers</h2>
      <div class="card rows">${customers.map((s, i) => `
        <div class="simple-row"><span class="rank">${i + 1}</span><span class="who">${who(s.id)}</span><span class="amount">${beers(s.beersLost)}</span></div>`).join('')}
      </div>
      <p class="hint">Lifetime beers lost, paid or not.</p>` : '';

    const history = [...state.settlements].reverse().slice(0, 15);
    const historyHtml = history.length ? `
      <h2 class="section">Paid up</h2>
      <div class="card rows">${history.map(s => `
        <div class="simple-row">
          <span class="who">${who(s.from_player)} → ${who(s.to_player)} <span class="muted">· ${fmtDate(s.created_at)}</span></span>
          <span class="amount">${beers(s.beers)}</span>
          ${can.undoSettle(s) ? `<button class="link danger" data-action="del-settle" data-id="${esc(s.id)}">Undo</button>` : '<span></span>'}
        </div>`).join('')}
      </div>` : '';

    return `
      <h2 class="section">Beer ledger</h2>
      ${debtHtml}
      <p class="hint">Every loser owes every winner ${plural(BEERS_PER_LOSS, 'beer')} per match, netted per pair.</p>
      ${customersHtml}${historyHtml}`;
  }

  function viewAdmin() {
    return `
      <h2 class="section">Passwords</h2>
      <div class="card rows">${PLAYERS.map(p => `
        <div class="simple-row">
          <span class="who">${who(p.id)}${p.id === me() ? ' <span class="muted">(you)</span>' : ''}</span>
          <span></span>
          <button class="btn small" data-action="reset-pw" data-id="${esc(p.id)}">New password</button>
        </div>`).join('')}
      </div>
      <p class="hint">A new password signs that player out on all their devices. Pass it on privately.
        As admin you can also delete any match and settle or undo any beer payment.</p>`;
  }

  async function resetPassword(id) {
    const p = BY_ID[id];
    const self = id === me();
    if (!confirm(`Generate a new password for ${p.name}?${self ? '' : ` ${p.name} will be signed out everywhere.`}`)) return;
    const pw = funnyPassword();
    await api.rpc('set_password', { p_player: id, p_password: pw });
    const modal = $('#modal');
    modal.innerHTML = `
      <div>
        <h2>New password for ${esc(p.name)}</h2>
        <p class="muted small">Shown once. Send it privately${self ? '' : ` to ${esc(p.name)}`}.</p>
        <p class="password" id="new-pw">${esc(pw)}</p>
        <div class="actions">
          <button type="button" class="btn ghost" id="copy-pw">Copy</button>
          <button type="button" class="btn primary" data-close>Done</button>
        </div>
      </div>`;
    $('#copy-pw', modal).onclick = async () => {
      try { await navigator.clipboard.writeText(pw); toast('Copied.'); } catch { toast('Copy failed. Select the text instead.'); }
    };
    $('[data-close]', modal).onclick = () => modal.close();
    modal.showModal();
  }

  // ---------- log match dialog ----------
  function openLog() {
    const modal = $('#modal');
    const assign = {}; // playerId -> 'A' | 'B'
    const setRow = i => `
      <div class="set-row">
        <span class="muted">Set ${i + 1}</span>
        <input type="number" inputmode="numeric" min="0" max="99" name="a${i}" aria-label="Set ${i + 1} team A games">
        <input type="number" inputmode="numeric" min="0" max="99" name="b${i}" aria-label="Set ${i + 1} team B games">
      </div>`;

    modal.innerHTML = `
      <form id="log-form" novalidate>
        <h2>Log a match</h2>
        <p class="muted small">Tap a player once for Team A, twice for Team B.</p>
        <div class="chips">${PLAYERS.map(p => `<button type="button" class="chip" data-p="${esc(p.id)}">${who(p.id)}</button>`).join('')}</div>
        <div class="set-row head"><span></span><span class="team-a">Team A</span><span class="team-b">Team B</span></div>
        ${[0, 1, 2].map(setRow).join('')}
        <label class="field">Date <input type="date" name="date" value="${todayStr()}" max="${todayStr()}"></label>
        <p class="err" role="alert"></p>
        <div class="actions">
          <button type="button" class="btn ghost" data-close>Cancel</button>
          <button type="submit" class="btn primary">Save match</button>
        </div>
      </form>`;

    const form = $('#log-form', modal);
    const paint = () => form.querySelectorAll('.chip').forEach(c => {
      c.classList.toggle('a', assign[c.dataset.p] === 'A');
      c.classList.toggle('b', assign[c.dataset.p] === 'B');
    });

    form.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (chip) {
        const id = chip.dataset.p;
        assign[id] = { undefined: 'A', A: 'B', B: undefined }[assign[id]];
        if (!assign[id]) delete assign[id];
        // With exactly four players, picking one full team fills in the other.
        const vals = Object.values(assign);
        if (PLAYERS.length === 4 && vals.length === 2 && new Set(vals).size === 1) {
          const other = vals[0] === 'A' ? 'B' : 'A';
          PLAYERS.forEach(p => { assign[p.id] ??= other; });
        }
        paint();
      }
      if (e.target.closest('[data-close]')) modal.close();
    });

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const err = $('.err', form);
      const teamA = PLAYERS.filter(p => assign[p.id] === 'A').map(p => p.id);
      const teamB = PLAYERS.filter(p => assign[p.id] === 'B').map(p => p.id);
      if (teamA.length !== 2 || teamB.length !== 2) { err.textContent = 'Pick two players per team.'; return; }

      const sets = [];
      for (let i = 0; i < 3; i++) {
        const a = form[`a${i}`].value, b = form[`b${i}`].value;
        if (a === '' && b === '') continue;
        if (a === '' || b === '') { err.textContent = `Set ${i + 1} is missing a score.`; return; }
        if (+a === +b) { err.textContent = `Set ${i + 1} can't be a draw.`; return; }
        sets.push([+a, +b]);
      }
      if (!sets.length) { err.textContent = 'Enter at least one set.'; return; }

      const setsA = sets.filter(([a, b]) => a > b).length;
      const setsB = sets.length - setsA;
      const gamesA = sets.reduce((s, [a]) => s + a, 0);
      const gamesB = sets.reduce((s, [, b]) => s + b, 0);
      const winner = setsA !== setsB ? (setsA > setsB ? 'A' : 'B') : gamesA !== gamesB ? (gamesA > gamesB ? 'A' : 'B') : null;
      if (!winner) { err.textContent = 'Dead level on sets and games — play a tiebreak.'; return; }

      const date = form.date.value || todayStr();
      const played_at = date === todayStr() ? new Date().toISOString() : new Date(`${date}T20:00`).toISOString();

      const submit = $('button[type=submit]', form);
      submit.disabled = true;
      try {
        await store.addMatch({ played_at, team_a: teamA, team_b: teamB, sets, winner, created_by: me() });
        modal.close();
        const losers = winner === 'A' ? teamB : teamA;
        toast(`Saved. ${losers.map(id => BY_ID[id].name).join(' & ')} — the bar is that way.`);
        state.tab = 'matches';
        await load();
      } catch (ex) {
        err.textContent = `Could not save: ${ex.message}`;
        submit.disabled = false;
      }
    });

    modal.showModal();
  }


  // ---------- login (once per device; no switching) ----------
  function paintWhoami() {
    const id = me();
    $('#whoami').hidden = !id;
    if (id) $('#whoami').innerHTML = `${who(id)}${isAdmin() ? '<span class="tag win">Admin</span>' : ''}`;
  }

  async function ensureLogin() {
    if (session()) {
      try {
        const w = await api.rpc('whoami');
        if (w?.player) { ls.set(SESSION_KEY, { ...session(), ...w }); return paintWhoami(); }
        ls.set(SESSION_KEY, null); // session revoked, e.g. after a password reset
      } catch (ex) {
        // Offline or server hiccup: keep the session and let load() report the problem.
        return paintWhoami();
      }
    }

    const modal = $('#modal');
    modal.innerHTML = `
      <form id="login" novalidate>
        <h2>Who's this?</h2>
        <p class="muted small">Log in once and this device remembers you.</p>
        <label class="field">Name
          <input type="text" name="player" autocomplete="username" autocapitalize="words" spellcheck="false" required>
        </label>
        <label class="field">Password
          <input type="password" name="password" autocomplete="current-password" required>
        </label>
        <p class="err" role="alert"></p>
        <div class="actions"><button type="submit" class="btn primary">Let me in</button></div>
      </form>`;
    modal.oncancel = e => e.preventDefault(); // Esc can't skip the login
    modal.showModal();
    $('input', modal).focus();

    await new Promise(resolve => {
      const form = $('#login', modal);
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const err = $('.err', form);
        const typed = norm(form.player.value);
        const pw = form.password.value.trim().toLowerCase(); // passwords are lowercase words; forgive phone auto-caps
        const player = PLAYERS.find(p => norm(p.name) === typed || p.id === typed);
        if (!typed || !pw) { err.textContent = 'Name and password, please.'; return; }
        if (!player) { err.textContent = 'Not on the list. This is a private court.'; return; }

        const submit = $('button[type=submit]', form);
        submit.disabled = true;
        try {
          const res = await api.rpc('login', { p_player: player.id, p_password: pw });
          if (res?.token) {
            ls.set(SESSION_KEY, { token: res.token, player: res.player, is_admin: res.is_admin });
            modal.oncancel = null;
            modal.close();
            toast(`Tere, ${player.name}!`);
            resolve();
            return;
          }
          err.textContent = res?.error === 'locked'
            ? 'Too many wrong guesses. Try again in 15 minutes.'
            : 'Wrong password.';
        } catch (ex) {
          err.textContent = `Could not reach the server: ${ex.message}`;
        }
        submit.disabled = false;
      });
    });
    paintWhoami();
  }

  // ---------- wiring ----------
  document.querySelector('.tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    ls.set('padelhq.tab', state.tab);
    render();
    window.scrollTo(0, 0);
  });

  $('#fab').addEventListener('click', openLog);

  $('#view').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    try {
      if (action === 'reset-pw') {
        await resetPassword(id);
        return;
      } else if (action === 'del-match' && confirm('Delete this match? Beer debts will be recalculated.')) {
        await store.deleteMatch(id);
        toast('Match deleted.');
      } else if (action === 'settle') {
        const n = +btn.dataset.beers;
        if (!confirm(`${BY_ID[btn.dataset.from].name} paid ${BY_ID[btn.dataset.to].name} ${plural(n, 'beer')}?`)) return;
        await store.addSettlement({ from_player: btn.dataset.from, to_player: btn.dataset.to, beers: n, created_by: me() });
        toast('Cheers. Ledger updated.');
      } else if (action === 'del-settle' && confirm('Undo this payment?')) {
        await store.deleteSettlement(id);
        toast('Payment undone. The debt lives again.');
      } else {
        return;
      }
      await load();
    } catch (ex) {
      toast(`Something went wrong: ${ex.message}`);
    }
  });

  $('#club-name').textContent = CFG.clubName || 'Padel HQ';
  document.title = CFG.clubName || 'Padel HQ';

  if (!CONFIGURED) {
    $('#fab').hidden = true;
    $('.tabs').hidden = true;
    $('#view').innerHTML = `<div class="empty"><p>Not connected yet.</p>
      <p class="muted">Add the Supabase URL and anon key to config.js — see README.md.</p></div>`;
    return;
  }

  ensureLogin().then(load);
})();
