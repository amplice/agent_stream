import { NoxBridge, NoxBridgeConfig } from './bridge';

interface MiddlewareConfig {
  serverUrl?: string;
  token?: string;
  emitThinking?: boolean;
  emitTyping?: boolean;
  emitSpeaking?: boolean;
  emitExecuting?: boolean;
  emitIdle?: boolean;
}

/**
 * Create middleware that automatically emits Nox events during agent operations
 */
export function createNoxBridgeMiddleware(config: MiddlewareConfig = {}) {
  const bridgeConfig: NoxBridgeConfig = {
    serverUrl: config.serverUrl || process.env.NOX_SERVER_URL?.replace(/\/$/, '') + '/ws/openclaw' || 'ws://localhost:3201/ws/openclaw',
    token: config.token || process.env.NOX_BRIDGE_TOKEN || process.env.NOX_SECRET || ''
  };

  const bridge = new NoxBridge(bridgeConfig);
  let currentModel: string | undefined;
  let messageId = 0;

  // Auto-connect on first use
  bridge.connect().catch(err => {
    console.warn('[NoxBridge Middleware] Failed to connect:', err.message);
  });

  /**
   * Wrap an async agent function to emit events
   */
  return function noxMiddleware<T>(
    agent: { complete: (msg: string) => Promise<T> },
    userMessage: string
  ): Promise<T> {
    const startTime = Date.now();
    const thisMessageId = `msg_${++messageId}_${startTime}`;

    // Emit thinking event
    if (config.emitThinking !== false) {
      bridge.emit('thinking', { 
        model: currentModel || 'unknown',
        messageId: thisMessageId
      });
    }

    return agent.complete(userMessage).then(async (result) => {
      // Emit speaking event (message sent)
      if (config.emitSpeaking !== false) {
        await bridge.emit('speaking', { 
          messageId: thisMessageId,
          duration: Date.now() - startTime
        });
      }

      // Emit idle event
      if (config.emitIdle !== false) {
        await bridge.emit('idle', { 
          duration: Date.now() - startTime,
          messageId: thisMessageId
        });
      }

      return result;
    });
  };
}

/**
 * Hook-based middleware for use with heartbeat or event emitters
 */
export class NoxBridgeHooks {
  private bridge: NoxBridge;
  private isThinking: boolean = false;
  private currentMessageId: string = '';

  constructor(config: MiddlewareConfig = {}) {
    this.bridge = new NoxBridge({
      serverUrl: config.serverUrl || process.env.NOX_SERVER_URL?.replace(/\/$/, '') + '/ws/openclaw' || 'ws://localhost:3201/ws/openclaw',
      token: config.token || process.env.NOX_BRIDGE_TOKEN || process.env.NOX_SECRET || ''
    });

    this.bridge.connect().catch(err => {
      console.warn('[NoxBridgeHooks] Failed to connect:', err.message);
    });
  }

  /**
   * Called when agent starts a model call
   */
  onThinking(model?: string): void {
    this.isThinking = true;
    this.currentMessageId = `msg_${Date.now()}`;
    this.bridge.emit('thinking', { model, messageId: this.currentMessageId });
  }

  /**
   * Called for each token streamed
   */
  onToken(token: string): void {
    if (this.isThinking) {
      this.bridge.emit('typing', { text: token, messageId: this.currentMessageId });
    }
  }

  /**
   * Called when a tool is about to execute
   */
  onExecuting(tool: string, command?: string): void {
    this.bridge.emit('executing', { tool, command, messageId: this.currentMessageId });
  }

  /**
   * Called when message is sent to user
   */
  async onSpeaking(): Promise<void> {
    this.isThinking = false;
    await this.bridge.emit('speaking', { messageId: this.currentMessageId });
  }

  /**
   * Called when agent is done
   */
  async onIdle(duration?: number): Promise<void> {
    await this.bridge.emit('idle', { 
      duration, 
      messageId: this.currentMessageId 
    });
  }

  /**
   * Get the underlying bridge instance
   */
  getBridge(): NoxBridge {
    return this.bridge;
  }
}

export { NoxBridge } from './bridge';
export type { NoxBridgeConfig } from './bridge';