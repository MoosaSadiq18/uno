package com.example.uno;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.*;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

@Configuration
@EnableWebSocket
public class WsConfig implements WebSocketConfigurer {
    private final UnoSocket handler;

    public WsConfig(UnoSocket handler) { this.handler = handler; }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws").setAllowedOrigins("*");
    }

    /** WebRTC offers carry a full SDP, so allow messages larger than Tomcat's 8 KB default. */
    @Bean
    public ServletServerContainerFactoryBean webSocketContainer() {
        ServletServerContainerFactoryBean c = new ServletServerContainerFactoryBean();
        c.setMaxTextMessageBufferSize(64 * 1024);
        c.setMaxSessionIdleTimeout(0L);
        return c;
    }
}
