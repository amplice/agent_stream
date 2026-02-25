import { TTSEngine, TTSResult } from './engine';
import { KokoroTTS } from './kokoro';
import { ElevenLabsTTS } from './elevenlabs';
import { GatewayTTS } from './gateway';
import { config } from '../config';

export class TTSManager implements TTSEngine {
  private kokoro: KokoroTTS;
  private elevenlabs: ElevenLabsTTS;
  private gateway: GatewayTTS;
  private primaryAvailable: boolean = false;
  private gatewayAvailable: boolean = false;

  constructor() {
    this.kokoro = new KokoroTTS();
    this.elevenlabs = new ElevenLabsTTS();
    this.gateway = new GatewayTTS();
    this.checkAvailability();
  }

  private async checkAvailability(): Promise<void> {
    // Try Kokoro first (best quality)
    try {
      this.primaryAvailable = await this.kokoro.isAvailable();
      console.log(`[TTS] Kokoro available: ${this.primaryAvailable}`);
    } catch {
      this.primaryAvailable = false;
      console.log('[TTS] Kokoro unavailable');
    }

    // Check ElevenLabs
    if (!this.primaryAvailable && config.elevenlabsKey) {
      try {
        const elevenAvailable = await this.elevenlabs.isAvailable();
        console.log(`[TTS] ElevenLabs available: ${elevenAvailable}`);
      } catch {
        console.log('[TTS] ElevenLabs unavailable');
      }
    }

    // Check Gateway TTS (our reliable fallback)
    try {
      this.gatewayAvailable = await this.gateway.isAvailable();
      console.log(`[TTS] Gateway TTS available: ${this.gatewayAvailable}`);
    } catch {
      this.gatewayAvailable = false;
      console.log('[TTS] Gateway TTS unavailable');
    }
  }

  async synthesize(text: string): Promise<TTSResult> {
    // Try Kokoro first (highest quality)
    if (this.primaryAvailable) {
      try {
        console.log(`[TTS] Using Kokoro for: "${text.substring(0, 50)}"`);
        return await this.kokoro.synthesize(text);
      } catch (e) {
        console.warn('[TTS] Kokoro failed:', (e as Error).message);
      }
    }

    // Fall back to ElevenLabs
    if (config.elevenlabsKey) {
      try {
        console.log(`[TTS] Using ElevenLabs for: "${text.substring(0, 50)}"`);
        return await this.elevenlabs.synthesize(text);
      } catch (e) {
        console.warn('[TTS] ElevenLabs failed:', (e as Error).message);
      }
    }

    // Fall back to OpenClaw Gateway TTS (edge provider, free, reliable)
    try {
      console.log(`[TTS] Using Gateway TTS for: "${text.substring(0, 50)}"`);
      const result = await this.gateway.synthesize(text);
      this.gatewayAvailable = true;
      return result;
    } catch (e) {
      console.error('[TTS] Gateway TTS failed:', (e as Error).message);
      this.gatewayAvailable = false;
    }

    // All failed — return empty (client handles gracefully)
    console.error('[TTS] All TTS engines failed, broadcasting without audio');
    return { audioPath: '', audioUrl: '', phonemes: [], duration: 0 };
  }

  async isAvailable(): Promise<boolean> {
    return this.primaryAvailable || this.gatewayAvailable || (await this.elevenlabs.isAvailable());
  }
}

export type { TTSResult, Phoneme } from './engine';
