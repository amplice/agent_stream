import WebSocket from 'ws';
import { config } from './config';

interface ChatMessage {
  type: 'chat_message';
  ts: number;
  payload: {
    username: string;
    text: string;
    id: string;
  };
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * ChatManager - Handles chat message routing between stream clients and OpenClaw.
 * Features: rate limiting (3 msgs/10s per IP), max length (280 chars), HTML sanitization.
 */
export class ChatManager {
  private clients: Set<WebSocket> = new Set();
  private rateLimits: Map<string, RateLimitEntry> = new Map();
  private messageCounter: number = 0;
  private forwardCallback: ((username: string, text: string) => void) | null = null;

  /**
   * Add a stream client WebSocket to the broadcast list
   */
  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    
    ws.on('close', () => {
      this.clients.delete(ws);
    });
    
    ws.on('error', () => {
      this.clients.delete(ws);
    });
  }

  /**
   * Set callback for forwarding chat to OpenClaw bridge
   */
  setForwardCallback(callback: (username: string, text: string) => void): void {
    this.forwardCallback = callback;
  }

  /**
   * Process incoming chat message from a stream client
   */
  handleChatMessage(ws: WebSocket, data: { payload?: { username?: unknown; text?: unknown } }, remoteIp: string): ChatMessage | null {
    const { username, text } = data.payload || {};

    // Validate username
    if (!username || typeof username !== 'string') {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid username' } }));
      return null;
    }

    // Validate text
    if (!text || typeof text !== 'string') {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid text' } }));
      return null;
    }

    // Sanitize inputs
    const sanitizedUsername = this.sanitize(username);
    const sanitizedText = this.sanitize(text);

    // Rate limiting: 3 messages per 10 seconds per IP
    if (!this.checkRateLimit(remoteIp)) {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'Rate limit exceeded' } }));
      return null;
    }

    // Max length: 280 characters
    if (sanitizedText.length > config.chatMaxLength) {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'Message too long' } }));
      return null;
    }

    const chatMessage: ChatMessage = {
      type: 'chat_message',
      ts: Date.now(),
      payload: {
        username: sanitizedUsername,
        text: sanitizedText,
        id: `msg_${++this.messageCounter}_${Date.now()}`
      }
    };

    // Broadcast to all stream clients
    this.broadcastChat(sanitizedUsername, sanitizedText);

    // Forward to OpenClaw bridge if callback is set
    if (this.forwardCallback) {
      this.forwardCallback(sanitizedUsername, sanitizedText);
    }

    return chatMessage;
  }

  /**
   * Broadcast chat message to all connected stream clients
   */
  broadcastChat(username: string, text: string): void {
    const message: ChatMessage = {
      type: 'chat_message',
      ts: Date.now(),
      payload: {
        username,
        text,
        id: `msg_${++this.messageCounter}_${Date.now()}`
      }
    };

    const data = JSON.stringify(message);
    
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Forward chat message to OpenClaw bridge
   */
  forwardToOpenClaw(username: string, text: string): void {
    if (this.forwardCallback) {
      this.forwardCallback(username, text);
    }
  }

  /**
   * Sanitize text by stripping HTML and escaping XSS vectors
   */
  private sanitize(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .trim();
  }

  /**
   * Check rate limit for an IP (3 messages per 10 seconds)
   */
  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = this.rateLimits.get(ip);

    if (!entry || now > entry.resetAt) {
      this.rateLimits.set(ip, {
        count: 1,
        resetAt: now + config.chatRateWindowMs
      });
      return true;
    }

    if (entry.count >= config.chatRateLimit) {
      return false;
    }

    entry.count++;
    return true;
  }

  /**
   * Cleanup expired rate limit entries
   */
  cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.rateLimits.entries()) {
      if (now > entry.resetAt) {
        this.rateLimits.delete(ip);
      }
    }
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }
}