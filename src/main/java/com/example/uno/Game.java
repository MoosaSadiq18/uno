package com.example.uno;

import java.security.SecureRandom;
import java.util.*;

/**
 * One UNO table (2-8 players). Server-authoritative; always call inside synchronized(game).
 *
 * Side effects that other players must be told about (UNO calls, catches, joins, leaves, host changes)
 * are queued with {@link #ev} and drained by the socket layer after every action.
 */
public class Game {
    public static final int MIN_PLAYERS = 2, MAX_PLAYERS = 8, AVATARS = 12;
    static final List<String> COLORS = List.of("R", "G", "B", "Y");
    private static final SecureRandom RND = new SecureRandom();

    public record Card(String color, String value) {
        boolean wild() { return color.equals("W"); }
    }

    static class Player {
        final String id;          // private reconnect token - NEVER sent to other players
        final String pub;         // public id used by clients (signaling, avatars, chat)
        String name;
        int avatar;
        final List<Card> hand = new ArrayList<>();
        boolean on = true;
        boolean voice, muted;     // voice-chat status (informational, set by the client)
        boolean uno;              // has called UNO for the current single-card state
        boolean armed;            // pressed UNO ahead of playing the second-to-last card
        int score;
        Player(String id, String name, int avatar) {
            this.id = id; this.name = name; this.avatar = avatar;
            this.pub = Long.toString(RND.nextLong() & Long.MAX_VALUE, 36).substring(0, 6);
        }
    }

    final List<Player> players = new ArrayList<>();
    final Deque<Card> deck = new ArrayDeque<>();
    final List<Card> discard = new ArrayList<>();
    final List<Map<String, Object>> events = new ArrayList<>();
    boolean started, over, forfeit;
    int turn, dir = 1;
    int maxPlayers = 4;
    int pending;                  // stacked draw penalty (stack mode only)
    String mode = "classic";      // classic | stack
    String pin = "";              // optional private-room PIN
    String code = "";
    String hostId = "";
    String unoWindow = null;      // player id that reached 1 card without calling UNO and can still be caught
    String color = "R", winner = "", log = "Waiting for players...";

    // ---------------------------------------------------------------- helpers
    Player find(String id) {
        for (Player p : players) if (p.id.equals(id)) return p;
        return null;
    }

    Player byPub(String pub) {
        for (Player p : players) if (p.pub.equals(pub)) return p;
        return null;
    }

    Card top() { return discard.get(discard.size() - 1); }

    boolean running() { return started && !over; }

    void ev(String kind, Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "event");
        m.put("kind", kind);
        for (int i = 0; i + 1 < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        events.add(m);
    }

    void sys(String text) { ev("sys", "text", text); }

    public List<Map<String, Object>> drain() {
        List<Map<String, Object>> out = new ArrayList<>(events);
        events.clear();
        return out;
    }

    public void configure(int max, String mode, String pin) {
        this.maxPlayers = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, max));
        this.mode = "stack".equals(mode) ? "stack" : "classic";
        this.pin = pin == null ? "" : pin;
    }

    boolean isHost(String id) { return id.equals(hostId); }

    // ------------------------------------------------------------- membership
    /** Add a player, or reconnect an existing one. Returns an error message or null. */
    public String add(String id, String name, int avatar, String givenPin) {
        Player ex = find(id);
        if (ex != null) {
            if (!ex.on) sys(ex.name + " reconnected");
            ex.on = true;
            return null;
        }
        if (!pin.isEmpty() && !pin.equals(givenPin == null ? "" : givenPin))
            return (givenPin == null || givenPin.isEmpty()) ? "This room needs a PIN" : "Wrong PIN";
        if (running()) return "Game already started";
        if (players.size() >= maxPlayers) return "Room is full (" + maxPlayers + " max)";
        String base = name, n = name;
        for (int i = 2; nameTaken(n); i++) n = base.substring(0, Math.min(base.length(), 10)) + " " + i;
        Player p = new Player(id, n, Math.floorMod(avatar, AVATARS));
        players.add(p);
        if (hostId.isEmpty() || find(hostId) == null) hostId = id;
        log = n + " joined";
        sys(n + " joined the room");
        return null;
    }

    private boolean nameTaken(String n) {
        for (Player p : players) if (p.name.equalsIgnoreCase(n)) return true;
        return false;
    }

    /** Connection dropped: keep the seat for now (the socket layer removes it after a grace period). */
    public void disconnect(String id) {
        Player p = find(id);
        if (p == null || !p.on) return;
        p.on = false;
        p.voice = false;
        log = p.name + " disconnected";
        sys(p.name + " lost connection");
        if (running()) skipOff();
    }

    /** Remove a player for good (clicked Leave, or the reconnect grace expired). */
    public void leave(String id) {
        Player p = find(id);
        if (p == null) return;
        int idx = players.indexOf(p);
        boolean inGame = running();
        boolean wasTurn = inGame && idx == turn;
        players.remove(idx);
        log = p.name + " left";
        sys(p.name + " left the game");
        if (id.equals(unoWindow)) unoWindow = null;

        if (inGame) {
            if (!p.hand.isEmpty()) { // their cards go back into the deck so no card is lost
                List<Card> all = new ArrayList<>(deck);
                all.addAll(p.hand);
                Collections.shuffle(all);
                deck.clear();
                deck.addAll(all);
            }
            if (players.size() < MIN_PLAYERS) {
                over = true;
                forfeit = true;
                pending = 0;
                unoWindow = null;
                winner = players.isEmpty() ? "" : players.get(0).name;
                log = players.isEmpty() ? "Everyone left" : "Not enough players left - " + winner + " wins by default";
                if (!players.isEmpty()) sys("Not enough players left - " + winner + " wins by default");
            } else {
                if (idx < turn) turn--;
                else if (wasTurn) turn = dir == 1 ? idx % players.size() : Math.floorMod(idx - 1, players.size());
                turn = Math.floorMod(turn, players.size());
                skipOff();
            }
        }
        if (id.equals(hostId)) reassignHost();
    }

    private void reassignHost() {
        hostId = "";
        if (players.isEmpty()) return;
        Player h = players.stream().filter(x -> x.on).findFirst().orElse(players.get(0));
        hostId = h.id;
        sys(h.name + " is now the host");
    }

    public void voice(String id, boolean on, boolean muted) {
        Player p = find(id);
        if (p == null) return;
        p.voice = on;
        p.muted = on && muted;
    }

    // ------------------------------------------------------------------ rules
    void reset() {
        started = over = forfeit = false;
        dir = 1; turn = 0; pending = 0; winner = ""; unoWindow = null;
        deck.clear(); discard.clear();
        players.forEach(p -> { p.hand.clear(); p.uno = p.armed = false; });
    }

    public String start(String id) {
        if (!isHost(id)) return "Only the host can start";
        if (running()) return "Already started";
        // drop seats whose owner is gone so nobody sits at the table as a ghost
        List<Player> gone = players.stream().filter(p -> !p.on).toList();
        if (players.size() - gone.size() >= MIN_PLAYERS) gone.forEach(p -> { players.remove(p); sys(p.name + " was removed (offline)"); });
        if (players.size() < MIN_PLAYERS) return "Need at least " + MIN_PLAYERS + " players";
        reset();
        List<Card> all = new ArrayList<>();
        for (String c : COLORS) {
            all.add(new Card(c, "0"));
            for (int i = 0; i < 2; i++) {
                for (int n = 1; n <= 9; n++) all.add(new Card(c, "" + n));
                for (String v : new String[]{"SKIP", "REV", "+2"}) all.add(new Card(c, v));
            }
        }
        for (int i = 0; i < 4; i++) { all.add(new Card("W", "WILD")); all.add(new Card("W", "+4")); }
        Collections.shuffle(all);
        deck.addAll(all);
        for (Player p : players) for (int i = 0; i < 7; i++) p.hand.add(deck.pop());
        Card first;
        while ((first = deck.pop()).wild()) deck.addLast(first);
        discard.add(first);
        color = first.color();
        started = true;
        turn = 0;
        skipOff();
        log = "Game on! " + players.get(turn).name + " goes first";
        sys("Game started with " + players.size() + " players");
        return null;
    }

    static int pts(Card c) {
        if (c.wild()) return 50;
        return Character.isDigit(c.value().charAt(0)) ? Integer.parseInt(c.value()) : 20;
    }

    /** Skip over players who are offline. Bounded so an all-offline table cannot loop forever. */
    void skipOff() {
        for (int n = 0; running() && n < players.size() && !players.get(turn).on; n++) turn = step(1);
    }

    boolean playable(Card c) {
        if (pending > 0) // must answer a stacked penalty with the same kind of card, or draw
            return "stack".equals(mode) && c.value().equals(top().value()) && (c.value().equals("+2") || c.value().equals("+4"));
        return c.wild() || c.color().equals(color) || c.value().equals(top().value());
    }

    int step(int n) { return Math.floorMod(turn + dir * n, players.size()); }

    Card draw1() {
        if (deck.isEmpty()) {
            if (discard.size() < 2) return null; // every other card is in a hand
            Card t = discard.remove(discard.size() - 1);
            Collections.shuffle(discard);
            deck.addAll(discard);
            discard.clear();
            discard.add(t);
        }
        return deck.pop();
    }

    void give(Player v, int n) {
        int got = 0;
        for (int i = 0; i < n; i++) {
            Card c = draw1();
            if (c == null) break;
            v.hand.add(c);
            got++;
        }
        v.uno = v.armed = false; // card count changed, UNO state no longer applies
        log += " -> " + v.name + " draws " + got;
    }

    public String play(String id, int idx, String chosen, String cardKey) {
        if (!running()) return "Game not running";
        Player p = players.get(turn);
        if (!p.id.equals(id)) return "Not your turn";
        if (idx < 0 || idx >= p.hand.size()) return "Bad card";
        Card c = p.hand.get(idx);
        if (cardKey != null && !cardKey.isEmpty() && !cardKey.equals(c.color() + ":" + c.value()))
            return "Your hand changed - try again";
        if (!playable(c)) return pending > 0 ? "Stack a " + top().value() + " or draw " + pending : "Can't play that card";
        if (c.wild() && !COLORS.contains(chosen)) return "Pick a color";

        unoWindow = null; // the next player has begun their turn: any earlier catch chance expires
        p.hand.remove(idx);
        discard.add(c);
        color = c.wild() ? chosen : c.color();
        log = p.name + " played " + c.value() + (c.wild() ? " (" + color + ")" : "");
        if (p.hand.isEmpty()) {
            over = true; winner = p.name; pending = 0;
            for (Player o : players) p.score += o.hand.stream().mapToInt(Game::pts).sum();
            log = p.name + " wins the round!";
            sys(p.name + " wins the round!");
            return null;
        }
        if (p.hand.size() == 1) {
            if (p.armed) { p.uno = true; announceUno(p); }
            else { unoWindow = p.id; log += " - one card left!"; }
        } else {
            p.uno = false;
        }
        p.armed = false;

        int steps = 1;
        boolean stack = "stack".equals(mode);
        switch (c.value()) {
            case "REV" -> { dir = -dir; if (players.size() == 2) steps = 2; }
            case "SKIP" -> steps = 2;
            case "+2" -> { if (stack) pending += 2; else { give(players.get(step(1)), 2); steps = 2; } }
            case "+4" -> { if (stack) pending += 4; else { give(players.get(step(1)), 4); steps = 2; } }
            default -> { }
        }
        turn = step(steps); skipOff();
        return null;
    }

    public String draw(String id) {
        if (!running()) return "Game not running";
        Player p = players.get(turn);
        if (!p.id.equals(id)) return "Not your turn";
        unoWindow = null;
        if (pending > 0) {
            int n = pending;
            pending = 0;
            log = p.name + " takes the stack";
            give(p, n);
        } else {
            Card c = draw1();
            if (c != null) p.hand.add(c);
            p.uno = p.armed = false;
            log = p.name + (c != null ? " drew a card" : " passed (no cards left)");
        }
        turn = step(1); skipOff();
        return null;
    }

    // -------------------------------------------------------------------- UNO
    private void announceUno(Player p) {
        log = p.name + " called UNO!";
        ev("uno", "pub", p.pub, "name", p.name);
    }

    /** The player pressed the UNO button. */
    public String uno(String id) {
        if (!running()) return "Game not running";
        Player p = find(id);
        if (p == null) return "Not in this game";
        if (p.hand.size() == 1) {
            if (p.uno) return "You already called UNO";
            if (!id.equals(unoWindow)) return "Too late - someone already played";
            unoWindow = null;
            p.uno = true;
            announceUno(p);
            return null;
        }
        if (p.hand.size() == 2 && players.get(turn) == p) { // call ahead, takes effect when the card is played
            p.armed = true;
            return null;
        }
        return "You can only call UNO with one card left";
    }

    /** Another player challenges a missed UNO. */
    public String catchUno(String id) {
        if (!running()) return "Game not running";
        Player c = find(id);
        if (c == null) return "Not in this game";
        Player v = unoWindow == null ? null : find(unoWindow);
        if (v == null || v.hand.size() != 1 || v.uno) return "Nobody to catch - too late or UNO was called";
        if (v == c) return "You can't catch yourself";
        unoWindow = null;
        log = c.name + " caught " + v.name + " without UNO!";
        give(v, 2);
        ev("caught", "pub", v.pub, "name", v.name, "by", c.name);
        return null;
    }

    // ------------------------------------------------------------------- view
    public Map<String, Object> view(String id) {
        Player me = find(id);
        boolean myTurn = running() && me != null && players.get(turn) == me;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "state");
        m.put("room", code);
        m.put("started", started);
        m.put("over", over);
        m.put("forfeit", forfeit);
        m.put("winner", winner);
        m.put("log", log);
        m.put("dir", dir);
        m.put("color", color);
        m.put("deck", deck.size());
        m.put("mode", mode);
        m.put("max", maxPlayers);
        m.put("min", MIN_PLAYERS);
        m.put("pending", pending);
        m.put("private", !pin.isEmpty());
        if (me != null && isHost(id) && !pin.isEmpty()) m.put("pin", pin);
        m.put("host", isHost(id));
        m.put("top", discard.isEmpty() ? null : top());
        Player w = unoWindow == null ? null : find(unoWindow);
        m.put("unoWindow", w == null ? null : w.pub);
        List<Map<String, Object>> ps = new ArrayList<>();
        for (int i = 0; i < players.size(); i++) {
            Player p = players.get(i);
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("pub", p.pub);
            o.put("name", p.name);
            o.put("avatar", p.avatar);
            o.put("count", p.hand.size());
            o.put("turn", running() && i == turn);
            o.put("me", p == me);
            o.put("on", p.on);
            o.put("score", p.score);
            o.put("seat", i);
            o.put("host", isHost(p.id));
            o.put("uno", p.uno && p.hand.size() == 1);
            o.put("voice", p.voice);
            o.put("muted", p.muted);
            ps.add(o);
        }
        m.put("players", ps);
        List<Card> hand = me == null ? List.of() : me.hand;
        m.put("hand", hand);
        m.put("playable", hand.stream().map(c -> myTurn && playable(c)).toList());
        m.put("armed", me != null && me.armed);
        return m;
    }
}
