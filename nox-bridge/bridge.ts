import WebSocket from 'ws';

interface NoxBridgeConfig {
  serverUrl: string;
  token: string;
  reconnectInterval?: number;
  maxReconnectInterval?: number;
}

interface NoxEvent {
  type: 'thinking' | 'typing' | 'speaking' | 'executing' | 'idle' | 'connected' | 'disconnected';
  ts: number;
  payload: unknown;
}

/**
 * NoxBridge - Client that connects to the Nox Virtual Streamer server.
 * Emits events for real-time visual feedback during agent lifecycle.
 */
export class NoxBridge {
  private ws: WebSocket | null = null;
  private config: NoxBridgeConfig;
  private reconnectAttempts: number = 0;
  private eventQueue: NoxEvent[] = [];
  private listeners: Map<string, Set<(data: unknown) => void>> = new Map();
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private shouldReconnect: boolean = true;

  constructor(config: NoxBridgeConfig) {
    this.config = {
      reconnectInterval: 1000,
      maxReconnectInterval: 30000,
      ...config
    };
  }

  /**
   * Connect to the Nox server
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.config.serverUrl);

      this.ws.on('open', () => {
        console.log('[NoxBridge] Connected to Nox server');
        this.reconnectAttempts = 0;
        this.emit('connected', {});
        this.flushEventQueue();
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleServerEvent(event);
        } catch (e) {
          console.error('[NoxBridge] Invalid message:', e);
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[NoxBridge] Disconnected (code: ${code}, reason: ${reason})`);
        this.emit('disconnected', { code, reason: reason.toString() });
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error('[NoxBridge] WebSocket error:', err);
        if (this.reconnectAttempts === 0) {
          reject(err);
        }
      });
    });
  }

  /**
   * Disconnect from the Nox server
   */
  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Emit an event to the Nox server
   */
  async emit(type: NoxEvent['type'], payload: unknown): Promise<boolean> {
    const event: NoxEvent = {
      type,
      ts: Date.now(),
      payload
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
      return true;
    }

    // Queue event if not connected
    this.eventQueue.push(event);
    return false;
  }

  /**
   * Subscribe to events
   */
  on(event: string, callback: (data: unknown) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  /**
   * Unsubscribe from events
   */
  off(event: string, callback: (data: unknown) => void): void {
    this.listeners.get(event)?.delete(callback);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Handle events from the server
   */
  private handleServerEvent(event: NoxEvent): void {
    const callbacks = this.listeners.get(event.type);
    if (callbacks) {
      callbacks.forEach(cb => cb(event.payload));
    }
  }

  /**
   * Emit internal events
   */
  private emit(event: string, data: unknown): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach(cb => cb(data));
    }
  }

  /**
   * Flush queued events
   */
  private flushEventQueue(): void {
    while (this.eventQueue.length > 0 && this.isConnected()) {
      const event = this.eventQueue.shift();
      if (event) {
        this.ws!.send(JSON.stringify(event));
      }
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    const delay = Math.min(
      this.config.reconnectInterval! * Math.pow(2, this.reconnectAttempts),
      this.config.maxReconnectInterval!
    );

    this.reconnectAttempts++;
    console.log(`[NoxBridge] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch(() => {
        // Already handled in the connect method
      });
    }, delay);
  }
}

export type { NoxEvent, NoxBridgeConfig };