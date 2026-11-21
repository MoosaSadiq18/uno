/* Voice chat: audio-only WebRTC mesh. Signaling rides the game's existing WebSocket (room-scoped by the server).
 * Mesh = each player keeps (n-1) peer connections; for audio-only Opus that is light enough for 8 players.
 * Rule that avoids offer "glare": for every pair, the player with the smaller public id creates the offer. */
const Voice = (() => {
  let hooks = { send() {}, onSpeak() {}, onChange() {}, myPub: () => null };
  let local = null, muted = false, ice = null, ac = null, vol = 1, loop = null, lastPlayers = [];
  const peers = new Map();        // pub -> {pc, audio, an, init, retries, q:[]}
  const mutedPeers = new Set();   // peers *I* muted (local only)
  const speaking = new Set();
  const hold = new Map();         // pub -> last time above threshold
  let localAn = null;
  const box = () => document.getElementById('voiceAudio');

  function init(h) { hooks = Object.assign(hooks, h); }

  async function iceServers() {
    if (ice) return ice;
    try {
      const r = await fetch('/api/ice', { cache: 'no-store' });
      ice = (await r.json()).iceServers;
    } catch (e) { ice = [{ urls: 'stun:stun.l.google.com:19302' }]; }
    return ice;
  }

  /** Ask for the microphone and join the room's voice channel. Throws {code,message} on failure. */
  async function start() {
    if (local) return;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      throw { code: 'insecure', message: 'Voice chat needs a secure connection (HTTPS or localhost) and a browser with microphone support.' };
    try {
      local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch (e) {
      const n = e && e.name;
      if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError')
        throw { code: 'denied', message: 'Microphone access was blocked. Allow it in your browser\'s site settings, then try again.' };
      if (n === 'NotSupportedError')
        throw { code: 'insecure', message: 'This browser or connection does not allow microphone access (voice chat needs HTTPS or localhost).' };
      if (n === 'NotFoundError' || n === 'OverconstrainedError')
        throw { code: 'none', message: 'No microphone was found on this device.' };
      if (n === 'NotReadableError' || n === 'AbortError')
        throw { code: 'busy', message: 'Your microphone is in use by another app.' };
      throw { code: 'error', message: 'Could not start the microphone.' };
    }
    local.getAudioTracks().forEach(t => t.addEventListener('ended', () => stop(true)));
    await iceServers();
    ensureCtx();
    localAn = analyser(local);
    muted = false;
    local.getAudioTracks().forEach(t => (t.enabled = true));
    announce();
    startLoop();
    sync(lastPlayers);
    hooks.onChange();
  }

  function ensureCtx() {
    try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); } catch (e) {}
  }

  function analyser(stream) {
    if (!ac) return null;
    try {
      const src = ac.createMediaStreamSource(stream), an = ac.createAnalyser();
      an.fftSize = 512; src.connect(an); // intentionally not connected to destination (no echo)
      return { an, src, buf: new Uint8Array(an.fftSize) };
    } catch (e) { return null; }
  }

  function level(a) {
    if (!a) return 0;
    a.an.getByteTimeDomainData(a.buf);
    let s = 0;
    for (let i = 0; i < a.buf.length; i++) { const v = (a.buf[i] - 128) / 128; s += v * v; }
    return Math.sqrt(s / a.buf.length);
  }

  function startLoop() {
    if (loop) return;
    loop = setInterval(() => {
      const now = Date.now(), cur = new Set();
      const me = hooks.myPub();
      if (local && !muted && me && level(localAn) > 0.02) hold.set(me, now);
      peers.forEach((p, pub) => { if (!mutedPeers.has(pub) && level(p.an) > 0.02) hold.set(pub, now); });
      hold.forEach((t, pub) => { if (now - t < 350) cur.add(pub); else hold.delete(pub); });
      let changed = cur.size !== speaking.size;
      cur.forEach(x => { if (!speaking.has(x)) changed = true; });
      if (changed) { speaking.clear(); cur.forEach(x => speaking.add(x)); hooks.onSpeak(speaking); }
    }, 100);
  }

  function announce() { hooks.send({ type: 'voice', on: !!local, muted }); }

  /** Leave voice: stop the mic, close every peer connection. */
  function stop(fromTrackEnd) {
    peers.forEach((_, pub) => closePeer(pub));
    if (local) local.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    local = null; muted = false;
    if (localAn) { try { localAn.src.disconnect(); } catch (e) {} localAn = null; }
    if (loop) { clearInterval(loop); loop = null; }
    hold.clear(); speaking.clear(); hooks.onSpeak(speaking);
    hooks.send({ type: 'voice', on: false, muted: false });
    hooks.onChange(fromTrackEnd ? 'ended' : undefined);
  }

  /** Full teardown (leaving the room / page unload). Does not message the server. */
  function destroy() {
    const send = hooks.send; hooks.send = () => {};
    stop(); hooks.send = send;
    mutedPeers.clear(); lastPlayers = [];
    if (ac) { try { ac.close(); } catch (e) {} ac = null; }
  }

  function setMuted(m) {
    muted = !!m;
    if (local) local.getAudioTracks().forEach(t => (t.enabled = !muted));
    if (muted) { const me = hooks.myPub(); hold.delete(me); }
    announce(); hooks.onChange();
  }

  // ----------------------------------------------------------------- peers
  function sync(players) {
    lastPlayers = players || [];
    if (!local) return;
    const me = hooks.myPub();
    if (!me) return;
    const want = new Set(lastPlayers.filter(p => !p.me && p.voice).map(p => p.pub));
    want.forEach(pub => { if (!peers.has(pub)) connect(pub, me < pub); });
    [...peers.keys()].forEach(pub => { if (!want.has(pub)) closePeer(pub); });
  }

  function connect(pub, init) {
    const pc = new RTCPeerConnection({ iceServers: ice || [] });
    const p = { pc, audio: null, an: null, init, retries: 0, q: [], timer: null };
    peers.set(pub, p);
    local.getAudioTracks().forEach(t => pc.addTrack(t, local));
    pc.onicecandidate = e => { if (e.candidate) hooks.send({ type: 'rtc', to: pub, data: { candidate: e.candidate } }); };
    pc.ontrack = e => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (!p.audio) {
        const a = document.createElement('audio');
        a.autoplay = true; a.playsInline = true; a.dataset.pub = pub;
        a.srcObject = stream; a.volume = vol; a.muted = mutedPeers.has(pub);
        box().appendChild(a);
        p.audio = a;
        const pr = a.play(); if (pr && pr.catch) pr.catch(() => {}); // retried on next tap if the browser blocks it
        p.an = analyser(stream);
      }
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      clearTimeout(p.timer);
      if (st === 'failed') retry(pub, p);
      else if (st === 'disconnected') p.timer = setTimeout(() => { if (peers.get(pub) === p && pc.connectionState !== 'connected') retry(pub, p); }, 6000);
      else if (st === 'connected') p.retries = 0;
    };
    if (init) offer(pub, p);
    return p;
  }

  async function offer(pub, p) {
    try {
      const o = await p.pc.createOffer();
      await p.pc.setLocalDescription(o);
      hooks.send({ type: 'rtc', to: pub, data: { sdp: p.pc.localDescription } });
    } catch (e) { /* peer closed meanwhile */ }
  }

  function retry(pub, p) {
    if (peers.get(pub) !== p) return;
    const tries = p.retries + 1;
    closePeer(pub);
    if (tries > 4) return;
    setTimeout(() => { if (local) { sync(lastPlayers); const n = peers.get(pub); if (n) n.retries = tries; } }, 1500 * tries);
  }

  function closePeer(pub) {
    const p = peers.get(pub);
    if (!p) return;
    peers.delete(pub); clearTimeout(p.timer);
    try { p.pc.ontrack = p.pc.onicecandidate = p.pc.onconnectionstatechange = null; p.pc.close(); } catch (e) {}
    if (p.audio) { p.audio.pause(); p.audio.srcObject = null; p.audio.remove(); }
    if (p.an) { try { p.an.src.disconnect(); } catch (e) {} }
    hold.delete(pub);
  }

  /** Incoming signaling message {from, data:{sdp|candidate}} relayed by the server (same room only). */
  async function handle(m) {
    if (!local) return;
    const pub = m.from, d = m.data || {};
    try {
      if (d.sdp && d.sdp.type === 'offer') {
        let p = peers.get(pub);
        if (p && (p.pc.remoteDescription || p.init)) { closePeer(pub); p = null; } // peer restarted negotiation
        if (!p) p = connect(pub, false);
        await p.pc.setRemoteDescription(d.sdp);
        const a = await p.pc.createAnswer();
        await p.pc.setLocalDescription(a);
        hooks.send({ type: 'rtc', to: pub, data: { sdp: p.pc.localDescription } });
        flush(p);
      } else if (d.sdp && d.sdp.type === 'answer') {
        const p = peers.get(pub);
        if (p && p.pc.signalingState === 'have-local-offer') { await p.pc.setRemoteDescription(d.sdp); flush(p); }
      } else if (d.candidate) {
        const p = peers.get(pub);
        if (!p) return;
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(d.candidate).catch(() => {});
        else p.q.push(d.candidate);
      }
    } catch (e) { /* stale message from a closed connection */ }
  }
  function flush(p) { const q = p.q.splice(0); q.forEach(c => p.pc.addIceCandidate(c).catch(() => {})); }

  /** After a reconnect: drop all peer links and re-announce so everyone rebuilds them cleanly. */
  function resetPeers() {
    if (!local) return;
    [...peers.keys()].forEach(closePeer);
    hooks.send({ type: 'voice', on: false, muted });
    announce();
    sync(lastPlayers);
  }

  function setVolume(v) { vol = v; peers.forEach(p => { if (p.audio) p.audio.volume = v; }); }
  function mutePeer(pub, m) { m ? mutedPeers.add(pub) : mutedPeers.delete(pub); const p = peers.get(pub); if (p && p.audio) p.audio.muted = m; if (m) hold.delete(pub); hooks.onChange(); }
  function resumeAudio() { peers.forEach(p => { if (p.audio && p.audio.paused) p.audio.play().catch(() => {}); }); if (ac && ac.state === 'suspended') ac.resume(); }

  return {
    init, start, stop, destroy, setMuted, sync, handle, resetPeers, setVolume, mutePeer, resumeAudio,
    get on() { return !!local; }, get muted() { return muted; },
    isPeerMuted: pub => mutedPeers.has(pub),
    isSpeaking: pub => speaking.has(pub),
    /** test/diagnostics: connection state per peer */
    debug: () => [...peers].map(([pub, p]) => ({ pub, state: p.pc.connectionState, ice: p.pc.iceConnectionState, hasAudio: !!p.audio })),
    stats: async () => { const out = {}; for (const [pub, p] of peers) { let b = 0, pk = 0; (await p.pc.getStats()).forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'audio') { b += r.bytesReceived; pk += r.packetsReceived; } }); out[pub] = { bytes: b, packets: pk }; } return out; },
  };
})();
