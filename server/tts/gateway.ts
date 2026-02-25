/**
 * GatewayTTS — calls the OpenClaw gateway's built-in TTS via /tools/invoke
 * Works with the 'edge' provider (free, fast, reliable).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { TTSEngine, TTSResult } from './engine.js';
import { config } from '../config.js';

const GATEWAY = config.gatewayUrl;
const GW_TOKEN = config.gatewayToken;

export class GatewayTTS implements TTSEngine {
  private available: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const result = await this.invoke('test');
      this.available = !!(result?.audioPath);
      console.log(`[GatewayTTS] available: ${this.available}`);
      return this.available;
    } catch {
      this.available = false;
      return false;
    }
  }

  private async invoke(text: string): Promise<{ audioPath: string } | null> {
    const res = await fetch(`${GATEWAY}/tools/invoke`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GW_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tool: 'tts', args: { text } }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) throw new Error(`gateway ${res.status}`);
    const data = await res.json() as { ok: boolean; result?: { details?: Record<string, unknown> } };
    if (!data.ok) throw new Error('gateway returned error');
    const details = data.result?.details;
    if (!details || typeof details.audioPath !== 'string') return null;
    return { audioPath: details.audioPath as string };
  }

  async synthesize(text: string): Promise<TTSResult> {
    const hash = crypto.createHash('md5').update(text).digest('hex');
    const cacheFile = path.join(config.ttsCacheDir, `${hash}.mp3`);

    // Return cached if available
    if (fs.existsSync(cacheFile)) {
      const stat = fs.statSync(cacheFile);
      const duration = estimateDuration(stat.size);
      const audioUrl = `/audio/${hash}.mp3`;
      return { audioPath: cacheFile, audioUrl, phonemes: fakePhonemes(text, duration), duration };
    }

    const result = await this.invoke(text);
    if (!result?.audioPath || !fs.existsSync(result.audioPath)) {
      throw new Error('TTS produced no file');
    }

    // Copy to our cache dir (gateway /tmp paths may be ephemeral)
    fs.copyFileSync(result.audioPath, cacheFile);
    const stat = fs.statSync(cacheFile);
    const duration = estimateDuration(stat.size);
    const audioUrl = `/audio/${hash}.mp3`;

    console.log(`[GatewayTTS] cached: ${cacheFile} (${stat.size}B, ~${duration.toFixed(1)}s)`);
    return { audioPath: cacheFile, audioUrl, phonemes: fakePhonemes(text, duration), duration };
  }
}

/** Rough estimate: MP3 at ~32kbps ≈ 4000 bytes/sec */
function estimateDuration(bytes: number): number {
  return Math.max(0.5, bytes / 4000);
}

/**
 * Generate fake phoneme timestamps spread across the audio duration.
 * Used for lip-sync amplitude — no real phoneme data but gives the mouth
 * something to animate to.
 */
function fakePhonemes(text: string, duration: number) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const phonemes: { phoneme: string; start: number; end: number }[] = [];
  const vowels = ['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW'];
  const cons = ['B', 'CH', 'D', 'DH', 'F', 'G', 'HH', 'JH', 'K', 'L', 'M', 'N', 'NG', 'P', 'R', 'S', 'SH', 'T', 'TH', 'V', 'W', 'Y', 'Z', 'ZH'];

  const timePerChar = duration / Math.max(1, text.length);
  let t = 0.05;

  for (const word of words) {
    for (const ch of word.toLowerCase()) {
      const dur = timePerChar * (0.8 + Math.random() * 0.4);
      const isVowel = 'aeiou'.includes(ch);
      const pool = isVowel ? vowels : cons;
      phonemes.push({ phoneme: pool[Math.floor(Math.random() * pool.length)], start: t, end: t + dur });
      t += dur;
    }
    t += timePerChar * 0.5; // word gap
  }

  return phonemes;
}
