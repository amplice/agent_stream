import { NoxBridge, NoxBridgeConfig } from './bridge';

let instance: NoxBridge | null = null;

/**
 * Get or create the singleton NoxBridge instance
 */
export function getNoxBridge(config?: Partial<NoxBridgeConfig>): NoxBridge {
  if (!instance) {
    const serverUrl = process.env.NOX_SERVER_URL?.replace(/\/$/, '') + '/ws/openclaw' 
      || 'ws://localhost:3201/ws/openclaw';
    const token = process.env.NOX_BRIDGE_TOKEN || process.env.NOX_SECRET || '';

    instance = new NoxBridge({
      serverUrl: config?.serverUrl || serverUrl,
      token: config?.token || token,
      reconnectInterval: config?.reconnectInterval,
      maxReconnectInterval: config?.maxReconnectInterval
    });
  }

  return instance;
}

/**
 * Initialize the NoxBridge with auto-connect
 */
export async function initNoxBridge(config?: Partial<NoxBridgeConfig>): Promise<NoxBridge> {
  const bridge = getNoxBridge(config);
  await bridge.connect();
  return bridge;
}

/**
 * Get existing instance or null
 */
export function getNoxBridgeInstance(): NoxBridge | null {
  return instance;
}

/**
 * Reset the singleton (useful for testing)
 */
export function resetNoxBridge(): void {
  if (instance) {
    instance.disconnect();
    instance = null;
  }
}

// Re-export types
export type { NoxBridgeConfig } from './bridge';
export { NoxBridge } from './bridge';