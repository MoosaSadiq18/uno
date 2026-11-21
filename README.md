# UNO Online (Spring Boot + WebSocket + WebRTC)

2-8 player online UNO with room codes, text chat, real voice chat, UNO calling/catching and a mobile-first UI.

Run locally:  `mvn spring-boot:run`  ->  http://localhost:8080
Docker:       `docker build -t uno . && docker run -d --name uno --restart unless-stopped -p 80:8080 uno`

## Features
- **2-8 players.** The host picks the max when creating the room, the waiting room shows open/occupied seats, and the table re-arranges itself for every player count.
- **Create / Join flows.** Nickname + avatar + max players + mode (Classic or Stacking +2/+4) + optional 4-digit PIN. Server-generated room codes, one-click copy (code or invite link `/?room=CODE`), paste-friendly join form with validation and loading states.
- **UNO calling.** Press UNO when you have one card left (or just before playing your second-to-last card). If you forget, anyone can press *Catch* before the next player plays or draws and you draw 2. Fully enforced by the server; a UNO that was already called cannot be "caught".
- **Leave / disconnects.** Leave Game (with confirmation) from Settings. Dropped players keep their seat for a grace period (30 s lobby / 120 s in game), are skipped on their turn, and are removed afterwards - no ghost seats. A refresh or flaky connection rejoins the same seat and hand. Host leaves -> next player becomes host. Fewer than 2 players mid-game -> remaining player wins by default and the room stays open.
- **Chat.** Collapsible right sidebar on desktop; on mobile a floating chat button (with unread badge) opens a full-screen drawer with a close button. History is replayed after reconnect.
- **Sound.** Synthesised effects (no assets). Toggle lives in the top bar and Settings, never in chat. Master on/off, effects volume, UNO-announcement toggle and voice volume persist in `localStorage`. Audio only starts after the first tap/click.
- **Voice chat.** Real WebRTC (audio only). Signaling uses the existing `/ws` socket and is relayed only inside the sender's room. Mic on/off, mute/unmute, speaking indicators, mic status next to each avatar, per-player mute, graceful permission-denied / no-device / busy-device handling. Leaving the room stops the mic and closes all peer connections.
- **Settings menu** (gear): sound, volumes, microphone, chat visibility, rules/help, leave.

## Voice chat architecture & deployment notes
- Topology is a **full mesh**: each player has up to 7 peer connections. Audio-only Opus is ~30-40 kbit/s per stream so 8 players is fine on normal connections (verified in the test-suite with 8 simultaneous browsers). If you ever need bigger rooms or want to save upload bandwidth, put an SFU (LiveKit, mediasoup, ...) behind the same signaling messages.
- **Browsers only allow microphone access on HTTPS or `localhost`.** Serve the site over HTTPS (see the Caddy note below) or voice buttons will explain that the connection isn't secure.
- Default ICE config is Google's public STUN. For players behind strict NATs / carrier networks add a **TURN** relay (e.g. coturn) and set these environment variables - clients pick them up from `/api/ice`:
  `UNO_TURN_URL=turn:turn.example.com:3478  UNO_TURN_USER=...  UNO_TURN_PASS=...`
  e.g. `docker run -e UNO_TURN_URL=... -e UNO_TURN_USER=... -e UNO_TURN_PASS=... ...`

## Project layout
```
src/main/java/com/example/uno/
  Game.java         rules, UNO window/penalties, turn order (2-8 players), per-player views
  UnoSocket.java    rooms, join/leave/reconnect, grace timers, heartbeat sweep, chat, WebRTC signaling relay
  WsConfig.java     /ws endpoint + larger message buffer for SDP
  IceController.java  /api/ice (STUN/TURN config)
src/main/resources/static/
  index.html  css/app.css  js/app.js (UI/game client)  js/voice.js (WebRTC mesh)
tests/
  e2e-ws.mjs  backend scenarios over real WebSockets
  e2e-ui.mjs  Playwright browser tests (mobile/desktop layouts, chat, sound, UNO, voice, leave, reconnect)
```

## Tests
```
mvn -q package -DskipTests
java -Duno.graceLobby=2 -Duno.graceGame=3 -jar target/uno-1.0.0.jar --server.port=8099 &
node tests/e2e-ws.mjs ws://localhost:8099/ws          # Node 22+ (built-in WebSocket)
npm i playwright && node tests/e2e-ui.mjs http://localhost:8099   # uses fake microphones for voice tests
```
(`-Duno.graceLobby/graceGame` shorten the reconnect grace periods so ghost-seat cleanup can be tested quickly.)

## Deploy on AWS EC2
1. Launch an EC2 instance: Amazon Linux 2023, t3.micro (or t2.micro), key pair of your choice.
2. Security group inbound: SSH 22 (My IP only), HTTP 80 and HTTPS 443 (0.0.0.0/0).
3. SSH in and install Docker:
   sudo dnf install -y docker git
   sudo systemctl enable --now docker
   sudo usermod -aG docker ec2-user   # then log out/in
4. (t2/t3.micro has 1 GB RAM - add swap so the Maven build doesn't get OOM-killed)
   sudo dd if=/dev/zero of=/swapfile bs=1M count=1024 && sudo chmod 600 /swapfile
   sudo mkswap /swapfile && sudo swapon /swapfile
5. Get the code on the box (git clone your repo, or scp the folder), then:
   docker build -t uno .
   docker run -d --name uno --restart unless-stopped -p 80:8080 uno
6. Open http://<EC2-public-IP> - share the room code with friends. (Text chat and gameplay work over HTTP; **voice needs HTTPS**, see below.)

Update later: git pull && docker build -t uno . && docker rm -f uno && docker run -d --name uno --restart unless-stopped -p 80:8080 uno

**HTTPS (needed for voice):** point a domain at the instance (Elastic IP) and put Caddy in front - `caddy reverse-proxy --from yourdomain.com --to localhost:8080` gets a certificate automatically. The client switches to wss:// by itself.
