import { TTSEngine, TTSResult } from './engine';
import { KokoroTTS } from './kokoro';
import { ElevenLabsTTS } from './elevenlabs';
import { config } from '../config';

export class TTSManager implements TTSEngine {
  private kokoro: KokoroTTS;
  private elevenlabs: ElevenLabsTTS;
  private primaryAvailable: boolean = false;

  constructor() {
    this.kokoro = new KokoroTTS();
    this.elevenlabs = new ElevenLabsTTS();
    this.checkAvailability();
  }

  private async checkAvailability(): Promise<void> {
    try {
      this.primaryAvailable = await this.kokoro.isAvailable();
      console.log(`[TTS] Kokoro available: ${this.primaryAvailable}`);
    } catch {
      this.primaryAvailable = false;
      console.log('[TTS] Kokoro unavailable');
    }

    if (!this.primaryAvailable) {
      try {
        const elevenAvailable = await this.elevenlabs.isAvailable();
        console.log(`[TTS] ElevenLabs available: ${elevenAvailable}`);
      } catch {
        console.log('[TTS] ElevenLabs unavailable');
      }
    }
  }

  async synthesize(text: string): Promise<TTSResult> {
    // Try Kokoro first
    if (this.primaryAvailable) {
      try {
        console.log(`[TTS] Using Kokoro for: "${text.substring(0, 50)}..."`);
        return await this.kokoro.synthesize(text);
      } catch (e) {
        console.warn('[TTS] Kokoro failed, falling back to ElevenLabs:', (e as Error).message);
      }
    }

    // Fall back to ElevenLabs
    if (config.elevenlabsKey) {
      try {
        console.log(`[TTS] Using ElevenLabs for: "${text.substring(0, 50)}..."`);
        return await this.elevenlabs.synthesize(text);
      } catch (e) {
        console.error('[TTS] ElevenLabs failed:', (e as Error).message);
      }
    }

    // Both failed - return placeholder (client will handle gracefully)
    console.error('[TTS] All TTS engines failed, broadcasting without audio');
    return {
      audioPath: '',
      audioUrl: '',
      phonemes: [],
      duration: 0
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.primaryAvailable || (await this.elevenlabs.isAvailable());
  }
}

export type { TTSResult, Phoneme } from './engine';
