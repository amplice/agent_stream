import WebSocket, { WebSocketServer } from 'ws';
import { config } from './config';
import { EventRouter } from './eventRouter';

interface OpenClawEvent {
  type: string;
  ts: number;
  payload: unknown;
}

/**
 * OpenClawBridge - WebSocket server that accepts incoming OpenClaw connections.
 * Listens on /ws/openclaw path and forwards events between OpenClaw and stream clients.
 */
export class OpenClawBridge {
  private wss: WebSocketServer | null = null;
  private openClawConnection: WebSocket | null = null;
  private eventRouter: EventRouter;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(eventRouter: EventRouter) {
    this.eventRouter = eventRouter;
  }

  /**
   * Start the WebSocket server on the specified port
   */
  start(port: number): void {
    this.wss = new WebSocketServer({ port, path: '/ws/openclaw' });

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    this.wss.on('error', (err) => {
      console.error('[OpenClawBridge] Server error:', err);
    });

    console.log(`[OpenClawBridge] Listening on ws://localhost:${port}/ws/openclaw`);
  }

  /**
   * Handle incoming OpenClaw WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: { url?: string; headers?: any }): void {
    const token = this.extractBearerToken(req);

    if (!token || token !== config.secret) {
      ws.close(4001, 'Unauthorized');
      console.warn('[OpenClawBridge] Unauthorized connection attempt');
      return;
    }

    console.log('[OpenClawBridge] OpenClaw connected');
    this.openClawConnection = ws;

    ws.on('message', (data) => {
      try {
        const event: OpenClawEvent = JSON.parse(data.toString());
        this.handleEvent(event);
      } catch (e) {
        console.error('[OpenClawBridge] Invalid event JSON:', e);
      }
    });

    ws.on('close', () => {
      console.log('[OpenClawBridge] OpenClaw disconnected');
      this.openClawConnection = null;
    });

    ws.on('error', (err) => {
      console.error('[OpenClawBridge] WebSocket error:', err);
    });

    // Send acknowledgement
    this.sendToOpenClaw({ type: 'connected', ts: Date.now(), payload: { status: 'ok' } });
  }

  /**
   * Process incoming events from OpenClaw
   */
  private handleEvent(event: OpenClawEvent): void {
    console.log(`[OpenClawBridge] Event: ${event.type}`);
    this.eventRouter.route(event);
  }

  /**
   * Extract Bearer token from request headers or query string
   */
  private extractBearerToken(req: { url?: string; headers?: any }): string | null {
    // Check Authorization header
    const auth = req.headers?.authorization;
    if (auth?.startsWith('Bearer ')) {
      return auth.slice(7);
    }

    // Check query string
    if (req.url) {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (token) return token;
    }

    return null;
  }

  /**
   * Send an event to OpenClaw if connected
   */
  sendToOpenClaw(event: unknown): boolean {
    if (!this.openClawConnection || this.openClawConnection.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      this.openClawConnection.send(JSON.stringify(event));
      return true;
    } catch (err) {
      console.error('[OpenClawBridge] Failed to send to OpenClaw:', err);
      return false;
    }
  }

  /**
   * Forward a chat message from stream clients to OpenClaw
   */
  forwardChatToOpenClaw(username: string, text: string): void {
    this.sendToOpenClaw({
      type: 'chat_message',
      ts: Date.now(),
      payload: { username, text }
    });
  }

  /**
   * Check if OpenClaw is connected
   */
  isConnected(): boolean {
    return this.openClawConnection !== null && 
           this.openClawConnection.readyState === WebSocket.OPEN;
  }

  /**
   * Get the OpenClaw connection for external access
   */
  getConnection(): WebSocket | null {
    return this.openClawConnection;
  }

  /**
   * Stop the server
   */
  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (this.openClawConnection) {
      this.openClawConnection.close();
      this.openClawConnection = null;
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    console.log('[OpenClawBridge] Stopped');
  }
}