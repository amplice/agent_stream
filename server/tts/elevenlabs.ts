import { TTSEngine, TTSResult } from './engine';
import { config } from '../config';
import * as fs from 'fs';
import * as path from 'path';

export class ElevenLabsTTS implements TTSEngine {
  private apiKey: string;
  private voiceId: string;

  constructor() {
    this.apiKey = config.elevenlabsKey;
    this.voiceId = config.elevenlabsVoiceId || '21m00Tcm4TlvDq8ikWAM'; // Rachel default
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/voices`, {
        headers: { 'xi-api-key': this.apiKey }
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async synthesize(text: string): Promise<TTSResult> {
    const timestamp = Date.now();
    const filename = `elevenlabs_${timestamp}.wav`;
    const audioPath = path.join(config.ttsCacheDir, filename);
    const audioUrl = `/audio/${filename}`;
    
    // Ensure cache directory exists
    if (!fs.existsSync(config.ttsCacheDir)) {
      fs.mkdirSync(config.ttsCacheDir, { recursive: true });
    }

    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.7
        }
      })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`ElevenLabs API error: ${res.status} ${err}`);
    }

    const audioBuffer = await res.arrayBuffer();
    fs.writeFileSync(audioPath, Buffer.from(audioBuffer));

    // Estimate duration (rough: ~150 chars per minute at normal speed)
    const duration = text.length * 0.4;

    return {
      audioPath,
      audioUrl,
      phonemes: [], // ElevenLabs doesn't provide phoneme data
      duration
    };
  }
}
