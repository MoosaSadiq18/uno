// Backend scenario tests: real WebSocket clients against a running server.
//   java -Duno.graceLobby=2 -Duno.graceGame=3 -jar target/uno-1.0.0.jar --server.port=8099 &
//   node tests/e2e-ws.mjs ws://localhost:8099/ws
const URL = process.argv[2] || 'ws://localhost:8080/ws';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let uid = 0;

class Client {
  constructor(name, pid) {
    this.name = name; this.pid = pid || 'pid-' + name + '-' + (++uid) + '-' + Math.random().toString(36).slice(2);
    this.state = null; this.events = []; this.chats = []; this.errors = []; this.rtc = []; this.history = null;
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      this.ws.onopen = () => res(this);
      this.ws.onerror = rej;
      this.ws.onmessage = e => {
        const d = JSON.parse(e.data);
        if (d.type === 'state') this.state = d;
        else if (d.type === 'event') this.events.push(d);
        else if (d.type === 'chat') this.chats.push(d);
        else if (d.type === 'error') this.errors.push(d.msg);
        else if (d.type === 'rtc') this.rtc.push(d);
        else if (d.type === 'history') this.history = d.items;
      };
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async join(room, extra = {}) {
    await this.connect(); this.state = null;
    this.send({ type: 'join', room, name: this.name, pid: this.pid, avatar: 1, ...extra });
    await this.until(() => this.state || this.errors.length, 2000);
    return this;
  }
  async create(extra = {}) {
    await this.connect();
    this.send({ type: 'join', create: true, name: this.name, pid: this.pid, avatar: 0, max: 4, ...extra });
    await this.until(() => this.state || this.errors.length, 2000);
    return this;
  }
  async until(f, ms = 2000) { const t = Date.now(); while (!f() && Date.now() - t < ms) await sleep(10); return f(); }
  me() { return this.state.players.find(p => p.me); }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function room(n, opts = {}) {
  const host = await new Client('H').create({ max: opts.max ?? Math.max(n, 2), mode: opts.mode || 'classic', pin: opts.pin || '' });
  const cs = [host];
  for (let i = 1; i < n; i++) cs.push(await new Client('P' + i).join(host.state.room, { pin: opts.pin || '' }));
  await sleep(100);
  return cs;
}

// A simple "bot" move for whoever's turn it is. opts: unoPolicy(client) -> 'call'|'forget'
async function playOut(cs, { maxMoves = 2500, onWindow } = {}) {
  let moves = 0;
  while (moves++ < maxMoves) {
    await sleep(2);
    const c = cs.find(x => x.state.started && x.me().turn);
    if (cs[0].state.over) return true;
    if (!c) { await sleep(10); continue; }
    const s = c.state;
    if (s.unoWindow && onWindow) { await onWindow(cs, s.unoWindow); }
    const i = s.playable.findIndex(Boolean);
    const before = s.log + s.deck + s.hand.length;
    if (i < 0) c.send({ type: 'draw' });
    else {
      const card = s.hand[i];
      // arm UNO ahead of time half the time (exercise that path)
      if (s.hand.length === 2 && Math.random() < .5) c.send({ type: 'uno' });
      c.send({ type: 'play', index: i, color: ['R', 'G', 'B', 'Y'][Math.random() * 4 | 0], card: card.color + ':' + card.value });
    }
    await c.until(() => !(c.state.players.find(p => p.me).turn) || c.state.over, 1500);
    await sleep(5);
  }
  return false;
}

const group = async (name, fn) => { console.log('\n' + name); try { await fn(); } catch (e) { fail++; console.log('  ✗ EXCEPTION', e); } };

await group('1/2/3. Full games with 2, 4 and 8 players (classic) and 8 (stack)', async () => {
  for (const [n, mode] of [[2, 'classic'], [4, 'classic'], [8, 'classic'], [8, 'stack'], [3, 'stack']]) {
    const cs = await room(n, { mode, max: 8 });
    ok(cs[0].state.players.length === n, `${n} players seated (${mode})`);
    cs[0].send({ type: 'start' });
    await cs[0].until(() => cs[0].state.started);
    await sleep(100);
    ok(cs.every(c => c.state.hand.length === 7), `${n}p: everyone dealt 7`);
    ok(cs.filter(c => c.me().turn).length === 1, `${n}p: exactly one active turn`);
    const done = await playOut(cs);
    ok(done && cs[0].state.over && cs[0].state.winner, `${n}p ${mode}: game finished with winner "${cs[0].state.winner}"`);
    const w = cs[0].state.players.find(p => p.name === cs[0].state.winner);
    ok(w.count === 0 && w.score > 0, `${n}p ${mode}: winner has 0 cards and scored ${w.score}`);
    cs.forEach(c => c.close());
  }
});

await group('Turn order, reverse and skip with N players', async () => {
  for (const n of [2, 3, 5, 8]) {
    const cs = await room(n, { max: 8 });
    cs[0].send({ type: 'start' }); await cs[0].until(() => cs[0].state.started); await sleep(80);
    let bad = 0, seen = 0, prevSeat = cs[0].state.players.findIndex(p => p.turn), dirChanges = 0, prevDir = 1;
    for (let k = 0; k < 150 && !cs[0].state.over; k++) {
      const c = cs.find(x => x.me().turn); if (!c) { await sleep(10); continue; }
      const s = c.state, i = s.playable.findIndex(Boolean), top = s.top;
      if (i < 0) c.send({ type: 'draw' }); else c.send({ type: 'play', index: i, color: 'R' });
      await c.until(() => !c.me().turn || c.state.over); await sleep(5);
      const st = cs[0].state; if (st.over) break;
      const seat = st.players.findIndex(p => p.turn);
      if (st.dir !== prevDir) dirChanges++;
      // expected next seat: 1 step normally, 2 for skip/+2/+4 (classic), reverse flips direction
      const played = i >= 0 ? s.hand[i].value : null;
      const steps = (played === 'SKIP' || played === '+2' || played === '+4') ? 2 : (played === 'REV' && n === 2) ? 2 : 1;
      const exp = ((prevSeat + st.dir * steps) % n + n) % n;
      seen++; if (seat !== exp) bad++;
      prevSeat = seat; prevDir = st.dir;
    }
    ok(bad === 0 && seen > 20, `${n}p: ${seen} turns all moved to the correct next seat (${dirChanges} reversals)`);
    cs.forEach(c => c.close());
  }
});

await group('4/5/6. UNO: correct call, forgotten call + penalty, successful catch', async () => {
  const tally = { call: 0, caught: 0, forget: 0, lateCatchRejected: 0, calledThenCatchRejected: 0 };
  let guard = 0;
  while ((tally.call < 3 || tally.caught < 3 || tally.forget < 3) && guard++ < 25) {
    const cs = await room(4);
    cs[0].send({ type: 'start' }); await cs[0].until(() => cs[0].state.started); await sleep(80);
    await playOut(cs, {
      onWindow: async (all, vpub) => {
        const v = all.find(x => x.me().pub === vpub), others = all.filter(x => x !== v);
        const pick = tally.call < 3 ? 'call' : tally.caught < 3 ? 'catch' : 'forget';
        const roll = pick === 'forget' && tally.forget >= 3 ? 'call' : pick;
        const cnt0 = v.me().count;
        if (roll === 'call') {
          v.send({ type: 'uno' }); await v.until(() => v.state.players.find(p => p.pub === vpub).uno); await sleep(30);
          const ev = others[0].events.filter(e => e.kind === 'uno' && e.pub === vpub);
          ok(v.me().uno && ev.length >= 1 && others.every(o => o.state.players.find(p => p.pub === vpub).uno), 'UNO call is synced to all players + announced');
          const before = v.me().count;
          others[0].errors.length = 0; others[0].send({ type: 'catch' }); await sleep(60);
          ok(others[0].errors.length === 1 && v.me().count === before, 'catching someone who already called UNO is rejected (no penalty)');
          tally.call++; tally.calledThenCatchRejected++;
        } else if (roll === 'catch') {
          others[1].send({ type: 'catch' }); await v.until(() => v.state.hand.length === cnt0 + 2, 800);
          ok(v.me().count === cnt0 + 2, `catch penalizes exactly 2 cards (${cnt0} -> ${v.me().count})`);
          ok(others.every(o => o.events.some(e => e.kind === 'caught' && e.pub === vpub)), 'catch is broadcast to every player');
          ok(v.state.unoWindow === null, 'window closes after the catch');
          others[2].errors.length = 0; others[2].send({ type: 'catch' }); await sleep(60);
          ok(others[2].errors.length === 1 && v.me().count === cnt0 + 2, 'a second catcher cannot double-penalize');
          tally.caught++;
        } else { // forget: the next action by anyone closes the window
          v.errors.length = 0; v.send({ type: 'catch' }); await sleep(40);
          ok(v.errors.length === 1, 'you cannot catch yourself');
          tally.forget++; // verified below once the next player acts
          v._expectClosed = true;
        }
      }
    }).catch(() => {});
    cs.forEach(c => c.close());
  }
  console.log('   tallies', JSON.stringify(tally));
  ok(tally.call >= 3 && tally.caught >= 3, 'observed correct-call and successful-catch cases');
});

await group('5b. Forgot UNO: window expires when the next player acts (deterministic)', async () => {
  let verified = 0, guard = 0;
  while (verified < 3 && guard++ < 30) {
    const cs = await room(4);
    cs[0].send({ type: 'start' }); await cs[0].until(() => cs[0].state.started); await sleep(80);
    let target = null;
    for (let m = 0; m < 1500 && !cs[0].state.over && verified < 3; m++) {
      const c = cs.find(x => x.me().turn); if (!c) { await sleep(10); continue; }
      const s = c.state;
      if (s.unoWindow && !target) {
        // the vulnerable player forgot; the NEXT player now acts (play or draw), which must expire the window
        target = s.unoWindow;
      }
      const i = s.playable.findIndex(Boolean);
      const pubBefore = s.unoWindow;
      if (i < 0) c.send({ type: 'draw' }); else c.send({ type: 'play', index: i, color: 'B' });
      await c.until(() => !c.me().turn || c.state.over); await sleep(15);
      if (pubBefore && !c.state.over) {
        const v = cs.find(x => x.me().pub === pubBefore), cnt = v ? v.me().count : -1;
        ok(cs[0].state.unoWindow !== pubBefore || cs[0].state.unoWindow === null, 'window closed once next player acted');
        const catcher = cs.find(x => x.me().pub !== pubBefore && x.me().pub !== c.me().pub) || cs.find(x => x.me().pub !== pubBefore);
        catcher.errors.length = 0; const n0 = v ? v.me().count : 0; catcher.send({ type: 'catch' }); await sleep(50);
        ok(catcher.errors.length === 1 && (!v || v.me().count === n0), 'late catch (after next player acted) is rejected, no penalty');
        verified++;
      }
    }
    cs.forEach(c => c.close());
  }
  ok(verified >= 3, `verified expiry ${verified}x`);
});

await group('5c. Penalty is applied by backend when a forgetful player is caught before next action', async () => {
  let done = 0, guard = 0;
  while (done < 2 && guard++ < 40) {
    const cs = await room(3);
    cs[0].send({ type: 'start' }); await cs[0].until(() => cs[0].state.started); await sleep(60);
    for (let m = 0; m < 1500 && !cs[0].state.over && done < 2; m++) {
      const c = cs.find(x => x.me().turn); if (!c) { await sleep(10); continue; }
      const i = c.state.playable.findIndex(Boolean);
      if (i < 0) c.send({ type: 'draw' }); else c.send({ type: 'play', index: i, color: 'G' });
      await c.until(() => !c.me().turn || c.state.over); await sleep(10);
      const w = cs[0].state.unoWindow;
      if (w && !cs[0].state.over) {
        const v = cs.find(x => x.me().pub === w), catcher = cs.find(x => x !== v);
        const n = v.me().count; catcher.send({ type: 'catch' }); await sleep(60);
        ok(n === 1 && v.me().count === 3, `forgot UNO (1 card) -> caught -> ${v.me().count} cards (server-enforced)`);
        done++;
      }
    }
    cs.forEach(c => c.close());
  }
  ok(done >= 2, 'penalty path exercised');
});

await group('7. Player leaves mid-game (various seats, turn bookkeeping)', async () => {
  for (const n of [3, 5, 8]) {
    const cs = await room(n, { max: 8 });
    cs[0].send({ type: 'start' }); await cs[0].until(() => cs[0].state.started); await sleep(80);
    // make the leaver the player whose turn it is (hardest case)
    const leaver = cs.find(c => c.me().turn), rest = cs.filter(c => c !== leaver);
    const leaverName = leaver.name, wasHost = leaver === cs[0];
    leaver.send({ type: 'leave' }); await sleep(150);
    const obs = rest[0].state;
    ok(obs.players.length === n - 1, `${n}p: seat freed immediately (${obs.players.length} left)`);
    ok(!obs.players.some(p => p.name === leaverName), 'no ghost seat for the leaver');
    ok(obs.players.filter(p => p.turn).length === 1, 'turn passed to exactly one remaining player');
    ok(rest.every(c => c.chats.some(m => m.system && m.text.includes('left'))), 'remaining players were notified');
    if (!wasHost) { /* nothing */ } else ok(obs.players.filter(p => p.host).length === 1, 'new host assigned');
    ok(await playOut(rest), `${n}p: game still completes after a leave (winner ${rest[0].state.winner})`);
    rest.forEach(c => c.close());
  }
  // leave when it is NOT their turn and index < turn
  const cs = await room(4); cs[0].send({ type: 'start' }); await cs[0].until(() => cs[0].state.started); await sleep(60);
  const t = cs.findIndex(c => c.me().turn), other = cs.find((c, i) => i !== t && c !== cs[0]);
  const curName = cs[t].name; other.send({ type: 'leave' }); await sleep(100);
  ok(cs[t].me().turn && cs[t].name === curName, 'turn owner unchanged when a different player leaves');
  cs.forEach(c => c.close());
});

await group('7b. Down to one player => game ends gracefully', async () => {
  const cs = await room(2); cs[0].send({ type: 'start' }); await cs[0].until(() => cs[0].state.started); await sleep(60);
  cs[1].send({ type: 'leave' }); await sleep(120);
  const s = cs[0].state;
  ok(s.over && s.forfeit && s.winner === 'H', 'remaining player wins by default');
  ok(s.players.length === 1, 'room stays operational with 1 player');
  const c3 = await new Client('N').join(s.room);
  await sleep(80); cs[0].send({ type: 'restart' }); await sleep(100);
  ok(cs[0].state.started && !cs[0].state.over && cs[0].state.players.length === 2, 'a new player can join and host restarts');
  cs.forEach(c => c.close()); c3.close();
});

await group('8. Host leaves -> new host, room keeps working', async () => {
  const cs = await room(4); const host = cs[0];
  ok(host.state.host === true && cs[1].state.host === false, 'creator is host');
  host.send({ type: 'leave' }); await sleep(150);
  const rest = cs.slice(1);
  ok(rest.filter(c => c.state.host).length === 1, 'exactly one new host');
  ok(rest[0].state.host, 'first online player became host');
  ok(rest.every(c => c.chats.some(m => m.system && /now the host/.test(m.text))), 'players told about new host');
  const nh = rest.find(c => c.state.host); nh.send({ type: 'start' }); await sleep(120);
  ok(nh.state.started, 'new host can start the game');
  rest[1].errors.length = 0; rest.find(c => !c.state.host).send({ type: 'start' }); // non host
  rest.forEach(c => c.close());
});

await group('8b. Host leaves during a game', async () => {
  const cs = await room(3); cs[0].send({ type: 'start' }); await cs[0].until(() => cs[0].state.started); await sleep(60);
  cs[0].send({ type: 'leave' }); await sleep(120);
  const rest = cs.slice(1);
  ok(rest.some(c => c.state.host) && rest[0].state.started && !rest[0].state.over, 'game continues with new host');
  ok(await playOut(rest), 'game completes');
  rest.forEach(c => c.close());
});

await group('9. Disconnect and reconnect (same player, same hand)', async () => {
  const cs = await room(3); cs[0].send({ type: 'start' }); await cs[0].until(() => cs[0].state.started); await sleep(60);
  const p = cs[1], pub = p.me().pub, hand = JSON.stringify(p.state.hand), pid = p.pid;
  p.close(); await sleep(150);
  const obs = cs[0].state.players.find(x => x.pub === pub);
  ok(obs && obs.on === false, 'others see player as offline (not removed)');
  ok(cs[0].chats.some(m => m.system && /lost connection/.test(m.text)), 'others notified of disconnect');
  const r = await new Client('P1', pid).join(cs[0].state.room);
  await sleep(100);
  ok(r.state && r.me().pub === pub && JSON.stringify(r.state.hand) === hand, 'reconnect restores identity and exact hand');
  ok(cs[0].state.players.find(x => x.pub === pub).on === true, 'player is online again for everyone');
  ok(r.history && r.history.length > 0, 'chat history replayed to reconnecting player');
  // offline player's turn is skipped
  const q = cs[2]; q.close(); await sleep(100);
  let skipped = true;
  for (let k = 0; k < 12; k++) { const c = [cs[0], r].find(x => x.me().turn); if (!c) { skipped = skipped && true; await sleep(20); continue; }
    const i = c.state.playable.findIndex(Boolean); if (i < 0) c.send({ type: 'draw' }); else c.send({ type: 'play', index: i, color: 'R' });
    await c.until(() => !c.me().turn || c.state.over); await sleep(10);
    if (cs[0].state.players.find(x => x.turn && !x.on)) skipped = false; }
  ok(skipped, 'turn never lands on an offline player');
  cs.forEach(c => c.close()); r.close();
});

await group('9b. Ghost cleanup: dropped players are removed after the grace period', async () => {
  // lobby
  const cs = await room(3);
  cs[2].close(); await sleep(300);
  ok(cs[0].state.players.length === 3 && cs[0].state.players.some(p => !p.on), 'seat is kept during grace (offline)');
  await sleep(2600);
  ok(cs[0].state.players.length === 2, 'ghost seat freed after grace (lobby)');
  // in-game
  cs[0].send({ type: 'start' }); await cs[0].until(() => cs[0].state.started); await sleep(60);
  cs[1].close(); await sleep(3600);
  ok(cs[0].state.over && cs[0].state.forfeit, 'game ends when disconnected player expires and <2 remain');
  cs[0].close();
});

await group('9c. Host disconnect (not leave) hands over host after grace', async () => {
  const cs = await room(3);
  cs[0].close(); await sleep(2800);
  ok(cs[1].state.host || cs[2].state.host, 'host reassigned after host expired');
  cs.forEach(c => c.close());
});

await group('Rooms: validation, full, PIN, isolation, cleanup', async () => {
  const a = await room(2, { max: 2 });
  const extra = await new Client('X').join(a[0].state.room);
  ok(extra.errors.some(e => /full/i.test(e)), 'full room is rejected with a helpful error');
  const nf = await new Client('Y').join('ZZZZZ'); ok(nf.errors.some(e => /not found/i.test(e)), 'unknown room code -> "Room not found"');
  const lc = await new Client('Z').join(' ' + a[0].state.room.toLowerCase().slice(0, 2) + '-' + a[0].state.room.toLowerCase().slice(2) + ' ');
  ok(lc.errors.some(e => /full/i.test(e)) && !lc.errors.some(e => /not found/i.test(e)), 'lowercase / dashed pasted code normalizes to the room');
  const p = await room(2, { max: 4, pin: '4242' });
  const np = await new Client('N').join(p[0].state.room); ok(np.errors.some(e => /PIN/.test(e)), 'private room requires PIN');
  const wp = await new Client('W').join(p[0].state.room, { pin: '1' }); ok(wp.errors.some(e => /Wrong PIN/.test(e)), 'wrong PIN rejected');
  const gp = await new Client('G').join(p[0].state.room, { pin: '4242' }); ok(gp.state && gp.state.players.length === 3, 'correct PIN joins');
  ok(p[0].state.pin === '4242' && !gp.state.pin, 'only host sees PIN');
  const b = await room(2);
  ok(a[0].state.room !== b[0].state.room, 'distinct room codes');
  a[0].send({ type: 'chat', text: 'secret-A' }); await sleep(100);
  ok(a[1].chats.some(c => c.text === 'secret-A') && !b.some(c => c.chats.some(m => m.text === 'secret-A')), 'chat is isolated to its room');
  // signaling isolation: A tries to relay to a player in room B
  const bPub = b[1].me().pub; a[0].send({ type: 'rtc', to: bPub, data: { sdp: 'x' } }); await sleep(100);
  ok(!b.some(c => c.rtc.length), 'WebRTC signaling cannot cross rooms');
  a[0].send({ type: 'rtc', to: a[1].me().pub, data: { candidate: 'c' } }); await sleep(100);
  ok(a[1].rtc.length === 1 && a[1].rtc[0].from === a[0].me().pub, 'signaling relays within the room');
  ok(!JSON.stringify(a[1].state).includes(a[0].pid), 'private reconnect ids are never sent to other players');
  // voice flags
  a[0].send({ type: 'voice', on: true, muted: true }); await sleep(100);
  const hv = a[1].state.players.find(x => x.pub === a[0].me().pub); ok(hv.voice && hv.muted, 'voice/mic status synced to others');
  // dedupe names
  const d1 = await new Client('H').join(a[0].state.room); // full -> error
  const e = await room(3); ok(new Set(e[0].state.players.map(x => x.name)).size === 3, 'names unique');
  const big = await new Client('B').create({ max: 99 }); ok(big.state.max === 8, 'max players clamped to 8');
  const small = await new Client('S').create({ max: 0 }); ok(small.state.max === 2, 'max players clamped to 2');
  const st = await new Client('T').create({ max: 3 }); st.send({ type: 'start' }); await sleep(80);
  ok(st.errors.some(e => /at least 2/.test(e)), 'cannot start alone');
  const nonhost = e[1]; nonhost.errors.length = 0; nonhost.send({ type: 'start' }); await sleep(80); ok(nonhost.errors.some(m => /host/.test(m)), 'only host can start');
  [a, b, p, e].flat().concat([extra, nf, lc, np, wp, gp, d1, big, small, st]).forEach(c => c.close());
});

await group('Hand-change protection: stale play is rejected', async () => {
  const cs = await room(2); cs[0].send({ type: 'start' }); await cs[0].until(() => cs[0].state.started); await sleep(60);
  const c = cs.find(x => x.me().turn); c.errors.length = 0;
  c.send({ type: 'play', index: 0, color: 'R', card: 'R:NOPE' }); await sleep(80);
  ok(c.errors.some(e => /changed/.test(e)), 'mismatched card identity rejected');
  const o = cs.find(x => !x.me().turn); o.errors.length = 0; o.send({ type: 'play', index: 0, color: 'R' }); o.send({ type: 'draw' }); await sleep(80);
  ok(o.errors.length === 2, 'out-of-turn actions rejected');
  cs.forEach(c => c.close());
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
