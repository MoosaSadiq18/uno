'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const COL = { R: '#ef3b36', G: '#2fb457', B: '#2b7de9', Y: '#f5c518' }, SYM = { REV: '⇄', SKIP: '⊘', WILD: '★' };
const AV = ['🦊', '🐼', '🐸', '🦄', '🐯', '🐙', '🦁', '🐵', '🐧', '🐲', '🤖', '👻'];
const SEATC = ['#ef3b36', '#2b7de9', '#f5c518', '#2fb457', '#ff8a3d', '#b46cff', '#2ad4d4', '#ff6fb1'];
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', CODE_LEN = 5;
const MOBILE = matchMedia('(max-width:820px),(max-height:520px)');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- safe storage ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const sess = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { sessionStorage.removeItem(k); } catch (e) {} },
};
const pid = sess.get('pid') || (() => { const v = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2); sess.set('pid', v); return v; })();

/* ---------- preferences (persisted locally) ---------- */
const DEF = { sfx: true, sfxVol: 0.7, voiceVol: 1, unoSnd: true, chat: true };
const set = Object.assign({}, DEF, store.get('uno.settings', {}));
const saveSet = () => store.set('uno.settings', set);
const prof = Object.assign({ nick: '', avatar: 0 }, store.get('uno.profile', {}));
const saveProf = () => store.set('uno.profile', prof);

/* ---------- state ---------- */
let ws, S, me, room, myName = '', myAvatar = 0, pendingJoin = null, joining = false, active = false, connGen = 0, pingT, rcT, rcN = 0;
let pickIdx = -1, clickRect = null, lockUntil = 0, unread = 0, lastFrom = 'land', formFrom = 'land', reconnecting = false;
const send = o => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; };

/* =====================================================================
 * SOUND  (WebAudio synth, no assets). Audio is only created after a user gesture.
 * Entirely independent of chat: nothing in the chat UI touches these controls.
 * ===================================================================== */
let ac;
function unlockAudio() {
  try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch (e) {}
  if (typeof Voice !== 'undefined') Voice.resumeAudio();
}
['pointerdown', 'keydown', 'touchend'].forEach(ev => addEventListener(ev, unlockAudio, { passive: true }));
const SND = { play: [[520, .1, 'triangle'], [700, .12, 'triangle']], draw: [[300, .1], [250, .1]], uno: [[600, .12, 'square'], [800, .12, 'square'], [1000, .25, 'square']], win: [[523, .15], [659, .15], [784, .15], [1047, .45]], turn: [[880, .12]], bad: [[140, .22, 'sawtooth']], caught: [[300, .12, 'sawtooth'], [200, .22, 'sawtooth']] };
function snd(k) {
  if (!set.sfx || !ac || ac.state !== 'running' || set.sfxVol <= 0) return;
  if (k === 'uno' && !set.unoSnd) return;
  try {
    const t = ac.currentTime;
    SND[k].forEach(([f, d, ty], i) => {
      const o = ac.createOscillator(), g = ac.createGain(), s = t + i * .09;
      o.type = ty || 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(.25 * set.sfxVol, s); g.gain.exponentialRampToValueAtTime(.001, s + d);
      o.connect(g); g.connect(ac.destination); o.start(s); o.stop(s + d);
    });
  } catch (e) {}
}

/* ---------- feedback helpers ---------- */
function re(e, c) { e.classList.remove(c); void e.offsetWidth; e.classList.add(c); }
const toast = t => { const e = $('#toast'); e.textContent = t; re(e, 'on'); };
function banner(t, sub) { const e = $('#banner'); e.querySelector('b').textContent = t; e.querySelector('small').textContent = sub || ''; re(e, 'show'); }
function bad(m) { toast(m); snd('bad'); if (!$('#game').hidden) re($('#hand'), 'shake'); }
function fly(h, a, b, sz, sc = 1, ms = 420) {
  const t = document.createElement('div'); t.innerHTML = h; const c = t.firstChild; c.classList.add('fly');
  const x0 = a.left + a.width / 2 - sz / 2, y0 = a.top + a.height / 2 - sz * .75, x1 = b.left + b.width / 2 - sz / 2, y1 = b.top + b.height / 2 - sz * .75;
  c.style.cssText = `--cw:${sz}px;left:${x0}px;top:${y0}px`; document.body.appendChild(c);
  c.animate([{ transform: 'none' }, { transform: `translate(${x1 - x0}px,${y1 - y0}px) rotate(${Math.random() * 24 - 12}deg) scale(${sc})` }], { duration: ms, easing: 'cubic-bezier(.2,.8,.3,1)' }).onfinish = () => c.remove();
}
function confetti() {
  const c = $('#cf'), x = c.getContext('2d'), K = Object.values(COL); c.width = innerWidth; c.height = innerHeight;
  const ps = Array.from({ length: 170 }, () => ({ x: Math.random() * c.width, y: -Math.random() * c.height * .6, v: 2 + Math.random() * 4, w: 6 + Math.random() * 7, r: Math.random() * 6, s: Math.random() * .2 - .1, c: K[Math.random() * 4 | 0] })); let t = 0;
  (function f() { x.clearRect(0, 0, c.width, c.height); ps.forEach(p => { p.y += p.v; p.r += p.s; p.x += Math.sin(p.r) * 2; x.fillStyle = p.c; x.save(); x.translate(p.x, p.y); x.rotate(p.r); x.fillRect(-p.w / 2, -p.w / 4, p.w, p.w / 2); x.restore(); }); ++t < 280 ? requestAnimationFrame(f) : x.clearRect(0, 0, c.width, c.height); })();
}
const cardH = (c, cls = '', st = '', i = '') => { const l = esc(SYM[c.value] || c.value); return `<div class="card ${c.color} ${cls}" style="${st}" data-i="${i}"><i class="c tl">${l}</i><b class="m">${l}</b><i class="c br">${l}</i></div>`; };
const backH = '<div class="card cardback"><b class="m">UNO</b></div>';
function loading(btn, on, label) {
  if (on) { btn.dataset.h = btn.innerHTML; btn.innerHTML = `<span class="spin"></span>${label}`; btn.disabled = true; }
  else if (btn.dataset.h) { btn.innerHTML = btn.dataset.h; delete btn.dataset.h; btn.disabled = false; }
}

/* =====================================================================
 * SCREENS
 * ===================================================================== */
const SCREENS = ['land', 'create', 'join', 'room'];
function show(id) { SCREENS.forEach(x => { $('#' + x).hidden = x !== id; }); if (id !== 'room') closeModals(); if (id === 'create' || id === 'join') formFrom = id; }
function closeModals() { ['settings', 'rulesM', 'confirm', 'pick', 'over'].forEach(i => { $('#' + i).hidden = true; }); closeChatDrawer(); }
function openModal(id) { $('#' + id).hidden = false; const f = $('#' + id).querySelector('button,input'); if (f && !MOBILE.matches) f.focus({ preventScroll: true }); }
$$('.modal [data-close]').forEach(b => b.onclick = () => { b.closest('.modal').hidden = true; });
$$('.modal').forEach(m => m.addEventListener('pointerdown', e => { if (e.target === m && m.id !== 'over' && m.id !== 'pick') m.hidden = true; }));
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  for (const id of ['confirm', 'pick', 'rulesM', 'settings']) if (!$('#' + id).hidden) { $('#' + id).hidden = true; return; }
  if (MOBILE.matches) closeChatDrawer();
});

/* ---------- forms: avatar / segments ---------- */
function avatarPicker(el, onPick) {
  el.innerHTML = AV.map((a, i) => `<button type="button" role="radio" data-i="${i}" aria-label="Avatar ${i + 1}" aria-checked="${i === prof.avatar}">${a}</button>`).join('');
  el.onclick = e => { const b = e.target.closest('button'); if (!b) return; prof.avatar = +b.dataset.i; saveProf(); $$('.avs').forEach(sync); onPick && onPick(); };
  sync(el);
  function sync(x) { x.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', +b.dataset.i === prof.avatar)); }
}
function seg(el, onPick) {
  el.onclick = e => { const b = e.target.closest('button'); if (!b) return; el.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', x === b)); onPick && onPick(b.dataset.v); };
  return () => el.querySelector('[aria-checked=true]').dataset.v;
}
avatarPicker($('#cAv'));
avatarPicker($('#jAv'), () => { $('#jAvCur').textContent = AV[prof.avatar]; });
$('#jAvCur').textContent = AV[prof.avatar];
$('#cMax').innerHTML = [2, 3, 4, 5, 6, 7, 8].map(n => `<button type="button" role="radio" data-v="${n}" aria-checked="${n === 4}">${n}</button>`).join('');
const maxVal = seg($('#cMax'));
const MODE_HINT = { classic: 'Standard UNO rules.', stack: '+2 can be answered with +2, and +4 with +4. The penalty stacks up until someone has to draw.' };
const modeVal = seg($('#cMode'), v => { $('#cModeHint').textContent = MODE_HINT[v]; });
$('#cModeHint').textContent = MODE_HINT.classic;
$('#cNick').value = $('#jNick').value = prof.nick;
['#cNick', '#jNick'].forEach(s => $(s).addEventListener('input', e => { prof.nick = e.target.value; saveProf(); $('#cNick').value !== e.target.value && ($('#cNick').value = e.target.value); $('#jNick').value !== e.target.value && ($('#jNick').value = e.target.value); }));
$('#cPriv').onchange = e => { $('#cPinBox').hidden = !e.target.checked; if (e.target.checked && !$('#cPin').value) $('#cPin').value = String(1000 + Math.random() * 9000 | 0); if (e.target.checked) $('#cPin').focus(); };
$('#cPin').oninput = e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); };
$('#jPin').oninput = e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); };

/* room code input: auto-format and accept pasted codes / invite links */
function parseCode(raw) {
  raw = String(raw || '');
  const q = raw.match(/[?&#]room=([A-Za-z0-9]+)/i); if (q) raw = q[1];
  const tok = raw.split(/\s+/).find(t => t.length === CODE_LEN && [...t.toUpperCase()].every(ch => CODE_ALPHA.includes(ch)));
  return (tok || raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
}
$('#jCode').addEventListener('input', e => { e.target.value = parseCode(e.target.value); $('#jErr').textContent = ''; });
$('#jCode').addEventListener('paste', e => { const t = (e.clipboardData || window.clipboardData).getData('text'); if (t) { e.preventDefault(); $('#jCode').value = parseCode(t); $('#jErr').textContent = ''; if (prof.nick.trim()) $('#jGo').focus(); } });

$('#goCreate').onclick = () => { show('create'); setTimeout(() => !MOBILE.matches && $('#cNick').focus(), 50); };
$('#goJoin').onclick = () => { show('join'); setTimeout(() => !MOBILE.matches && ($('#jNick').value ? $('#jCode') : $('#jNick')).focus(), 50); };
$('#goRules').onclick = () => openModal('rulesM');
$$('[data-back]').forEach(b => b.onclick = () => { cancelConnect(); show('land'); });

function cleanNick(v) { return v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 12); }
$('#createForm').addEventListener('submit', e => {
  e.preventDefault();
  const n = cleanNick($('#cNick').value);
  if (!n) { $('#cErr').textContent = 'Please enter a nickname.'; $('#cNick').focus(); return; }
  const priv = $('#cPriv').checked, pin = $('#cPin').value;
  if (priv && pin.length !== 4) { $('#cErr').textContent = 'Enter a 4-digit PIN or turn off the private room.'; $('#cPin').focus(); return; }
  $('#cErr').textContent = '';
  startConnect({ create: true, name: n, avatar: prof.avatar, max: +maxVal(), mode: modeVal(), pin: priv ? pin : '' }, $('#cGo'), 'Creating…');
});
$('#joinForm').addEventListener('submit', e => {
  e.preventDefault();
  const n = cleanNick($('#jNick').value), code = parseCode($('#jCode').value);
  if (!n) { $('#jErr').textContent = 'Please enter a nickname.'; $('#jNick').focus(); return; }
  if (!code) { $('#jErr').textContent = 'Enter the room code your host shared.'; $('#jCode').focus(); return; }
  if (code.length < CODE_LEN) { $('#jErr').textContent = `Room codes have ${CODE_LEN} characters - yours has ${code.length}.`; $('#jCode').focus(); return; }
  $('#jErr').textContent = '';
  startConnect({ room: code, name: n, avatar: prof.avatar, pin: $('#jPin').value }, $('#jGo'), 'Joining…');
});

/* =====================================================================
 * CONNECTION
 * ===================================================================== */
let activeBtn = null;
function startConnect(msg, btn, label) {
  pendingJoin = msg; myName = msg.name; myAvatar = msg.avatar; joining = true; rcN = 0;
  activeBtn = btn; if (btn) loading(btn, true, label);
  unlockAudio(); connect();
}
function cancelConnect() { connGen++; joining = false; pendingJoin = null; if (ws) { try { ws.close(); } catch (e) {} } ws = null; resetBtns(); }
function resetBtns() { [$('#cGo'), $('#jGo')].forEach(b => loading(b, false)); activeBtn = null; }
function joinPayload() { return active || reconnecting ? { room, name: myName, avatar: myAvatar } : pendingJoin; }

function connect() {
  if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }
  const gen = ++connGen;
  let opened = false;
  const w = ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  const timeout = setTimeout(() => { if (!opened && gen === connGen) { try { w.close(); } catch (e) {} } }, 9000);
  w.onopen = () => {
    if (gen !== connGen) return;
    opened = true; clearTimeout(timeout);
    const p = joinPayload(); if (!p) return;
    send({ type: 'join', pid, ...p });
    clearInterval(pingT); pingT = setInterval(() => send({ type: 'ping' }), 15000);
  };
  w.onmessage = e => {
    if (gen !== connGen) return;
    let d; try { d = JSON.parse(e.data); } catch (x) { return; }
    switch (d.type) {
      case 'state': onState(d); break;
      case 'error': onError(d.msg); break;
      case 'chat': addChat(d); break;
      case 'history': loadHistory(d.items); break;
      case 'event': onEvent(d); break;
      case 'rtc': Voice.handle(d); break;
      default: break;
    }
  };
  w.onclose = () => {
    clearTimeout(timeout); clearInterval(pingT);
    if (gen !== connGen) return;
    if (active || reconnecting) scheduleReconnect();
    else if (joining) failJoin(opened ? 'Connection closed. Please try again.' : "Can't reach the server. Check your connection and try again.");
  };
}
function scheduleReconnect() {
  if (!sess.get('room') && !active) return;
  active = false; reconnecting = true;
  toast('Connection lost - reconnecting…');
  clearTimeout(rcT);
  rcT = setTimeout(connect, Math.min(8000, 800 * 2 ** Math.min(rcN++, 4)));
}
function failJoin(msg) {
  const from = formFrom;
  cancelConnect();
  if (/not found/i.test(msg)) sess.del('room');
  if (/PIN/.test(msg) && from === 'join') $('#jPinBox').hidden = false, $('#jPin').focus();
  const el = from === 'create' ? $('#cErr') : from === 'join' ? $('#jErr') : null;
  if (el && !$('#' + from).hidden) el.textContent = msg; else { show(from === 'create' || from === 'join' ? from : 'land'); toast(msg); }
}
function onError(m) {
  if (!active) {
    if (reconnecting) { // our seat is gone (expired or game started without us)
      reconnecting = false; clearTimeout(rcT); leaveLocal(/not found/i.test(m) ? 'That room no longer exists.' : m); return;
    }
    failJoin(m); return;
  }
  clickRect = null; lockUntil = 0; bad(m);
}
function leaveLocal(msg) {
  active = reconnecting = joining = false; clearTimeout(rcT); connGen++;
  if (ws) { try { ws.close(); } catch (e) {} } ws = null;
  Voice.destroy(); sess.del('room'); histCache = null; S = me = null; room = null; unread = 0; badge();
  $('#msgs').innerHTML = ''; $('#seats').innerHTML = ''; $('#fan').innerHTML = '';
  resetBtns(); show('land'); if (msg) toast(msg);
}

/* =====================================================================
 * STATE -> UI
 * ===================================================================== */
function onState(d) {
  const first = !active, prev = S;
  S = d; me = d.players.find(x => x.me); room = d.room;
  if (!me) { leaveLocal('You are no longer in that room.'); return; }
  active = true; joining = false; lockUntil = 0;
  if (first) {
    const wasReconnect = reconnecting; reconnecting = false; rcN = 0; myName = me.name; myAvatar = me.avatar;
    sess.set('room', room); resetBtns();
    show('room'); applyChatPref();
    if (wasReconnect) { toast('Back online'); if (Voice.on) Voice.resetPeers(); }
    else if (histCache) loadHistory(histCache); // history arrives just before the first state
  }
  render(prev);
}

function render(prev) {
  renderTop();
  const started = S.started;
  $('#wait').hidden = started; $('#game').hidden = !started;
  if (started) { renderGame(prev); } else { $('#over').hidden = true; renderWait(); }
  renderPeers();
  Voice.sync(S.players);
  applySpeaking();
}
function rerender() { if (!S || !active) return; renderTop(); S.started ? (renderSeats(), renderMe(), renderDock()) : renderWait(); renderPeers(); applySpeaking(); }

function micIcon(p) {
  if (!p.voice) return '';
  if (p.me) return `<span class="mic ${p.muted ? 'muted' : ''}" title="${p.muted ? 'You are muted' : 'Your mic is on'}">${p.muted ? '🔇' : '🎤'}</span>`;
  const mine = Voice.isPeerMuted(p.pub);
  return `<button type="button" class="mic ${p.muted ? 'muted' : mine ? 'theirs' : ''}" data-mute="${p.pub}" aria-label="${mine ? 'Unmute' : 'Mute'} ${esc(p.name)}" title="${mine ? 'Unmute' : 'Mute'} ${esc(p.name)}">${mine ? '🔕' : p.muted ? '🔇' : '🎤'}</button>`;
}
function onMuteClick(e) { const b = e.target.closest('[data-mute]'); if (!b) return; e.stopPropagation(); Voice.mutePeer(b.dataset.mute, !Voice.isPeerMuted(b.dataset.mute)); }
$('#seats').addEventListener('click', onMuteClick); $('#slots').addEventListener('click', onMuteClick);

function renderTop() {
  $('#chipCode').textContent = room; $('#chipN').textContent = `${S.players.length}/${S.max}`;
  const mic = $('#tbMic');
  mic.className = 'ib ' + (!Voice.on ? 'off' : Voice.muted ? 'mutedst' : 'on');
  mic.textContent = Voice.on ? '🎤' : '🎙️';
  mic.setAttribute('aria-label', !Voice.on ? 'Turn microphone on' : Voice.muted ? 'Unmute microphone' : 'Mute microphone');
  mic.title = !Voice.on ? 'Turn microphone on' : Voice.muted ? 'Unmute' : 'Mute (Settings to turn off)';
  const sb = $('#tbSnd'); sb.textContent = set.sfx ? '🔊' : '🔇'; sb.setAttribute('aria-pressed', set.sfx); sb.title = set.sfx ? 'Sound on' : 'Sound off';
}

const MODE_LABEL = { classic: 'Classic', stack: 'Stacking' };
function renderWait() {
  const n = S.players.length, max = S.max;
  $('#rc').textContent = S.room;
  let h = '';
  for (let i = 0; i < max; i++) {
    const p = S.players[i];
    h += p ? `<div class="slot full ${p.on ? '' : 'off'}" data-pub="${p.pub}"><div class="av" style="border-color:${SEATC[i % 8]}">${AV[p.avatar]}${micIcon(p)}</div><b>${esc(p.name)}</b><small>${p.me ? 'you' : p.on ? '' : 'reconnecting…'}</small>${p.host ? '<span class="badge">HOST</span>' : ''}</div>`
      : `<div class="slot"><div class="qm">+</div><small>Open seat</small></div>`;
  }
  $('#slots').innerHTML = h;
  $('#wmeta').textContent = `${MODE_LABEL[S.mode] || 'Classic'} · ${n}/${max} players${S.private ? ' · 🔒 private' + (S.pin ? ' · PIN ' + S.pin : '') : ''}`;
  $('#wst').textContent = n < S.min ? `Waiting for ${S.min - n} more player${S.min - n > 1 ? 's' : ''}… share the code!` : S.host ? (n < max ? `${n} joined - start now or wait for more` : 'Room is full - ready to start!') : 'Waiting for the host to start…';
  $('#start').hidden = !S.host; $('#start').disabled = n < S.min;
}

const RX = 40, RY = 36;
function renderSeats() {
  const n = S.players.length, ms = me.seat;
  const others = S.players.filter(x => !x.me).sort((a, b) => ((a.seat - ms + n) % n) - ((b.seat - ms + n) % n));
  $('#seats').className = n > 5 ? 'many' : '';
  $('#seats').innerHTML = others.map((o, k) => {
    const a = (90 + (k + 1) * 360 / n) * Math.PI / 180, x = 50 + RX * Math.cos(a), y = 50 + RY * Math.sin(a);
    const risk = S.unoWindow === o.pub ? 'risk' : '';
    return `<div class="seat ${o.turn ? 'turn' : ''} ${o.on ? '' : 'off'} ${risk}" data-pub="${o.pub}" data-seat="${o.seat}" title="${esc(o.name)}" style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%">
 <div class="av" style="border-color:${SEATC[o.seat % 8]}">${AV[o.avatar]}<span class="cnt">${o.count}</span>${micIcon(o)}<span class="dot"></span></div>
 <b>${esc(o.name)}</b><small>${o.score} pts${o.on ? '' : ' · offline'}</small>
 <div class="mini">${'<i></i>'.repeat(Math.min(o.count, 10))}</div>${o.uno ? '<span class="unotag">UNO!</span>' : ''}</div>`;
  }).join('');
}
function renderMe() {
  const el = $('#me'); el.className = me.turn ? 'turn' : ''; el.dataset.pub = me.pub;
  el.innerHTML = `<span class="av" style="border-color:${SEATC[me.seat % 8]}">${AV[me.avatar]}${micIcon(me)}</span><b>${esc(me.name)}</b><small>${me.score} pts</small>${me.uno ? '<span class="unotag">UNO!</span>' : ''}`;
}
function renderDock() {
  const cur = S.players.find(x => x.turn);
  let st = '';
  if (!S.over) {
    if (S.unoWindow === me.pub && !me.uno) st = 'You have ONE card - press UNO! now!';
    else if (S.pending && me.turn) st = `Stack a ${S.top.value} or tap the pile to draw ${S.pending}`;
    else if (me.turn) st = 'Your turn - play a card or tap the pile to draw';
    else st = cur ? (cur.on ? `Waiting for ${cur.name}…` : `${cur.name} is offline - skipping…`) : '';
  }
  $('#status').textContent = st;
  const canUno = !S.over && ((me.count === 1 && S.unoWindow === me.pub && !me.uno) || (me.count === 2 && me.turn && !S.armed));
  const armed = !S.over && me.count === 2 && me.turn && S.armed;
  const ub = $('#unoBtn'); ub.hidden = !(canUno || armed); ub.classList.toggle('done', armed); ub.textContent = armed ? 'UNO ✓ ready' : 'UNO!';
  const w = S.unoWindow && S.unoWindow !== me.pub && !S.over ? S.players.find(x => x.pub === S.unoWindow) : null;
  const cb = $('#catchBtn'); cb.hidden = !w; if (w) cb.textContent = `🚨 Catch ${w.name}!`;
  $('#pile').classList.toggle('hot', me.turn && !S.over);
}

function renderGame(prev) {
  $('#game').style.setProperty('--c', COL[S.color]);
  renderSeats(); renderMe(); renderDock();
  $('#top').innerHTML = S.top ? cardH(S.top) : ''; $('#ring').classList.toggle('rev', S.dir < 0); $('#pcount').textContent = S.deck;
  const pe = $('#pend'); pe.hidden = !S.pending; pe.textContent = S.pending ? `+${S.pending} stacked` : '';
  renderHand();
  if (prev && prev.started && !prev.over) animate(prev);
  clickRect = null;
  $('#over').hidden = !S.over;
  if (S.over) {
    $('#wn').textContent = S.winner ? '🏆 ' + S.winner + ' wins!' : 'Game over';
    $('#wsub').textContent = S.forfeit ? 'Everyone else left the table.' : '';
    $('#board').innerHTML = [...S.players].sort((a, b) => b.score - a.score).map(x => `<div class="row"><span>${AV[x.avatar]} ${esc(x.name)}${x.on ? '' : ' (offline)'}</span><b>${x.score} pts</b></div>`).join('');
    const ready = S.players.length >= S.min;
    $('#again').hidden = !S.host; $('#again').disabled = !ready; $('#again').textContent = ready ? 'Play again' : 'Waiting for more players…';
    $('#wh').hidden = S.host;
    if (!(prev && prev.over)) { snd('win'); confetti(); }
  }
}

function renderHand() {
  const fan = $('#fan'), hd = $('#hand'), h = S.hand, nh = h.length;
  const rot = nh > 12 ? 0 : Math.min(3, 24 / Math.max(nh, 1) + .5);
  fan.innerHTML = h.map((c, i) => { const t = nh > 1 ? i - (nh - 1) / 2 : 0; return cardH(c, S.playable[i] ? 'ok' : '', `--r:${(t * rot).toFixed(1)}deg;--y:${nh > 12 ? 0 : (t * t * .7).toFixed(1)}px`, i); }).join('');
  const first = fan.firstElementChild; if (!first) return;
  const cw = first.offsetWidth, avail = hd.clientWidth - 36;
  const step = nh > 1 ? Math.max(cw * .4, Math.min(cw * .62, (avail - cw) / (nh - 1))) : 0; // never tighter than 40% so cards stay tappable; hand scrolls instead
  [...fan.children].forEach((c, i) => { if (i) c.style.marginLeft = (step - cw) + 'px'; });
}
let rsT; addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => { if (S && S.started && active) renderHand(); }, 80); });

function animate(p) {
  const pc = {}; p.players.forEach(x => pc[x.pub] = x);
  const tr = $('#top').getBoundingClientRect(), pr = $('#pile').getBoundingClientRect(), hd = $('#fan');
  const sr = x => { const e = document.querySelector(`.seat[data-pub="${x.pub}"]`); return e && e.getBoundingClientRect(); };
  let played = false, drew = false;
  S.players.forEach(x => {
    const q = pc[x.pub]; if (!q) return;
    if (x.count < q.count) {
      played = true;
      if (x.me) { if (clickRect) fly(cardH(S.top), clickRect, tr, clickRect.width, tr.width / clickRect.width); }
      else { const r = sr(x); if (r) fly(cardH(S.top), r, tr, tr.width); }
    } else if (x.count > q.count) {
      drew = true;
      if (!x.me) { const r = sr(x); if (r) fly(backH, pr, r, tr.width, .5); }
      else for (let i = q.count; i < x.count; i++) { const el = hd.children[i]; if (el) { const r = el.getBoundingClientRect(); el.style.opacity = 0; setTimeout(() => el.style.opacity = '', 420); fly(backH, pr, r, tr.width, r.width / tr.width); } }
    }
    if (q.on && !x.on) toast(x.name + ' disconnected'); if (!q.on && x.on) toast(x.name + ' reconnected');
  });
  if (played) { $('#top').style.opacity = 0; setTimeout(() => $('#top').style.opacity = 1, 400); snd('play'); } else if (drew) snd('draw');
  const pm = pc[me.pub];
  if (me.turn && pm && !pm.turn && !S.over) { toast('Your turn!'); snd('turn'); }
  if (S.unoWindow === me.pub && p.unoWindow !== me.pub && !me.uno) toast('Press UNO! before the next player acts');
}

/* ---------- server events: UNO announcements etc. ---------- */
function onEvent(d) {
  if (d.kind === 'uno') {
    banner('UNO!', d.name + (me && d.pub === me.pub ? ' (you)' : ' has one card left')); snd('uno');
  } else if (d.kind === 'caught') {
    banner('CAUGHT!', `${d.by} caught ${d.name} - +2 cards`); snd('caught');
  }
}

/* =====================================================================
 * ACTIONS
 * ===================================================================== */
$('#start').onclick = () => send({ type: 'start' });
$('#again').onclick = () => send({ type: 'restart' });
function locked() { if (Date.now() < lockUntil) return true; lockUntil = Date.now() + 700; return false; } // blocks double taps; cleared by the next state
$('#fan').onclick = e => {
  const el = e.target.closest('.card'); if (!el || !S || !me) return;
  const i = +el.dataset.i;
  if (!me.turn) return bad('Not your turn');
  if (!S.playable[i]) return bad(S.pending ? `Stack a ${S.top.value} or draw ${S.pending}` : "Can't play that card");
  if (locked()) return;
  clickRect = el.getBoundingClientRect();
  if (S.hand[i].color === 'W') { lockUntil = 0; pickIdx = i; openModal('pick'); } else send({ type: 'play', index: i, card: S.hand[i].color + ':' + S.hand[i].value });
};
$('#pick').onclick = e => {
  if (e.target.id === 'pickCancel') { $('#pick').hidden = true; return; }
  const c = e.target.dataset.c; if (!c) return;
  $('#pick').hidden = true; if (pickIdx < 0 || !S.hand[pickIdx] || locked()) return;
  send({ type: 'play', index: pickIdx, color: c, card: S.hand[pickIdx].color + ':' + S.hand[pickIdx].value });
};
const draw = () => { if (!S || !me || S.over) return; if (!me.turn) return bad('Not your turn'); if (locked()) return; send({ type: 'draw' }); };
$('#pile').onclick = draw;
$('#pile').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); draw(); } };
$('#unoBtn').onclick = () => { send({ type: 'uno' }); };
$('#catchBtn').onclick = () => { send({ type: 'catch' }); };

/* ---------- copy ---------- */
function copyText(t, msg) {
  const done = () => toast(msg);
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(done, fallback); else fallback();
  function fallback() { const x = document.createElement('textarea'); x.value = t; x.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(x); x.select(); try { document.execCommand('copy'); } catch (e) {} x.remove(); done(); }
}
const inviteLink = () => `${location.origin}${location.pathname}?room=${room}`;
$('#copyCode').onclick = $('#rc').onclick = $('#roomChip').onclick = () => copyText(room, 'Room code copied!');
$('#copyLink').onclick = () => copyText(inviteLink(), 'Invite link copied!');

/* =====================================================================
 * CHAT  (sidebar on desktop, full-screen drawer on mobile)
 * ===================================================================== */
const chatEl = $('#chat'), roomEl = $('#room');
function badge() { ['ub1', 'ub2'].forEach(i => { const e = $('#' + i); e.hidden = !unread; e.textContent = unread > 99 ? '99+' : unread; }); }
const chatIsOpen = () => MOBILE.matches ? chatEl.classList.contains('open') : !roomEl.classList.contains('chat-min');
function applyChatPref() { roomEl.classList.toggle('chat-min', !set.chat); roomEl.classList.toggle('chat-off', !set.chat); chatEl.setAttribute('aria-hidden', String(!chatIsOpen())); }
function scrollMsgs() { const b = $('#msgs'); b.scrollTop = b.scrollHeight; }
function openChatDrawer() { chatEl.classList.add('open'); chatEl.setAttribute('aria-hidden', 'false'); unread = 0; badge(); scrollMsgs(); }
function closeChatDrawer() { chatEl.classList.remove('open'); chatEl.setAttribute('aria-hidden', 'true'); const f = document.activeElement; if (f && chatEl.contains(f)) f.blur(); }
function toggleSidebar(on) { set.chat = on; saveSet(); applyChatPref(); if (on) { unread = 0; badge(); setTimeout(scrollMsgs, 260); } }
$('#fab').onclick = openChatDrawer;
$('#tbchat').onclick = () => toggleSidebar(roomEl.classList.contains('chat-min'));
$('#chatClose').onclick = () => MOBILE.matches ? closeChatDrawer() : toggleSidebar(false);
MOBILE.addEventListener('change', () => { closeChatDrawer(); applyChatPref(); if (S && S.started) renderHand(); });
if (window.visualViewport) { const f = () => document.documentElement.style.setProperty('--vvh', visualViewport.height + 'px'); visualViewport.addEventListener('resize', f); f(); }

function chatNode(d) {
  const mine = me && d.pub === me.pub;
  const n = document.createElement('div');
  if (d.system) { n.className = 'msg sys'; n.textContent = d.text; return n; }
  const col = SEATC[(d.seat || 0) % 8];
  n.className = 'msg' + (mine ? ' me' : '');
  n.innerHTML = `<b style="color:${col}">${esc(AV[d.avatar] || '')} ${esc(d.name)}</b><time>${new Date(d.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><p>${esc(d.text)}</p>`;
  return n;
}
function addChat(d) {
  const box = $('#msgs'), near = box.scrollHeight - box.scrollTop - box.clientHeight < 80, mine = me && d.pub === me.pub;
  box.appendChild(chatNode(d));
  while (box.children.length > 150) box.removeChild(box.firstChild);
  if (near || mine) scrollMsgs();
  if (!d.system && !mine && !chatIsOpen()) { unread++; badge(); }
}
let histCache = null;
function loadHistory(items) { histCache = items; const box = $('#msgs'); box.innerHTML = ''; (items || []).forEach(d => box.appendChild(chatNode(d))); scrollMsgs(); }
$('#cin').addEventListener('submit', e => { e.preventDefault(); const i = $('#cinp'), t = i.value.trim(); if (t) { send({ type: 'chat', text: t }); i.value = ''; } });

/* =====================================================================
 * VOICE
 * ===================================================================== */
Voice.init({
  send, myPub: () => me && me.pub,
  onSpeak: () => applySpeaking(),
  onBlocked: v => { $('#audioBanner').hidden = !v; },
  onChange: why => { if (why === 'ended') toast('Microphone disconnected'); rerender(); syncSettings(); },
});
function applySpeaking() { $$('[data-pub]').forEach(el => { const av = el.classList.contains('av') ? el : el.querySelector('.av'); if (av) av.classList.toggle('speaking', Voice.isSpeaking(el.dataset.pub)); }); }
function setMicErr(m) { const e = $('#sMicErr'); e.hidden = !m; e.textContent = m || ''; }
async function micOn() {
  unlockAudio();
  try { await Voice.start(); Voice.setVolume(set.voiceVol); setMicErr(''); toast('Microphone on - you are in voice chat'); }
  catch (e) { const m = (e && e.message) || 'Could not start the microphone.'; setMicErr(m); toast(m); if (!$('#settings').hidden) return; if (e && e.code === 'denied') openModal('settings'); }
}
function micToggleQuick() { if (!Voice.on) micOn(); else { Voice.setMuted(!Voice.muted); toast(Voice.muted ? 'Microphone muted' : 'Microphone unmuted'); } }
$('#audioBanner').onclick = () => { unlockAudio(); Voice.resumeAudio(); };
$('#tbMic').onclick = micToggleQuick;
$('#sMic').onclick = () => { if (Voice.on) { Voice.stop(); toast('Microphone off'); } else micOn(); };
$('#sMute').onclick = () => Voice.setMuted(!Voice.muted);

/* =====================================================================
 * SETTINGS / LEAVE
 * ===================================================================== */
function syncSettings() {
  $('#sSfx').checked = set.sfx; $('#sUnoSnd').checked = set.unoSnd; $('#sChat').checked = set.chat;
  $('#sSfxVol').value = Math.round(set.sfxVol * 100); $('#sSfxV').textContent = Math.round(set.sfxVol * 100) + '%';
  $('#sVoiceVol').value = Math.round(set.voiceVol * 100); $('#sVoiceV').textContent = Math.round(set.voiceVol * 100) + '%';
  $('#sChatLbl').textContent = MOBILE.matches ? 'Show chat button' : 'Show chat sidebar';
  $('#sMic').textContent = Voice.on ? 'Turn microphone off' : 'Turn microphone on';
  $('#sMic').className = Voice.on ? 'ghost' : 'alt';
  const mb = $('#sMute'); mb.hidden = !Voice.on; mb.textContent = Voice.muted ? '🎤 Unmute' : '🔇 Mute';
}
function renderPeers() {
  const el = $('#sPeers'); if (!S) return;
  const o = S.players.filter(p => !p.me);
  el.innerHTML = o.length ? '<h3 style="margin:8px 0 0">Players</h3>' + o.map(p => `<div class="vrow"><span>${AV[p.avatar]} ${esc(p.name)}${p.voice ? (p.muted ? ' · muted' : ' · mic on') : ' · no mic'}</span><button class="ghost" data-mute="${p.pub}" ${p.voice ? '' : 'disabled'}>${Voice.isPeerMuted(p.pub) ? '🔕 Unmute' : '🔇 Mute for me'}</button></div>`).join('') : '';
}
$('#sPeers').addEventListener('click', onMuteClick);
$('#tbSet').onclick = () => { syncSettings(); renderPeers(); openModal('settings'); };
$('#tbSnd').onclick = () => { unlockAudio(); set.sfx = !set.sfx; saveSet(); renderTop(); syncSettings(); if (set.sfx) snd('turn'); };
$('#sSfx').onchange = e => { unlockAudio(); set.sfx = e.target.checked; saveSet(); renderTop(); if (set.sfx) snd('turn'); };
$('#sUnoSnd').onchange = e => { set.unoSnd = e.target.checked; saveSet(); if (set.unoSnd) { unlockAudio(); snd('uno'); } };
$('#sSfxVol').oninput = e => { set.sfxVol = e.target.value / 100; $('#sSfxV').textContent = e.target.value + '%'; saveSet(); };
$('#sSfxVol').onchange = () => { unlockAudio(); snd('play'); };
$('#sVoiceVol').oninput = e => { set.voiceVol = e.target.value / 100; $('#sVoiceV').textContent = e.target.value + '%'; saveSet(); Voice.setVolume(set.voiceVol); };
$('#sChat').onchange = e => { if (MOBILE.matches) { set.chat = e.target.checked; saveSet(); applyChatPref(); } else toggleSidebar(e.target.checked); };
$('#sRules').onclick = () => { $('#settings').hidden = true; openModal('rulesM'); };

function askLeave() {
  const n = S ? S.players.length : 0, inGame = S && S.started && !S.over;
  let t = inGame ? 'You will be removed from the game and your cards go back into the deck.' : 'You will leave this room.';
  if (S && S.host && n > 1) { const nx = S.players.find(p => !p.me && p.on) || S.players.find(p => !p.me); t += ` You are the host - ${nx.name} will become the new host.`; }
  if (inGame && n <= 2) t += ' The other player will win by default.';
  $('#cfP').textContent = t; $('#settings').hidden = true; openModal('confirm');
}
$('#sLeave').onclick = $('#wLeave').onclick = $('#oLeave').onclick = askLeave;
$('#cfNo').onclick = () => { $('#confirm').hidden = true; };
$('#cfYes').onclick = () => { send({ type: 'leave' }); leaveLocal('You left the game'); };

/* =====================================================================
 * BOOT
 * ===================================================================== */
for (let i = 0; i < 14; i++) $('#bg').insertAdjacentHTML('beforeend', cardH({ color: 'RGBY'[i % 4], value: ['0', '5', '7', 'SKIP', 'REV', '+2', '9'][i % 7] }, '', `--cw:${50 + Math.random() * 50}px;left:${Math.random() * 100}%;animation-duration:${14 + Math.random() * 14}s;animation-delay:-${Math.random() * 20}s`));
syncSettings();
addEventListener('pagehide', () => { try { Voice.destroy(); } catch (e) {} });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { Voice.resumeAudio(); if (S && active && ws && ws.readyState !== 1) { clearTimeout(rcT); scheduleReconnect(); } } });

const urlRoom = parseCode(new URLSearchParams(location.search).get('room') || '');
const savedRoom = sess.get('room');
if (savedRoom) { // refreshed mid-game: silently rejoin the same seat
  room = savedRoom; myName = prof.nick || 'Player'; myAvatar = prof.avatar; reconnecting = true; connect();
} else if (urlRoom) {
  $('#jCode').value = urlRoom; show('join'); $('#jNick').value || setTimeout(() => !MOBILE.matches && $('#jNick').focus(), 100);
} else show('land');
if (urlRoom && history.replaceState) history.replaceState(null, '', location.pathname);
