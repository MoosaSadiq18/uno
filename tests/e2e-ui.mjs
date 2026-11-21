// Browser end-to-end tests (Playwright + Chromium) against a running server.
//   java -Duno.graceLobby=2 -Duno.graceGame=3 -jar target/uno-1.0.0.jar --server.port=8099 &
//   node tests/e2e-ui.mjs http://localhost:8099 [filter]
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8099', FILTER = process.argv[3] || '';
const WSU = BASE.replace('http', 'ws') + '/ws';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 5000, step = 50) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await f(); if (v) return v; await sleep(step); } return false; };

const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const browser = await chromium.launch({ args: ARGS });
const VP = {
  phone: { ...devices['iPhone 13'], permissions: ['microphone', 'clipboard-read', 'clipboard-write'] },
  phoneSE: { viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, permissions: ['microphone'] },
  landscape: { viewport: { width: 740, height: 360 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1, permissions: ['microphone'] },
  tablet: { viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true, permissions: ['microphone'] },
  desktop: { viewport: { width: 1366, height: 768 }, permissions: ['microphone', 'clipboard-read', 'clipboard-write'] },
};
const ctxs = [];
async function newPage(vp = 'desktop', extra = {}) {
  const ctx = await browser.newContext({ ...VP[vp], ...extra }); ctxs.push(ctx);
  const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  await page.goto(BASE); return page;
}
async function closeAll() { for (const c of ctxs.splice(0)) await c.close().catch(() => {}); }

/* ---------- WS bot (a player with no UI) ---------- */
class Bot {
  constructor(name, pol = {}) { this.name = name; this.pid = 'bot-' + name + '-' + Math.random().toString(36).slice(2) + 'xxxx'; this.pol = pol; this.chats = []; this.events = []; this.errors = []; this.auto = true; }
  async join(room) {
    this.ws = new WebSocket(WSU); await new Promise(r => this.ws.onopen = r);
    this.ws.onmessage = e => { const d = JSON.parse(e.data); if (d.type === 'state') { this.s = d; this.react(); } else if (d.type === 'chat') this.chats.push(d); else if (d.type === 'event') this.events.push(d); else if (d.type === 'error') this.errors.push(d.msg); };
    this.send({ type: 'join', room, name: this.name, pid: this.pid, avatar: 2 });
    await until(() => this.s); return this;
  }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  get me() { return this.s.players.find(p => p.me); }
  react() {
    const s = this.s, m = this.me; if (!m) return;
    if (s.unoWindow && s.unoWindow !== m.pub) { if (this.pol.catch && !this._c) { this._c = s.unoWindow; setTimeout(() => this.send({ type: 'catch' }), this.pol.catchDelay ?? 30); } }
    else this._c = null;
    if (s.unoWindow === m.pub && this.pol.call && !this._u) { this._u = 1; setTimeout(() => this.send({ type: 'uno' }), 40); } else if (s.unoWindow !== m.pub) this._u = 0;
    if (!this.auto || !s.started || s.over || !m.turn || this._busy === s.log + s.hand.length) return;
    this._busy = s.log + s.hand.length;
    setTimeout(() => {
      const st = this.s; if (!st || !st.started || st.over || !this.me.turn) return;
      const i = st.playable.findIndex(Boolean);
      if (i < 0) this.send({ type: 'draw' });
      else { if (this.pol.call && st.hand.length === 2) this.send({ type: 'uno' }); this.send({ type: 'play', index: i, color: 'GBRY'[Math.random() * 4 | 0], card: st.hand[i].color + ':' + st.hand[i].value }); }
    }, this.pol.think ?? 40);
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

/* ---------- UI helpers ---------- */
const S = p => p.evaluate(() => typeof S === 'undefined' || !S ? null : JSON.parse(JSON.stringify({ ...S, me: me })));
async function createRoom(page, { name = 'Host', max = 4, mode, pin } = {}) {
  await page.click('#goCreate'); await page.fill('#cNick', name);
  await page.click(`#cMax [data-v="${max}"]`);
  if (mode) await page.click(`#cMode [data-v="${mode}"]`);
  if (pin) { await page.check('#cPriv'); await page.fill('#cPin', pin); }
  await page.click('#cGo'); await page.waitForSelector('#wait:not([hidden])');
  return (await page.textContent('#rc')).trim();
}
async function joinRoom(page, code, name) {
  await page.click('#goJoin'); await page.fill('#jNick', name); await page.fill('#jCode', code); await page.click('#jGo');
  await page.waitForSelector('#room:not([hidden])');
}
async function startGame(page) { await page.click('#start'); await page.waitForSelector('#game:not([hidden])'); await sleep(300); }

/** Plays the UI player's turn via real clicks. Returns what it did. */
async function uiTurn(page, opts = {}) {
  const st = await page.evaluate(() => ({ turn: me && me.turn, over: S && S.over, n: me && me.count, arm: S && S.armed, uno: !!document.querySelector('#unoBtn:not([hidden]):not(.done)'), pick: !$('#pick').hidden }));
  if (st.over) return 'over';
  if (st.pick) { await page.click('#pick [data-c="R"]'); return 'pick'; }
  if (!st.turn) return 'wait';
  if (st.n === 2 && st.uno && opts.arm) { await page.click('#unoBtn'); await sleep(150); opts.onArm && await opts.onArm(); }
  const ok = page.locator('#fan .card.ok');
  if (await ok.count()) {
    // aim at a spot that really belongs to the first playable card (like a finger on its visible face)
    const pt = await page.evaluate(() => {
      const el = document.querySelector('#fan .card.ok'); if (!el) return null;
      el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      const r = el.getBoundingClientRect(), hd = document.querySelector('#hand').getBoundingClientRect();
      for (const fx of [.5, .35, .25, .65, .8, .15]) for (const fy of [.5, .35, .65]) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy; if (x < hd.left || x > hd.right) continue;
        const t = document.elementFromPoint(x, y); if (t && t.closest('.card') === el) return { x, y };
      }
      return null;
    });
    if (!pt) return 'wait';
    await page.mouse.click(pt.x, pt.y);
    await sleep(60);
    if (!(await page.locator('#pick').isHidden())) await page.click('#pick [data-c="B"]');
    return 'play';
  }
  await page.click('#pile'); return 'draw';
}
async function playUntil(page, cond, max = 400, opts = {}) {
  for (let i = 0; i < max; i++) {
    if (await cond()) return true;
    const r = await uiTurn(page, opts);
    if (r === 'over') return await cond();
    await sleep(r === 'wait' ? 40 : 90);
  }
  return false;
}

const group = async (name, fn) => { if (FILTER && !name.toLowerCase().includes(FILTER.toLowerCase())) return; console.log('\n' + name); try { await fn(); } catch (e) { fail++; console.log('  ✗ EXCEPTION', e.message.split('\n').slice(0, 14).join('\n')); } await closeAll(); };

/* ===================================================================== */

await group('Create/Join flows on mobile (13, 14)', async () => {
  const h = await newPage('phone'), g = await newPage('phone');
  ok(await h.evaluate(() => typeof ac === 'undefined' || ac === undefined), 'no AudioContext before any user gesture (no autoplay)');
  await h.click('#goCreate'); await h.click('#cGo');
  ok(/nickname/i.test(await h.textContent('#cErr')), 'create: clear validation when nickname is empty');
  await h.fill('#cNick', 'Hannah');
  await h.click('#cMax [data-v="3"]'); await h.click('#cMode [data-v="stack"]');
  ok((await h.textContent('#cModeHint')).includes('stack'), 'mode hint explains stacking');
  await h.click('#cAv button:nth-child(5)');
  await h.click('#cGo'); await h.waitForSelector('#wait:not([hidden])');
  const code = (await h.textContent('#rc')).trim();
  ok(/^[A-Z2-9]{5}$/.test(code), `prominent room code shown: ${code}`);
  ok((await h.locator('#slots .slot').count()) === 3 && (await h.locator('#slots .slot.full').count()) === 1, 'waiting room: 3 slots, 1 occupied, 2 empty');
  ok(await h.locator('#start').isDisabled(), 'host cannot start with 1 player');
  await h.click('#copyCode'); await sleep(200);
  ok((await h.evaluate(() => navigator.clipboard.readText())) === code, 'one-click copy puts the code on the clipboard');
  await h.click('#copyLink'); ok((await h.evaluate(() => navigator.clipboard.readText())).endsWith('?room=' + code), 'invite link copied');
  ok(await h.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'waiting room: no horizontal scroll');

  // join: validation + helpful errors
  await g.click('#goJoin'); await g.click('#jGo');
  ok(/nickname/i.test(await g.textContent('#jErr')), 'join: nickname validation');
  await g.fill('#jNick', 'Gus'); await g.click('#jGo');
  ok(/room code/i.test(await g.textContent('#jErr')), 'join: code validation');
  await g.fill('#jCode', 'ab'); await g.click('#jGo');
  ok(/5 characters/.test(await g.textContent('#jErr')), 'join: short code message');
  await g.fill('#jCode', 'ab-cd e'); ok((await g.inputValue('#jCode')) === 'ABCDE', 'code input auto-formats (upper-case, strips junk)');
  await g.fill('#jCode', 'zzzzz'); await g.click('#jGo');
  await until(async () => /not found/i.test(await g.textContent('#jErr')));
  ok(/not found/i.test(await g.textContent('#jErr')), 'join: "Room not found" error, stays on form');
  ok(await g.locator('#jGo').isEnabled(), 'join button re-enabled after error');
  await g.evaluate(c => { const i = document.querySelector('#jCode'); i.focus(); const dt = new DataTransfer(); dt.setData('text', 'Join my UNO game: ' + location.origin + '/?room=' + c); i.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, code);
  ok((await g.inputValue('#jCode')) === code, 'pasting an invite link extracts the room code');
  const loadingSeen = await g.evaluate(() => { const b = document.querySelector('#jGo'); b.click(); return b.disabled && b.textContent.includes('Joining'); });
  ok(loadingSeen, 'loading state ("Joining…") shown immediately while connecting');
  await g.waitForSelector('#room:not([hidden])');
  await until(async () => (await h.locator('#slots .slot.full').count()) === 2);
  ok((await h.locator('#slots .slot.full').count()) === 2 && (await g.locator('#slots .slot.full').count()) === 2, 'both players see 2 joined (synced)');
  ok(await h.locator('#start').isEnabled(), 'host can start once minimum players reached');
  ok(await g.locator('#start').isHidden(), 'non-host has no start button');
  const bot = await new Bot('Third').join(code);
  await startGame(h); await g.waitForSelector('#game:not([hidden])');
  ok(await h.locator('#fan .card').count() === 7 && await g.locator('#fan .card').count() === 7, 'game starts on both phones with 7 cards each');
  // full mobile game: UI plays on phone G vs bot + host bot-ish
  bot.close();
});

await group('Private room PIN on join form', async () => {
  const h = await newPage('phone'), g = await newPage('phone');
  const code = await createRoom(h, { name: 'Pia', max: 2, pin: '1234' });
  ok((await h.textContent('#wmeta')).includes('1234'), 'host sees the PIN in the waiting room');
  await g.click('#goJoin'); await g.fill('#jNick', 'Gil'); await g.fill('#jCode', code); await g.click('#jGo');
  await until(async () => await g.locator('#jPinBox').isVisible());
  ok(/PIN/.test(await g.textContent('#jErr')) && await g.locator('#jPinBox').isVisible(), 'PIN field appears with a clear message');
  await g.fill('#jPin', '9999'); await g.click('#jGo'); await until(async () => /Wrong PIN/.test(await g.textContent('#jErr')));
  ok(/Wrong PIN/.test(await g.textContent('#jErr')), 'wrong PIN rejected');
  await g.fill('#jPin', '1234'); await g.click('#jGo'); await g.waitForSelector('#room:not([hidden])');
  ok(true, 'correct PIN joins');
  const x = await newPage('phone'); await x.click('#goJoin'); await x.fill('#jNick', 'Xi'); await x.fill('#jCode', code); await x.click('#jGo'); await until(async () => await x.locator('#jPinBox').isVisible()); await x.fill('#jPin', '1234'); await x.click('#jGo');
  await until(async () => /full/i.test(await x.textContent('#jErr')));
  ok(/full/i.test(await x.textContent('#jErr')), 'full room: helpful error');
});

await group('Layouts: 2-8 players on phone / small phone / landscape / tablet / desktop (1, 7)', async () => {
  const check = async (page, label, n) => {
    const r = await page.evaluate(() => {
      const R = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      const hit = (a, b) => a.l < b.r - 1 && a.r > b.l + 1 && a.t < b.b - 1 && a.b > b.t + 1;
      const out = { hscroll: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1, issues: [] };
      const seats = [...document.querySelectorAll('.seat')].map(e => ({ e, r: R(e) }));
      const keep = ['#top', '#pile', '#dock', '#hand', '#topbar'].map(s => [s, R(document.querySelector(s))]);
      seats.forEach((a, i) => {
        seats.slice(i + 1).forEach(b => hit(a.r, b.r) && out.issues.push('seat/seat'));
        keep.forEach(([s, k]) => hit(a.r, k) && out.issues.push('seat/' + s));
        if (a.r.l < -1 || a.r.r > innerWidth + 1 || a.r.t < 0) out.issues.push('seat offscreen');
      });
      const dock = R(document.querySelector('#dock')), hand = R(document.querySelector('#hand')), table = R(document.querySelector('#table'));
      if (hand.b > innerHeight + 1) out.issues.push('hand below viewport');
      const unoB = document.querySelector('#unoBtn');
      const tb = R(document.querySelector('#topbar')); if (hit(table, tb)) out.issues.push('table/topbar');
      const chat = document.querySelector('#chat'), cr = R(chat), vis = getComputedStyle(chat).visibility !== 'hidden' && cr.r > 0 && cr.l < innerWidth;
      if (vis && matchMedia('(max-width:820px),(max-height:520px)').matches) out.issues.push('chat drawer visible by default on mobile');
      if (vis && cr.w !== 0) { [table, hand, dock].forEach(k => hit(cr, k) && out.issues.push('chat overlaps game')); }
      const topC = R(document.querySelector('#top')), pile = R(document.querySelector('#pile'));
      out.tableH = table.b - table.t; out.cardsOk = hit(topC, pile) === false;
      const fan = document.querySelector('#fan'); out.cards = fan.children.length;
      return out;
    });
    ok(!r.hscroll && r.issues.length === 0 && r.cardsOk && r.tableH > 100, `${label} ${n}p: no h-scroll, no overlaps (table ${Math.round(r.tableH)}px)${r.issues.length ? ' ISSUES ' + [...new Set(r.issues)] : ''}`);
  };
  for (const vp of ['phone', 'phoneSE', 'landscape', 'tablet', 'desktop']) {
    for (const n of [2, 3, 5, 8]) {
      const p = await newPage(vp), code = await createRoom(p, { max: 8 });
      const bots = []; for (let i = 1; i < n; i++) { const b = await new Bot('Player' + i + 'WithLongName').join(code); b.auto = false; bots.push(b); }
      await until(async () => (await S(p)).players.length === n);
      await startGame(p); await sleep(250);
      await check(p, vp, n);
      bots.forEach(b => b.close()); await p.context().close();
    }
  }
});

await group('Chat: mobile drawer + desktop sidebar (10)', async () => {
  const m = await newPage('phone'), code = await createRoom(m, { max: 3 });
  const b1 = await new Bot('Ann').join(code), b2 = await new Bot('Bo').join(code); b1.auto = b2.auto = false;
  await startGame(m);
  const geo = () => m.evaluate(() => { const r = e => document.querySelector(e).getBoundingClientRect(); const c = r('#chat'); return { chatVisible: getComputedStyle(document.querySelector('#chat')).visibility !== 'hidden' && c.top < innerHeight - 5, fab: r('#fab').width > 0 }; });
  ok((await geo()).chatVisible === false && (await geo()).fab, 'mobile: chat hidden by default, floating chat icon present');
  b1.send({ type: 'chat', text: 'hello from Ann' }); b2.send({ type: 'chat', text: 'second' });
  await until(async () => (await m.textContent('#ub2')) === '2');
  ok((await m.textContent('#ub2')) === '2' && await m.locator('#ub2').isVisible(), 'unread badge counts 2 on the floating icon');
  await m.click('#fab'); await sleep(350);
  const open = await m.evaluate(() => { const c = document.querySelector('#chat').getBoundingClientRect(); return { top: c.top, w: c.width, h: c.height, vw: innerWidth, vh: innerHeight, msgs: document.querySelectorAll('#msgs .msg:not(.sys)').length, badgeHidden: document.querySelector('#ub2').hidden }; });
  ok(open.top <= 1 && open.w >= open.vw - 1 && open.msgs === 2 && open.badgeHidden, 'drawer opens full-screen with messages; badge cleared');
  ok(await m.locator('#chatClose').isVisible(), 'clear close button visible');
  await m.fill('#cinp', 'my reply'); await m.click('#cin button');
  await until(async () => (await m.locator('#msgs .msg.me').count()) === 1);
  ok(b1.chats.some(c => c.text === 'my reply'), 'message sent and received by the room');
  const sfx0 = await m.evaluate(() => JSON.stringify(set));
  await m.click('#chatClose'); await sleep(350);
  ok((await geo()).chatVisible === false, 'closing chat returns to the game immediately');
  ok((await m.evaluate(() => JSON.stringify(set))) === sfx0, 'chat interactions never touch sound settings');
  const el = await m.evaluate(() => { const b = document.querySelector('#fan .card').getBoundingClientRect(); const e = document.elementFromPoint(b.left + 8, b.top + 30); return !!e.closest('#fan'); });
  ok(el, 'hand is reachable (not covered) after closing chat');
  b1.send({ type: 'chat', text: 'while closed' }); await until(async () => (await m.textContent('#ub2')) === '1');
  ok((await m.textContent('#ub2')) === '1', 'unread badge resumes counting while closed');

  // desktop sidebar
  const d = await newPage('desktop'), dc = await createRoom(d, { max: 3 });
  const c1 = await new Bot('Cy').join(dc); c1.auto = false; const c2 = await new Bot('Di').join(dc); c2.auto = false; await startGame(d);
  const dg = () => d.evaluate(() => { const r = s => document.querySelector(s).getBoundingClientRect(); const c = r('#chat'), t = r('#table'), h = r('#hand'); const hit = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom && a.bottom > b.top; return { w: c.width, overlap: hit(c, t) || hit(c, h) || hit(c, r('#dock')), vis: getComputedStyle(document.querySelector('#chat')).visibility }; });
  let g1 = await dg(); ok(g1.w > 250 && !g1.overlap, `desktop: sidebar open (${Math.round(g1.w)}px) and never overlaps table/hand`);
  await d.click('#chatClose'); await sleep(450); g1 = await dg();
  ok(g1.w === 0 && g1.vis === 'hidden', 'desktop: minimize collapses the sidebar and the table expands');
  c1.send({ type: 'chat', text: 'ping' }); await until(async () => (await d.textContent('#ub1')) === '1');
  ok((await d.textContent('#ub1')) === '1', 'desktop: unread badge on top-bar chat button while minimized');
  await d.click('#tbchat'); await sleep(450); g1 = await dg();
  ok(g1.w > 250 && !g1.overlap && await d.locator('#ub1').isHidden(), 'expand via top bar; badge cleared');
  ok(await d.evaluate(() => JSON.parse(localStorage.getItem('uno.settings')).chat === true), 'chat visibility persisted');
});

await group('Sound controls independent of chat (3, 11)', async () => {
  const p = await newPage('desktop'), code = await createRoom(p, { max: 2 });
  const b = await new Bot('Sam').join(code); b.auto = false; await startGame(p);
  ok(await p.evaluate(() => !!ac && ac.state === 'running'), 'audio engine only started after user interaction');
  ok(await p.evaluate(() => !document.querySelector('#chat #tbSnd, #chat #sSfx, #chat .ib#tbSnd')), 'no sound control lives inside / over the chat');
  ok(await p.evaluate(() => { const s = document.querySelector('#tbSnd').getBoundingClientRect(), c = document.querySelector('#chat').getBoundingClientRect(); return s.bottom <= c.top + 1; }), 'sound toggle is in the top bar, above (not over) the chat column');
  await p.click('#tbSnd');
  ok(await p.evaluate(() => JSON.parse(localStorage.getItem('uno.settings')).sfx === false), 'top-bar toggle turns sound off and persists');
  for (let i = 0; i < 3; i++) { await p.fill('#cinp', 'msg' + i); await p.press('#cinp', 'Enter'); }
  await p.click('#chatClose'); await p.click('#tbchat');
  ok(await p.evaluate(() => set.sfx === false && document.querySelector('#tbSnd').textContent === '🔇'), 'sending chat / toggling chat does not change sound state');
  await p.click('#tbSet');
  await p.evaluate(() => { const r = document.querySelector('#sSfxVol'); r.value = 30; r.dispatchEvent(new Event('input')); const v = document.querySelector('#sVoiceVol'); v.value = 55; v.dispatchEvent(new Event('input')); });
  ok(await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('uno.settings')); return s.sfxVol === .3 && s.voiceVol === .55; }), 'separate sound-effects and voice volumes saved');
  await p.reload(); await p.waitForSelector('#room:not([hidden])');
  ok(await p.evaluate(() => set.sfx === false && set.sfxVol === .3 && set.voiceVol === .55), 'preferences survive a reload (localStorage)');
  // sound off => nothing scheduled
  const played = await p.evaluate(() => { let n = 0; if (!ac) unlockAudio(); const o = ac.createOscillator; ac.createOscillator = function () { n++; return o.apply(this, arguments); }; snd('play'); snd('uno'); return n; });
  ok(played === 0, 'no sound plays while disabled');
  await p.click('#tbSet'); await p.check('#sSfx'); await p.check('#sUnoSnd');
  ok(await p.evaluate(() => set.sfx === true && !document.querySelector('#settings').hidden), 'settings toggle re-enables sound');
  await p.evaluate(() => { document.querySelector('#sUnoSnd').checked = false; document.querySelector('#sUnoSnd').dispatchEvent(new Event('change')); });
  const n2 = await p.evaluate(() => { let n = 0; const o = ac.createOscillator; ac.createOscillator = function () { n++; return o.apply(this, arguments); }; snd('uno'); const a = n; snd('play'); return [a, n]; });
  ok(n2[0] === 0 && n2[1] > 0, 'UNO announcement sound can be disabled separately');
});

await group('UNO via the UI: call (armed), call (window), forget -> penalty, catch (4, 5, 6)', async () => {
  // A1: press UNO ahead of the second-to-last card
  for (const mode of ['arm', 'window']) {
    let done = false;
    for (let attempt = 0; attempt < 6 && !done; attempt++) {
      const p = await newPage('desktop'), code = await createRoom(p, { max: 3 });
      const b1 = await new Bot('B1', { call: true, think: 700 }).join(code), b2 = await new Bot('B2', { call: true, think: 700 }).join(code);
      await startGame(p);
      let sawBtn = false, bannerOk = false, info = null;
      const cond = async () => {
        const s = await p.evaluate(() => ({ c: me && me.count, uno: me && me.uno, over: S && S.over, banner: document.querySelector('#banner b').textContent, btn: !document.querySelector('#unoBtn').hidden, done: document.querySelector('#unoBtn').classList.contains('done'), turn: me && me.turn, win: S && S.unoWindow === me.pub }));
        if (s.over) return true;
        if (mode === 'window' && s.c === 1 && s.win && !s.uno) { sawBtn = s.btn; await p.click('#unoBtn'); await sleep(250); info = await p.evaluate(() => ({ uno: me.uno, banner: document.querySelector('#banner b').textContent, tag: !!document.querySelector('#me .unotag'), st: document.querySelector('#unoBtn').hidden })); return true; }
        if (mode === 'arm' && s.c === 1 && s.uno) { info = { uno: true, banner: s.banner }; return true; }
        return false;
      };
      const reached = await playUntil(p, cond, 500, mode === 'arm' ? { arm: true, onArm: async () => { sawBtn = true; const d = await p.evaluate(() => document.querySelector('#unoBtn').classList.contains('done')); if (!d) sawBtn = false; } } : {});
      if (reached && info) {
        done = true;
        if (mode === 'arm') ok(sawBtn, 'UNO button appears on your turn with 2 cards and shows "ready" once pressed');
        else ok(sawBtn, 'prominent UNO button appears when you are left with one card');
        ok(info.uno, `server marks me as UNO-called (${mode})`);
        ok(info.banner === 'UNO!', 'visual UNO announcement shown');
        if (mode === 'window') ok(info.tag && info.st, 'UNO tag shown on my avatar; button gone after calling');
      }
      await closeAll();
    }
    ok(done, `UNO ${mode} scenario reached`);
  }
  // B: forget -> bot catches -> +2
  { let done = false;
    for (let attempt = 0; attempt < 8 && !done; attempt++) {
      const p = await newPage('desktop'), code = await createRoom(p, { max: 3 });
      const b1 = await new Bot('B1', { catch: true, catchDelay: 100, think: 700 }).join(code), b2 = await new Bot('B2', { catch: true, catchDelay: 100, think: 700 }).join(code);
      await startGame(p);
      let res = null;
      const cond = async () => {
        const s = await p.evaluate(() => ({ c: me && me.count, over: S && S.over, banner: document.querySelector('#banner b').textContent, sub: document.querySelector('#banner small').textContent }));
        if (s.over) return true;
        if (s.banner === 'CAUGHT!' && /caught Host/.test(s.sub)) { await sleep(150); res = await p.evaluate(() => ({ c: me.count, banner: document.querySelector('#banner b').textContent, sub: document.querySelector('#banner small').textContent, win: S.unoWindow })); return true; }
        return false;
      };
      await playUntil(p, cond, 500, {});
      if (res) { done = true; ok(res.c === 3, 'forgot UNO + caught -> I got exactly 2 penalty cards (1 -> 3)'); ok(res.banner === 'CAUGHT!' && /caught/.test(res.sub), 'everyone sees the CAUGHT announcement'); }
      await closeAll();
    }
    ok(done, 'forget/penalty scenario reached'); }
  // C: bot forgets, UI user catches
  { let done = false;
    for (let attempt = 0; attempt < 10 && !done; attempt++) {
      const p = await newPage('desktop'), code = await createRoom(p, { max: 3 });
      const b1 = await new Bot('B1', { think: 700 }).join(code), b2 = await new Bot('B2', { think: 700 }).join(code);
      await startGame(p);
      let res = null;
      const cond = async () => {
        const s = await p.evaluate(() => ({ over: S && S.over, w: S && S.unoWindow && S.unoWindow !== me.pub ? S.unoWindow : null, btn: !document.querySelector('#catchBtn').hidden, txt: document.querySelector('#catchBtn').textContent, cnt: S && S.unoWindow ? (S.players.find(x => x.pub === S.unoWindow) || {}).count : 0 }));
        if (s.over) return true;
        if (s.w && s.btn) { await p.click('#catchBtn'); await sleep(300);
          res = await p.evaluate(w => ({ c: S.players.find(x => x.pub === w).count, win: S.unoWindow, banner: document.querySelector('#banner b').textContent, hidden: document.querySelector('#catchBtn').hidden }), s.w); res.txt = s.txt; return true; }
        return false;
      };
      await playUntil(p, cond, 500, {});
      if (res) { done = true; ok(/Catch/.test(res.txt), `Catch button shown to other players ("${res.txt}")`); ok(res.c === 3, 'catching a player who forgot gives them 2 cards (1 -> 3)'); ok(res.win === null && res.hidden, 'catch window closes and button disappears'); ok(res.banner === 'CAUGHT!', 'announcement shown'); }
      await closeAll();
    }
    ok(done, 'catch scenario reached'); }
});

await group('Full games through the UI: 8 players desktop, 2 players phone (1, 2, 3, 13)', async () => {
  for (const [vp, n] of [['desktop', 8], ['phone', 2], ['phoneSE', 4]]) {
    const p = await newPage(vp), code = await createRoom(p, { max: n, mode: n === 8 ? 'stack' : 'classic' });
    const bots = []; for (let i = 1; i < n; i++) bots.push(await new Bot('Bot' + i, { think: 15, call: true }).join(code));
    await startGame(p);
    const over = await playUntil(p, async () => !(await p.locator('#over').isHidden()), 900, { arm: true });
    ok(over, `${n}-player game on ${vp} played to the end through the UI`);
    const info = await p.evaluate(() => ({ rows: document.querySelectorAll('#board .row').length, title: document.querySelector('#wn').textContent, hs: document.documentElement.scrollWidth <= innerWidth }));
    ok(info.rows === n && /wins/.test(info.title) && info.hs, `${vp}: winner screen lists all ${n} players (${info.title})`);
    ok(p.errors.length === 0, `no JS errors (${p.errors[0] || 'none'})`);
    bots.forEach(b => b.close());
    await p.context().close();
  }
});

await group('Settings, leave & host handover (7, 8, 10)', async () => {
  const h = await newPage('phone'), code = await createRoom(h, { max: 4, name: 'Hosty' });
  const b1 = await new Bot('B1').join(code), b2 = await new Bot('B2').join(code); b1.auto = b2.auto = false;
  await startGame(h);
  await h.click('#tbSet');
  const items = await h.evaluate(() => ['sSfx', 'sSfxVol', 'sVoiceVol', 'sMic', 'sChat', 'sRules', 'sLeave'].every(i => document.getElementById(i) && document.getElementById(i).offsetParent !== null));
  ok(items, 'settings has sound toggle, both volumes, mic controls, chat visibility, rules, leave');
  await h.click('#sRules'); ok(await h.locator('#rulesM').isVisible() && /UNO!/.test(await h.textContent('#rulesM')), 'rules/help opens'); await h.click('#rulesM [data-close]');
  await h.click('#tbSet'); await h.click('#sLeave');
  ok(await h.locator('#confirm').isVisible() && /host/.test(await h.textContent('#cfP')), 'confirmation dialog appears and warns the host about handover');
  await h.click('#cfNo'); ok(await h.locator('#game').isVisible() && !!(await S(h)), 'cancel keeps me in the game');
  await h.click('#tbSet'); await h.click('#sLeave'); await h.click('#cfYes');
  await until(async () => await h.locator('#land').isVisible());
  ok(await h.locator('#land').isVisible(), 'confirm returns to the landing page');
  await until(() => b1.s && b1.s.players.length === 2);
  ok(b1.s.players.length === 2 && !b1.s.players.some(p => p.name === 'Hosty'), 'no ghost seat: leaver removed for remaining players');
  ok(b1.chats.some(c => c.system && /Hosty left/.test(c.text)), 'remaining players notified');
  ok([b1, b2].filter(b => b.s.host).length === 1 && /now the host/.test(b1.chats.map(c => c.text).join('|')), 'a new host was assigned automatically');
  ok(b1.s.started && !b1.s.over, 'game continues with 2 players');
  const nh = [b1, b2].find(b => b.s.host); ok(!!nh, 'room remains operational');
  b1.close(); b2.close();
});

await group('Disconnect / reconnect (9)', async () => {
  const p = await newPage('desktop'), code = await createRoom(p, { max: 3, name: 'Rex' });
  const b1 = await new Bot('B1').join(code), b2 = await new Bot('B2').join(code); b1.auto = b2.auto = false; await startGame(p);
  const hand0 = await p.evaluate(() => JSON.stringify(S.hand));
  await p.evaluate(() => ws.close()); // simulate a dropped connection
  await until(() => b1.s.players.find(x => x.name === 'Rex' && !x.on), 3000);
  ok(!!b1.s.players.find(x => x.name === 'Rex' && !x.on), 'others see Rex offline while seat is held');
  await until(async () => (await p.evaluate(() => active)) === true, 8000);
  const back = await p.evaluate(() => ({ hand: JSON.stringify(S.hand), active, started: S.started }));
  ok(back.active && back.hand === hand0 && back.started, 'client auto-reconnects to the same seat with the same hand');
  await until(() => b1.s.players.find(x => x.name === 'Rex' && x.on));
  ok(!!b1.s.players.find(x => x.name === 'Rex' && x.on), 'others see Rex online again');
  await p.reload(); await p.waitForSelector('#game:not([hidden])', { timeout: 8000 });
  ok((await p.evaluate(() => JSON.stringify(S.hand))) === hand0, 'page refresh rejoins the same seat and hand');
  ok(await p.evaluate(() => document.querySelectorAll('#msgs .msg').length > 0), 'chat history restored after refresh');
  // full outage longer than grace -> seat freed, client told
  await p.evaluate(() => { sessionStorage.setItem('keep', '1'); window.WebSocket = class { constructor() { throw new Error('offline'); } }; ws.close(); });
  await until(() => b1.s.players.length === 2, 8000);
  ok(b1.s.players.length === 2, 'ghost seat freed after the grace period if the player never returns');
  b1.close(); b2.close();
});

await group('Voice chat: real WebRTC between players (6, 12)', async () => {
  const mk = async (n) => {
    const pages = [await newPage('desktop')]; const code = await createRoom(pages[0], { max: 8, name: 'V0' });
    for (let i = 1; i < n; i++) { const q = await newPage(i % 2 ? 'phone' : 'desktop'); await joinRoom(q, code, 'V' + i); pages.push(q); }
    return pages;
  };
  const voiceOn = async pages => { for (const p of pages) { await p.click('#tbMic'); await until(() => p.evaluate(() => Voice.on)); } };
  const flows = async (pages, expect) => until(async () => {
    for (const p of pages) { const st = await p.evaluate(() => Voice.stats()); const v = Object.values(st); if (v.length !== expect || v.some(x => x.packets < 5)) return false; }
    return true;
  }, 25000, 500);

  // 3 players first, with detailed UI checks
  let pages = await mk(3);
  await voiceOn(pages);
  ok(await flows(pages, 2), '3 players: every player is receiving live audio packets from both others');
  ok(await pages[0].evaluate(() => Voice.debug().every(x => x.state === 'connected')), 'peer connections are connected');
  const top = await pages[1].evaluate(() => ({ cls: document.querySelector('#tbMic').className, txt: document.querySelector('#tbMic').textContent }));
  ok(/on/.test(top.cls), 'mic button shows live state');
  await until(async () => (await pages[0].locator('#slots .mic').count()) === 3 || true, 500);
  await until(() => pages[0].evaluate(() => S.players.every(p => p.voice)));
  ok(await pages[0].evaluate(() => S.players.every(p => p.voice)), 'mic status synced for every player');
  ok((await pages[0].locator('#slots .mic').count()) === 3, 'mic status icon next to every avatar in the room');
  const spk = await until(async () => { for (const p of pages) if (await p.locator('.av.speaking').count()) return true; return false; }, 15000, 200);
  ok(spk, 'speaking indicator lights up when someone talks (fake mic tone)');
  // self mute
  await pages[1].click('#tbMic'); await sleep(300);
  await until(() => pages[0].evaluate(() => S.players.filter(p => p.muted).length === 1));
  ok(await pages[0].evaluate(() => S.players.filter(p => p.muted).length === 1) && (await pages[0].locator('#slots .mic.muted').count()) === 1, 'self-mute is synced and shown to others');
  ok(await pages[1].evaluate(() => Voice.muted && Voice.on && Voice.debug().length === 2), 'muted player stays connected (still hears others)');
  // listener-side mute
  await pages[0].evaluate(() => { const b = document.querySelector('#slots [data-mute]'); b.click(); });
  const peerMuted = await pages[0].evaluate(() => [...document.querySelectorAll('#voiceAudio audio')].filter(a => a.muted).length);
  ok(peerMuted === 1, 'muting another player silences only their audio locally');
  // permission handling in settings
  await pages[0].click('#tbSet'); ok(await pages[0].locator('#sPeers [data-mute]').count() === 2, 'settings lists players with individual mute buttons'); await pages[0].click('#settings [data-close]');
  // leaving stops voice and drops the peer links
  const leaver = pages[2]; await leaver.click('#tbSet'); await leaver.click('#sLeave'); await leaver.click('#cfYes'); await sleep(800);
  ok(await leaver.evaluate(() => !Voice.on && Voice.debug().length === 0 && document.querySelectorAll('#voiceAudio audio').length === 0), 'leaving the room stops the microphone and closes all connections');
  ok(await until(() => pages[0].evaluate(() => Voice.debug().length === 1), 8000), 'remaining players dropped the leaver\'s connection');
  await closeAll();

  // 8-player mesh
  pages = await mk(8);
  await voiceOn(pages);
  ok(await flows(pages, 7), '8 players: all 8 receive live audio from all 7 others (full mesh)');
  ok((await Promise.all(pages.map(p => p.evaluate(() => Voice.debug().every(x => x.state === 'connected'))))).every(Boolean), '8-player mesh: all 56 peer links connected');
  await closeAll();

  // permission denial / no device: the browser rejects getUserMedia with these exact errors
  for (const [errName, re, label] of [['NotAllowedError', /blocked|allow/i, 'permission denied'], ['NotFoundError', /No microphone/i, 'no microphone device'], ['NotReadableError', /in use/i, 'mic busy']]) {
    const dp = await newPage('desktop'); await createRoom(dp, { name: 'Denied', max: 2 });
    await dp.evaluate(n => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('x', n)); }, errName);
    await dp.click('#tbMic'); await sleep(400);
    const dn = await dp.evaluate(() => ({ on: Voice.on, err: document.querySelector('#sMicErr').textContent, game: !document.querySelector('#room').hidden, btn: document.querySelector('#tbMic').className }));
    ok(!dn.on && re.test(dn.err) && dn.game && /off/.test(dn.btn), `${label}: handled gracefully, game unaffected: "${dn.err}"`);
    const again = await dp.evaluate(async () => { navigator.mediaDevices.getUserMedia = navigator.mediaDevices.constructor.prototype.getUserMedia.bind(navigator.mediaDevices); await micOn(); return Voice.on; });
    ok(again === true, `${label}: user can retry and succeed afterwards`);
  }
  // insecure / unsupported
  const ip = await newPage('desktop'); await createRoom(ip, { name: 'NoMedia', max: 2 });
  await ip.evaluate(() => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); });
  await ip.click('#tbMic'); await sleep(300);
  ok(/secure connection|HTTPS/i.test(await ip.textContent('#sMicErr')) , 'unsupported/insecure context explains why voice is unavailable');
});

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
