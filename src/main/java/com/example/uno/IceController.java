package com.example.uno;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * ICE servers handed to the browser for voice chat. Public STUN works for most home networks.
 * Strict corporate/mobile NATs need a TURN relay: set UNO_TURN_URL (e.g. turn:turn.example.com:3478),
 * UNO_TURN_USER and UNO_TURN_PASS in the environment and clients pick it up automatically.
 */
@RestController
public class IceController {
    @GetMapping("/api/ice")
    public Map<String, Object> ice() {
        List<Map<String, Object>> servers = new ArrayList<>();
        servers.add(Map.of("urls", List.of("stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302")));
        String turn = System.getenv("UNO_TURN_URL");
        if (turn != null && !turn.isBlank()) {
            String user = System.getenv().getOrDefault("UNO_TURN_USER", "");
            String pass = System.getenv().getOrDefault("UNO_TURN_PASS", "");
            servers.add(Map.of("urls", List.of(turn.trim()), "username", user, "credential", pass));
        }
        return Map.of("iceServers", servers);
    }
}
