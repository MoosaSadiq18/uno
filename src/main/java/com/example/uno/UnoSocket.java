package com.example.uno;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

/**
 * WebSocket endpoint. One Room per code; every broadcast, chat line and WebRTC signaling message is
 * delivered only to sockets registered in the sender's own room (room isolation).
 */
@Component
public class UnoSocket extends TextWebSocketHandler {
    static final String CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I look-alikes
    static final int CODE_LEN = 5, MAX_ROOMS = 5000, HISTORY = 60;
    /** How long a dropped player keeps their seat (phones background tabs / flaky networks). */
    static final long LOBBY_GRACE_S = Long.getLong("uno.graceLobby", 30), GAME_GRACE_S = Long.getLong("uno.graceGame", 120),
            IDLE_MS = Long.getLong("uno.idleMs", 50_000);

    static class Room {
        final String code;
        final Game game = new Game();
        final Map<String, WebSocketSession> socks = new ConcurrentHashMap<>(); // playerId -> socket
        final Map<String, Long> seen = new ConcurrentHashMap<>();              // playerId -> last message time
        final Map<String, Long> lastChat = new ConcurrentHashMap<>();
        final Deque<Map<String, Object>> history = new ArrayDeque<>();
        final Map<String, ScheduledFuture<?>> graceTimers = new ConcurrentHashMap<>();
        volatile boolean dead;
        Room(String code) { this.code = code; }
    }

    private final ObjectMapper om = new ObjectMapper();
    private final SecureRandom rnd = new SecureRandom();
    private final Map<String, Room> rooms = new ConcurrentHashMap<>();
    private final Map<String, String[]> who = new ConcurrentHashMap<>(); // sessionId -> {room, playerId}
    private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "uno-timers");
        t.setDaemon(true);
        return t;
    });

    public UnoSocket() {
        timers.scheduleWithFixedDelay(this::sweep, 15, 15, TimeUnit.SECONDS);
    }

    @PreDestroy
    void shutdown() { timers.shutdownNow(); }

    int roomCount() { return rooms.size(); }

    // --------------------------------------------------------------- messages
    @Override
    protected void handleTextMessage(WebSocketSession s, TextMessage msg) throws Exception {
        JsonNode j;
        try { j = om.readTree(msg.getPayload()); } catch (Exception e) { return; }
        String type = j.path("type").asText();
        if (type.equals("join")) { join(s, j); return; }
        String[] in = who.get(s.getId());
        Room r = in == null ? null : rooms.get(in[0]);
        if (r == null) return;
        String pid = in[1];
        r.seen.put(pid, System.currentTimeMillis());

        switch (type) {
            case "ping" -> { send(s, Map.of("type", "pong")); return; }
            case "chat" -> { chat(r, pid, j.path("text").asText()); return; }
            case "rtc" -> { relay(r, pid, j); return; }
            case "leave" -> { removePlayer(r, pid); closeQuietly(s); return; }
            default -> { }
        }

        String err = null;
        synchronized (r.game) {
            if (r.dead) return;
            Game g = r.game;
            switch (type) {
                case "start", "restart" -> err = g.start(pid);
                case "play" -> err = g.play(pid, j.path("index").asInt(-1), j.path("color").asText(""), j.path("card").asText(""));
                case "draw" -> err = g.draw(pid);
                case "uno" -> err = g.uno(pid);
                case "catch" -> err = g.catchUno(pid);
                case "voice" -> g.voice(pid, j.path("on").asBoolean(), j.path("muted").asBoolean());
                default -> { }
            }
        }
        if (err != null) send(s, Map.of("type", "error", "msg", err));
        flush(r);
    }

    private void chat(Room r, String pid, String raw) {
        String t = raw.trim().replaceAll("[\\p{Cntrl}&&[^\n]]", "");
        if (t.isEmpty()) return;
        if (t.length() > 200) t = t.substring(0, 200);
        long now = System.currentTimeMillis();
        Long prev = r.lastChat.put(pid, now);
        if (prev != null && now - prev < 350) return; // simple flood guard
        Map<String, Object> c;
        synchronized (r.game) {
            Game.Player p = r.game.find(pid);
            if (p == null) return;
            c = new LinkedHashMap<>();
            c.put("type", "chat");
            c.put("pub", p.pub);
            c.put("name", p.name);
            c.put("avatar", p.avatar);
            c.put("seat", r.game.players.indexOf(p));
            c.put("text", t);
            c.put("ts", now);
        }
        remember(r, c);
        r.socks.values().forEach(w -> send(w, c)); // room-scoped
    }

    /** WebRTC signaling: forward an SDP/ICE blob to one player of the SAME room. */
    private void relay(Room r, String pid, JsonNode j) {
        JsonNode data = j.path("data");
        if (!data.isObject() || data.toString().length() > 24_000) return;
        String fromPub, toPid;
        synchronized (r.game) {
            Game.Player from = r.game.find(pid), to = r.game.byPub(j.path("to").asText());
            if (from == null || to == null || from == to) return;
            fromPub = from.pub;
            toPid = to.id;
        }
        WebSocketSession w = r.socks.get(toPid);
        if (w != null) send(w, Map.of("type", "rtc", "from", fromPub, "data", data));
    }

    private void join(WebSocketSession s, JsonNode j) {
        if (who.containsKey(s.getId())) return;
        String pid = j.path("pid").asText();
        if (pid.length() < 8 || pid.length() > 64) return;
        String name = clean(j.path("name").asText("Player"));
        int avatar = j.path("avatar").asInt(0);
        String pin = j.path("pin").asText("").replaceAll("\\D", "");
        if (pin.length() > 8) pin = pin.substring(0, 8);

        Room r;
        String code;
        if (j.path("create").asBoolean()) {
            if (rooms.size() >= MAX_ROOMS) { send(s, err("Server is busy, try again later")); return; }
            r = null;
            code = null;
            for (int tries = 0; tries < 50 && r == null; tries++) {
                String c = newCode();
                Room nr = new Room(c);
                if (rooms.putIfAbsent(c, nr) == null) { r = nr; code = c; }
            }
            if (r == null) { send(s, err("Could not create a room, try again")); return; }
            synchronized (r.game) {
                r.game.code = code;
                r.game.configure(j.path("max").asInt(4), j.path("mode").asText("classic"), pin);
            }
        } else {
            code = normalizeCode(j.path("room").asText());
            r = code.isEmpty() ? null : rooms.get(code);
            if (r == null) { send(s, err("Room not found. Check the code and try again.")); return; }
        }

        String e;
        synchronized (r.game) {
            if (r.dead) e = "Room not found. Check the code and try again.";
            else e = r.game.add(pid, name, avatar, pin);
        }
        if (e != null) {
            send(s, err(e));
            discardIfEmpty(r);
            return;
        }
        cancelGrace(r, pid);
        WebSocketSession old = r.socks.put(pid, s);
        r.seen.put(pid, System.currentTimeMillis());
        who.put(s.getId(), new String[]{code, pid});
        if (old != null && old != s) { who.remove(old.getId()); closeQuietly(old); } // replaced by a newer connection
        List<Map<String, Object>> h;
        synchronized (r.history) { h = new ArrayList<>(r.history); }
        send(s, Map.of("type", "history", "items", h));
        flush(r);
    }

    private static Map<String, Object> err(String m) { return Map.of("type", "error", "msg", m); }

    static String clean(String n) {
        n = n.replaceAll("[\\p{Cntrl}]", "").trim();
        if (n.isEmpty()) n = "Player";
        return n.length() > 12 ? n.substring(0, 12).trim() : n;
    }

    static String normalizeCode(String c) { return c.toUpperCase().replaceAll("[^A-Z0-9]", ""); }

    private String newCode() {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < CODE_LEN; i++) b.append(CODE_CHARS.charAt(rnd.nextInt(CODE_CHARS.length())));
        return b.toString();
    }

    // ------------------------------------------------- leaving / disconnecting
    @Override
    public void afterConnectionClosed(WebSocketSession s, CloseStatus status) {
        String[] in = who.remove(s.getId());
        Room r = in == null ? null : rooms.get(in[0]);
        if (r == null || r.socks.get(in[1]) != s) return; // stale socket (player already reconnected / left)
        String pid = in[1];
        r.socks.remove(pid);
        boolean inGame;
        synchronized (r.game) {
            r.game.disconnect(pid);
            inGame = r.game.running();
        }
        // keep the seat for a grace period so refreshes / app-switches don't kick anyone, then free it
        ScheduledFuture<?> f = timers.schedule(() -> expire(r, pid), inGame ? GAME_GRACE_S : LOBBY_GRACE_S, TimeUnit.SECONDS);
        ScheduledFuture<?> prev = r.graceTimers.put(pid, f);
        if (prev != null) prev.cancel(false);
        flush(r);
    }

    private void expire(Room r, String pid) {
        r.graceTimers.remove(pid);
        if (r.socks.containsKey(pid)) return; // came back in time
        removePlayer(r, pid);
    }

    private void cancelGrace(Room r, String pid) {
        ScheduledFuture<?> f = r.graceTimers.remove(pid);
        if (f != null) f.cancel(false);
    }

    private void removePlayer(Room r, String pid) {
        cancelGrace(r, pid);
        WebSocketSession w = r.socks.remove(pid);
        if (w != null) who.remove(w.getId());
        r.seen.remove(pid);
        r.lastChat.remove(pid);
        synchronized (r.game) { r.game.leave(pid); }
        if (!discardIfEmpty(r)) flush(r);
    }

    /** Free the room (and its timers) once nobody is seated in it. */
    private boolean discardIfEmpty(Room r) {
        synchronized (r.game) {
            if (!r.game.players.isEmpty()) return false;
            r.dead = true;
        }
        rooms.remove(r.code, r);
        r.graceTimers.values().forEach(f -> f.cancel(false));
        r.graceTimers.clear();
        r.socks.values().forEach(this::closeQuietly);
        r.socks.clear();
        return true;
    }

    /** Periodic: drop half-open sockets (no traffic for a while) so their owners become "offline" and expire. */
    private void sweep() {
        try {
            long now = System.currentTimeMillis();
            for (Room r : rooms.values()) {
                r.socks.forEach((pid, ws) -> {
                    Long t = r.seen.get(pid);
                    if (t != null && now - t > IDLE_MS) closeQuietly(ws);
                });
                synchronized (r.game) {
                    if (r.game.players.isEmpty()) { r.dead = true; }
                }
                if (r.dead) discardIfEmpty(r);
            }
        } catch (Exception ignored) { }
    }

    // --------------------------------------------------------------- outgoing
    private void remember(Room r, Map<String, Object> m) {
        synchronized (r.history) {
            r.history.addLast(m);
            while (r.history.size() > HISTORY) r.history.removeFirst();
        }
    }

    /** Send pending game events (UNO calls, joins/leaves...) then every player's own state. */
    private void flush(Room r) {
        List<Map<String, Object>> evs;
        synchronized (r.game) { evs = r.game.drain(); }
        for (Map<String, Object> e : evs) {
            if ("sys".equals(e.get("kind"))) {
                Map<String, Object> c = new LinkedHashMap<>();
                c.put("type", "chat");
                c.put("system", true);
                c.put("text", e.get("text"));
                c.put("ts", System.currentTimeMillis());
                remember(r, c);
                r.socks.values().forEach(w -> send(w, c));
            } else {
                r.socks.values().forEach(w -> send(w, e));
            }
        }
        broadcast(r);
    }

    private void broadcast(Room r) {
        r.socks.forEach((pid, ws) -> {
            Map<String, Object> v;
            synchronized (r.game) { v = r.game.view(pid); }
            send(ws, v);
        });
    }

    private void closeQuietly(WebSocketSession ws) {
        try { ws.close(); } catch (Exception ignored) { }
    }

    private void send(WebSocketSession ws, Object o) {
        try {
            synchronized (ws) {
                if (ws.isOpen()) ws.sendMessage(new TextMessage(om.writeValueAsString(o)));
            }
        } catch (Exception ignored) { }
    }
}
