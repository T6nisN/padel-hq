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
    addMatches: ms => api.req('matches', { method: 'POST', body: JSON.stringify(ms) }), // bulk insert, one request
    addSettlement: s => api.req('settlements', { method: 'POST', body: JSON.stringify(s) }),
    deleteMatches: ids => api.req(`matches?id=in.(${ids.map(encodeURIComponent).join(',')})`, { method: 'DELETE' }),
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
  const uid = () => crypto.randomUUID();
  const funnyPassword = () => `${ADJ[rand(ADJ.length)]}-${NOUN[rand(NOUN.length)]}-${10 + rand(90)}`;

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // A substitute who plays now and then. Stored in teams as this id; never on the
  // leaderboard and never owes or receives beers. Optional display name per match.
  const GUEST = 'guest';
  const ALL_IDS = [...PLAYERS.map(p => p.id), GUEST];
  const nameOf = (id, m) => (id === GUEST
    ? (m?.guest_name ? `${m.guest_name} (guest)` : 'Guest')
    : BY_ID[id]?.name ?? id);
  const who = (id, m) => esc(nameOf(id, m));
  const youOr = id => (id === me() ? 'You' : who(id));
  const team = (ids, m) => ids.map(id => who(id, m)).join(' / ');
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
      id: p.id, played: 0, wins: 0, losses: 0, gf: 0, ga: 0, pf: 0, pa: 0, streak: 0, form: [], partners: {}, beersLost: 0,
    }]));
    // owed[a][b] = beers a owes b, before netting
    const owed = Object.fromEntries(PLAYERS.map(p => [p.id, Object.fromEntries(PLAYERS.map(q => [q.id, 0]))]));

    for (const m of matches) {
      const ids = [...m.team_a, ...m.team_b];
      if (!ids.every(id => stats[id] || id === GUEST)) continue; // player removed from config — skip
      const winners = m.winner === 'A' ? m.team_a : m.team_b;
      const losers = m.winner === 'A' ? m.team_b : m.team_a;
      const gA = m.sets.reduce((s, [a]) => s + a, 0);
      const gB = m.sets.reduce((s, [, b]) => s + b, 0);

      for (const id of ids) {
        if (id === GUEST) continue; // guests have no stats; their partner's result still counts
        const s = stats[id];
        const onA = m.team_a.includes(id);
        const won = winners.includes(id);
        const partner = (onA ? m.team_a : m.team_b).find(x => x !== id);
        s.played++;
        won ? s.wins++ : s.losses++;
        // Regular counts games, Americano counts points — kept apart so they don't mix.
        if (isAmericano(m)) { s.pf += onA ? gA : gB; s.pa += onA ? gB : gA; }
        else { s.gf += onA ? gA : gB; s.ga += onA ? gB : gA; }
        s.streak = won ? Math.max(s.streak, 0) + 1 : Math.min(s.streak, 0) - 1;
        s.form.push(won ? 'W' : 'L');
        s.partners[partner] ??= { played: 0, wins: 0 };
        s.partners[partner].played++;
        if (won) s.partners[partner].wins++;
      }
      for (const l of losers) for (const w of winners) {
        if (l === GUEST || w === GUEST) continue; // guests neither owe nor receive beers
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
  const isAmericano = m => m.game_type === 'americano'; // rows from before game types are regular

  // Four players split into pairs exactly three ways = one full Americano rotation.
  const makePairings = ([a, b, c, d]) => [[[a, b], [c, d]], [[a, c], [b, d]], [[a, d], [b, c]]];
  const AMERICANO_OK = ALL_IDS.length >= 4; // the four of you, or three plus the guest

  // ---------- state & rendering ----------
  const state = {
    matches: [], settlements: [], data: null,
    tab: ls.get('padelhq.tab', 'matches'),
    tableType: ls.get('padelhq.tableType', 'all'), // all | regular | americano
  };

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
    deleteMatch: () => isAdmin(),
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
        <span class="sb-team">${team(ids, m)}</span>
        ${m.sets.map(s => `<span class="sb-set${s[side] > s[1 - side] ? ' hi' : ''}">${s[side]}</span>`).join('')}
        <span class="sb-mark">${won ? 'W' : ''}</span>
      </div>`;
    const meta = (m, extra, ids) => `
      <div class="match-meta">
        <span>${isAmericano(m) ? '<span class="tag type">Americano</span> ' : ''}${fmtDate(m.played_at)}${BY_ID[m.created_by] ? ` · by ${esc(BY_ID[m.created_by].name)}` : ''}${extra}</span>
        ${can.deleteMatch(m) ? `<button class="link danger" data-action="del-match" data-ids="${esc(ids.join(','))}">Delete</button>` : ''}
      </div>`;

    // Americano rounds saved together (same session_id) become one card.
    const cards = [];
    for (const m of state.matches) {
      const last = cards[cards.length - 1];
      if (isAmericano(m) && m.session_id && last?.[0].session_id === m.session_id) last.push(m);
      else cards.push([m]);
    }

    return `<h2 class="section">Matches</h2>` + cards.reverse().map(group => {
      const m = group[0];
      if (!isAmericano(m)) {
        return `
          <article class="card match">
            ${meta(m, '', [m.id])}
            ${line(m, m.team_a, 0, m.winner === 'A')}
            ${line(m, m.team_b, 1, m.winner === 'B')}
          </article>`;
      }
      // Americano: one line per round, then each player's points total (the usual Americano ranking).
      const pts = {};
      group.forEach(r => {
        const [[a, b]] = r.sets;
        r.team_a.forEach(id => { pts[id] = (pts[id] || 0) + a; });
        r.team_b.forEach(id => { pts[id] = (pts[id] || 0) + b; });
      });
      const totals = Object.entries(pts).sort(([, x], [, y]) => y - x)
        .map(([id, p], i) => `<span class="${i === 0 ? 'lead' : ''}">${who(id, m)} ${p}</span>`).join('');
      return `
        <article class="card match">
          ${meta(m, group.length > 1 ? ` · ${group.length} rounds` : '', group.map(r => r.id))}
          ${group.map(r => {
            const [[a, b]] = r.sets;
            return `
              <div class="am-line">
                <span class="am-t${a > b ? ' win' : ''}">${team(r.team_a, r)}</span>
                <span class="am-score"><b class="${a > b ? 'hi' : ''}">${a}</b>–<b class="${b > a ? 'hi' : ''}">${b}</b></span>
                <span class="am-t right${b > a ? ' win' : ''}">${team(r.team_b, r)}</span>
              </div>`;
          }).join('')}
          <div class="am-totals"><span class="muted">Points</span>${totals}</div>
        </article>`;
    }).join('');
  }

  function viewTable() {
    // Leaderboard can be filtered by game type; beers always use every match.
    const type = state.tableType;
    const { table } = type === 'all' ? state.data
      : compute(state.matches.filter(m => (isAmericano(m) ? 'americano' : 'regular') === type), []);
    const seg = `
      <div class="seg" role="tablist">${['all', 'regular', 'americano'].map(t =>
        `<button data-action="table-type" data-type="${t}" class="${t === type ? 'on' : ''}">${t}</button>`).join('')}
      </div>`;
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
            ${s.gf + s.ga ? `<span class="muted">Games</span><span>${s.gf}–${s.ga} (${diff > 0 ? '+' : ''}${diff})</span>` : ''}
            ${s.pf + s.pa ? `<span class="muted">Americano pts</span><span>${s.pf}–${s.pa} (${s.pf - s.pa > 0 ? '+' : ''}${s.pf - s.pa})</span>` : ''}
            <span class="muted">Last 5</span><span>${form || '–'}</span>
            <span class="muted">Beers lost</span><span>${s.beersLost}</span>
            ${partners ? `<span class="muted">With partner</span><span>${partners}</span>` : ''}
          </div>
        </details>`;
    }).join('');
    return `
      <h2 class="section">Leaderboard</h2>
      ${seg}
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
        Only you can delete matches, and you can settle or undo any beer payment.</p>`;
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
    const assign = {}; // id -> 'A' | 'B' (regular only)
    let type = AMERICANO_OK ? ls.get('padelhq.lastType', 'regular') : 'regular';
    // Americano: who played today. Default: the four regulars (or three + guest).
    let present = ALL_IDS.slice(0, 4);
    const pairings = () => (present.length === 4 ? makePairings(ALL_IDS.filter(id => present.includes(id))) : []);
    const usesGuest = () => (type === 'americano' ? present.includes(GUEST) : Boolean(assign[GUEST]));

    const num = (name, label) =>
      `<input type="number" inputmode="numeric" min="0" max="99" name="${name}" aria-label="${label}">`;
    const setRow = i => `
      <div class="set-row">
        <span class="muted">Set ${i + 1}</span>${num(`a${i}`, `Set ${i + 1} team A games`)}${num(`b${i}`, `Set ${i + 1} team B games`)}
      </div>`;
    const chip = (id, attr) =>
      `<button type="button" class="chip${id === GUEST ? ' guest' : ''}" ${attr}="${esc(id)}">${who(id)}</button>`;

    // Americano rounds: as many as you played. New rounds continue the rotation;
    // values live here so adding/removing/re-pairing rows doesn't wipe typed scores.
    const rounds = [];
    const addRound = () => rounds.push({ p: rounds.length % 3, a: '', b: '' });
    for (let i = 0; i < 3; i++) addRound();
    const roundInput = (r, i, side, ids) =>
      `<input type="number" inputmode="numeric" min="0" max="99" data-i="${i}" data-side="${side}" value="${esc(r[side])}"
        aria-label="Round ${i + 1}: ${team(ids)} points">`;
    const roundRow = (r, i) => {
      const [ta, tb] = pairings()[r.p];
      return `
        <div class="am-row">
          <span class="am-no">${i + 1}</span>
          <button type="button" class="am-team" data-cycle="${i}">${team(ta)}</button>
          ${roundInput(r, i, 'a', ta)}${roundInput(r, i, 'b', tb)}
          <button type="button" class="am-team right" data-cycle="${i}">${team(tb)}</button>
          <button type="button" class="am-del" data-del="${i}" aria-label="Remove round ${i + 1}">×</button>
        </div>`;
    };

    modal.innerHTML = `
      <form id="log-form" novalidate>
        <h2>Log a match</h2>
        ${AMERICANO_OK ? `<div class="seg">${['regular', 'americano'].map(t =>
          `<button type="button" data-type="${t}">${t}</button>`).join('')}</div>` : ''}
        <div data-mode="regular">
          <p class="muted small">Tap a player once for Team A, twice for Team B.</p>
          <div class="chips">${ALL_IDS.map(id => chip(id, 'data-p')).join('')}</div>
          <div class="set-row head"><span></span><span class="team-a">Team A</span><span class="team-b">Team B</span></div>
          ${[0, 1, 2].map(setRow).join('')}
        </div>
        <div data-mode="americano">
          <p class="muted small">Who played? Pick 4. Tap team names to change a round's pairing.</p>
          <div class="chips who">${ALL_IDS.map(id => chip(id, 'data-who')).join('')}</div>
          <div id="am-rounds"></div>
          <button type="button" class="btn ghost add-round">+ Add round</button>
        </div>
        <label class="field" id="guest-field" hidden>Guest name (optional)
          <input type="text" name="guest_name" maxlength="30" autocomplete="off" autocapitalize="words">
        </label>
        <label class="field">Date <input type="date" name="date" value="${todayStr()}" max="${todayStr()}"></label>
        <p class="err" role="alert"></p>
        <div class="actions">
          <button type="button" class="btn ghost" data-close>Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>`;

    const form = $('#log-form', modal);
    const paintRounds = () => {
      $('#am-rounds', form).innerHTML = pairings().length
        ? rounds.map(roundRow).join('')
        : `<p class="hint">Pick exactly 4 players (${present.length} selected).</p>`;
      $('.add-round', form).hidden = !pairings().length;
    };
    const paint = () => {
      form.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.type === type));
      form.querySelectorAll('[data-mode]').forEach(d => { d.hidden = d.dataset.mode !== type; });
      form.querySelectorAll('[data-p]').forEach(c => {
        c.classList.toggle('a', assign[c.dataset.p] === 'A');
        c.classList.toggle('b', assign[c.dataset.p] === 'B');
      });
      form.querySelectorAll('[data-who]').forEach(c => c.classList.toggle('on', present.includes(c.dataset.who)));
      $('#guest-field', form).hidden = !usesGuest();
    };

    form.addEventListener('click', e => {
      const seg = e.target.closest('.seg button');
      if (seg) { type = seg.dataset.type; $('.err', form).textContent = ''; paint(); }
      if (e.target.closest('.add-round')) {
        addRound();
        paintRounds();
        form.querySelector(`[data-i="${rounds.length - 1}"][data-side="a"]`).focus();
      }
      const cycle = e.target.closest('[data-cycle]');
      if (cycle) { const r = rounds[+cycle.dataset.cycle]; r.p = (r.p + 1) % 3; paintRounds(); }
      const del = e.target.closest('[data-del]');
      if (del) { rounds.splice(+del.dataset.del, 1); paintRounds(); }
      const whoChip = e.target.closest('[data-who]');
      if (whoChip) {
        const id = whoChip.dataset.who;
        present = present.includes(id) ? present.filter(x => x !== id) : [...present, id];
        paintRounds();
        paint();
      }
      const teamChip = e.target.closest('[data-p]');
      if (teamChip) {
        const id = teamChip.dataset.p;
        assign[id] = { undefined: 'A', A: 'B', B: undefined }[assign[id]];
        if (!assign[id]) delete assign[id];
        // With exactly four regulars and no guest, picking one full team fills in the other.
        const vals = Object.values(assign);
        if (PLAYERS.length === 4 && !assign[GUEST] && vals.length === 2 && new Set(vals).size === 1) {
          const other = vals[0] === 'A' ? 'B' : 'A';
          PLAYERS.forEach(p => { assign[p.id] ??= other; });
        }
        paint();
      }
      if (e.target.closest('[data-close]')) modal.close();
    });

    // Both readers return the match rows to save, or an error message string.
    function readRegular() {
      const teamA = ALL_IDS.filter(id => assign[id] === 'A');
      const teamB = ALL_IDS.filter(id => assign[id] === 'B');
      if (teamA.length !== 2 || teamB.length !== 2) return 'Pick two players per team.';
      const sets = [];
      for (let i = 0; i < 3; i++) {
        const a = form[`a${i}`].value, b = form[`b${i}`].value;
        if (a === '' && b === '') continue;
        if (a === '' || b === '') return `Set ${i + 1} is missing a score.`;
        if (+a === +b) return `Set ${i + 1} can't be a draw.`;
        sets.push([+a, +b]);
      }
      if (!sets.length) return 'Enter at least one set.';
      const setsA = sets.filter(([a, b]) => a > b).length;
      const setsB = sets.length - setsA;
      const gamesA = sets.reduce((s, [a]) => s + a, 0);
      const gamesB = sets.reduce((s, [, b]) => s + b, 0);
      const winner = setsA !== setsB ? (setsA > setsB ? 'A' : 'B') : gamesA !== gamesB ? (gamesA > gamesB ? 'A' : 'B') : null;
      if (!winner) return 'Dead level on sets and games — play a tiebreak.';
      return [{ team_a: teamA, team_b: teamB, sets, winner }];
    }

    function readAmericano() {
      if (present.length !== 4) return `Pick exactly 4 players (${present.length} selected).`;
      const rows = [];
      // All rounds of one training share a session id, so the match list can show them as one card.
      const session_id = uid();
      const pairs = pairings();
      for (const [i, r] of rounds.entries()) {
        const [ta, tb] = pairs[r.p];
        if (r.a === '' && r.b === '') continue;
        if (r.a === '' || r.b === '') return `Round ${i + 1} is missing a score.`;
        if (+r.a === +r.b) return `Round ${i + 1} is a draw — play one more point.`;
        rows.push({ team_a: ta, team_b: tb, sets: [[+r.a, +r.b]], winner: +r.a > +r.b ? 'A' : 'B', session_id });
      }
      return rows.length ? rows : 'Enter at least one round.';
    }

    // Keep typed round scores in `rounds` so re-rendering rows never loses them.
    form.addEventListener('input', e => {
      const { i, side } = e.target.dataset;
      if (side) rounds[+i][side] = e.target.value;
    });

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const err = $('.err', form);
      const result = type === 'americano' ? readAmericano() : readRegular();
      if (typeof result === 'string') { err.textContent = result; return; }

      const date = form.date.value || todayStr();
      const base = date === todayStr() ? Date.now() : new Date(`${date}T20:00`).getTime();
      const guestName = form.guest_name.value.trim() || null;
      // One second apart so rounds keep their order in streaks and the match list.
      const rows = result.map((m, i) => ({
        ...m,
        game_type: type,
        guest_name: [...m.team_a, ...m.team_b].includes(GUEST) ? guestName : null,
        played_at: new Date(base + i * 1000).toISOString(),
        created_by: me(),
      }));

      const submit = $('button[type=submit]', form);
      submit.disabled = true;
      try {
        await store.addMatches(rows);
        ls.set('padelhq.lastType', type);
        modal.close();
        if (type === 'americano') {
          toast(`Saved ${plural(rows.length, 'round')}.`);
        } else {
          const losers = (rows[0].winner === 'A' ? rows[0].team_b : rows[0].team_a).filter(id => id !== GUEST);
          toast(`Saved. ${losers.map(id => nameOf(id)).join(' & ')} — the bar is that way.`);
        }
        state.tab = 'matches';
        await load();
      } catch (ex) {
        err.textContent = `Could not save: ${ex.message}`;
        submit.disabled = false;
      }
    });

    paintRounds();
    paint();
    modal.showModal();
  }

  // ---------- pay beers (all or part of a debt) ----------
  function openSettle(from, to, owed) {
    const modal = $('#modal');
    modal.innerHTML = `
      <form id="settle-form" novalidate>
        <h2>Pay beers</h2>
        <p class="muted small">${youOr(from)} → ${youOr(to)} · owed ${owed}</p>
        <div class="stepper">
          <button type="button" class="btn" data-step="-1" aria-label="One less">−</button>
          <input type="number" name="n" value="${owed}" min="1" max="${owed}" inputmode="numeric" aria-label="Beers paid">
          <button type="button" class="btn" data-step="1" aria-label="One more">+</button>
        </div>
        <p class="err" role="alert"></p>
        <div class="actions">
          <button type="button" class="btn ghost" data-close>Cancel</button>
          <button type="submit" class="btn primary">Mark paid</button>
        </div>
      </form>`;
    const form = $('#settle-form', modal);
    const clamp = n => Math.min(owed, Math.max(1, Math.round(n) || 1));
    form.addEventListener('click', e => {
      const step = e.target.closest('[data-step]');
      if (step) form.n.value = clamp(+form.n.value + +step.dataset.step);
      if (e.target.closest('[data-close]')) modal.close();
    });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const n = +form.n.value;
      if (!Number.isInteger(n) || n < 1 || n > owed) { $('.err', form).textContent = `Between 1 and ${owed}.`; return; }
      try {
        await store.addSettlement({ from_player: from, to_player: to, beers: n, created_by: me() });
        modal.close();
        toast(n === owed ? 'Cheers. All square.' : `Cheers. ${owed - n} still to go.`);
        await load();
      } catch (ex) {
        $('.err', form).textContent = `Could not save: ${ex.message}`;
      }
    });
    modal.showModal();
  }

  // ---------- passwords ----------
  // Passwords are case-insensitive (phones love auto-capitalising), so normalise everywhere.
  const normPw = s => (s || '').trim().toLowerCase();

  // forced: first login / after admin reset — can't be skipped.
  // current: already known (just typed at login), so don't ask again.
  function changePassword({ forced = false, current = null } = {}) {
    const modal = $('#modal');
    modal.innerHTML = `
      <form id="pw-form" novalidate>
        <h2>${forced ? 'Pick your own password' : 'Change password'}</h2>
        <p class="muted small">${forced ? 'The one you got was temporary. ' : ''}At least 6 characters, not case-sensitive.
          Your other devices get signed out.</p>
        ${current ? '' : '<label class="field">Current password <input type="password" name="current" autocomplete="current-password"></label>'}
        <label class="field">New password <input type="password" name="next" autocomplete="new-password"></label>
        <label class="field">Repeat new password <input type="password" name="again" autocomplete="new-password"></label>
        <p class="err" role="alert"></p>
        <div class="actions">
          ${forced ? '' : '<button type="button" class="btn ghost" data-close>Cancel</button>'}
          <button type="submit" class="btn primary">Save password</button>
        </div>
      </form>`;
    modal.oncancel = forced ? e => e.preventDefault() : null;
    modal.showModal();
    $('input', modal).focus();

    return new Promise(resolve => {
      const form = $('#pw-form', modal);
      form.addEventListener('click', e => {
        if (e.target.closest('[data-close]')) { modal.close(); resolve(false); }
      });
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const err = $('.err', form);
        const cur = current ?? normPw(form.current.value);
        const next = normPw(form.next.value);
        if (!cur) { err.textContent = 'Enter your current password.'; return; }
        if (next.length < 6) { err.textContent = 'At least 6 characters.'; return; }
        if (next !== normPw(form.again.value)) { err.textContent = "Passwords don't match."; return; }
        if (next === cur) { err.textContent = "That's the old one. Pick a new one."; return; }
        const submit = $('button[type=submit]', form);
        submit.disabled = true;
        try {
          const res = await api.rpc('change_password', { p_current: cur, p_new: next });
          if (res?.ok) {
            ls.set(SESSION_KEY, { ...session(), must_change: false });
            modal.oncancel = null;
            modal.close();
            toast('Password saved.');
            resolve(true);
            return;
          }
          err.textContent = { wrong: 'Current password is wrong.', short: 'At least 6 characters.' }[res?.error]
            || 'Session expired. Reload the page.';
        } catch (ex) {
          err.textContent = `Could not reach the server: ${ex.message}`;
        }
        submit.disabled = false;
      });
    });
  }

  // ---------- login (once per device; no switching) ----------
  function paintWhoami() {
    const id = me();
    $('#whoami').hidden = !id;
    if (id) $('#whoami').innerHTML = `${who(id)}${isAdmin() ? '<span class="tag win">Admin</span>' : ''}`;
  }

  async function ensureLogin() {
    let typedPw = null;
    let valid = false;
    if (session()) {
      try {
        const w = await api.rpc('whoami');
        if (w?.player) { ls.set(SESSION_KEY, { ...session(), ...w }); valid = true; }
        else ls.set(SESSION_KEY, null); // session revoked, e.g. after a password reset
      } catch (ex) {
        // Offline or server hiccup: keep the session and let load() report the problem.
        return paintWhoami();
      }
    }

    if (!valid) {
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
          const pw = normPw(form.password.value);
          const player = PLAYERS.find(p => norm(p.name) === typed || p.id === typed);
          if (!typed || !pw) { err.textContent = 'Name and password, please.'; return; }
          if (!player) { err.textContent = 'Not on the list. This is a private court.'; return; }

          const submit = $('button[type=submit]', form);
          submit.disabled = true;
          try {
            const res = await api.rpc('login', { p_player: player.id, p_password: pw });
            if (res?.token) {
              ls.set(SESSION_KEY, { token: res.token, player: res.player, is_admin: res.is_admin, must_change: res.must_change });
              typedPw = pw;
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
    }

    if (session()?.must_change) await changePassword({ forced: true, current: typedPw });
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
  $('#whoami').addEventListener('click', () => changePassword());

  $('#view').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    try {
      if (action === 'table-type') {
        state.tableType = btn.dataset.type;
        ls.set('padelhq.tableType', state.tableType);
        render();
      } else if (action === 'settle') {
        openSettle(btn.dataset.from, btn.dataset.to, +btn.dataset.beers);
      } else if (action === 'reset-pw') {
        await resetPassword(id);
      } else if (action === 'del-match') {
        const ids = btn.dataset.ids.split(',');
        const what = ids.length > 1 ? `all ${ids.length} rounds of this Americano` : 'this match';
        if (!confirm(`Delete ${what}? Beer debts will be recalculated.`)) return;
        await store.deleteMatches(ids);
        toast(ids.length > 1 ? 'Session deleted.' : 'Match deleted.');
        await load();
      } else if (action === 'del-settle' && confirm('Undo this payment?')) {
        await store.deleteSettlement(id);
        toast('Payment undone. The debt lives again.');
        await load();
      }
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
