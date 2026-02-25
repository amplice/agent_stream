import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { TTSManager } from './tts/index.js';

interface NoxEvent {
  type: string;
  ts: number;
  payload: unknown;
}

type Broadcaster = (data: unknown) => void;

let _broadcast: Broadcaster = () => {};

// Create TTS manager singleton
const tts = new TTSManager();

// Ensure TTS cache directory exists at startup
fs.mkdirSync(config.ttsCacheDir, { recursive: true });
console.log(`[eventRouter] TTS cache dir: ${config.ttsCacheDir}`);

export function setBroadcaster(fn: Broadcaster) {
  _broadcast = fn;
}

export async function eventRouter(event: NoxEvent) {
  if (!event.type || typeof event.ts !== 'number') {
    console.warn('Invalid event:', event);
    return;
  }
  console.log(`[eventRouter] ${event.type}`);

  // Enrich 'speaking' and 'narrate' events with TTS
  if ((event.type === 'speaking' || event.type === 'narrate') && event.payload && typeof event.payload === 'object') {
    const payload = event.payload as Record<string, unknown>;
    if (payload.text && typeof payload.text === 'string') {
      try {
        const result = await tts.synthesize(payload.text);
        payload.audioUrl = result.audioUrl;
        payload.phonemes = result.phonemes;
        payload.duration = result.duration;
        console.log(`[eventRouter] TTS enriched: audioUrl=${result.audioUrl ? 'set' : 'none'}, phonemes=${result.phonemes.length}`);
      } catch (e) {
        console.warn('[eventRouter] TTS synthesis failed:', (e as Error).message);
      }
    }
  }

  _broadcast(event);
}

// Class-based interface for openclawBridge compatibility
export class EventRouter {
  route(event: NoxEvent) {
    // @ts-ignore - async call in sync context, fire-and-forget
    eventRouter(event);
  }
}
