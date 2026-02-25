import { TTSEngine, TTSResult, Phoneme } from './engine';
import { config } from '../config';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { promisify } from 'util';

export class KokoroTTS implements TTSEngine {
  private url: string;

  constructor() {
    this.url = config.kokoroUrl;
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = https.get(this.url, { timeout: 2000 }, () => {
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  async synthesize(text: string): Promise<TTSResult> {
    const timestamp = Date.now();
    const filename = `kokoro_${timestamp}.wav`;
    const audioPath = path.join(config.ttsCacheDir, filename);
    const audioUrl = `/audio/${filename}`;
    
    // Ensure cache directory exists
    if (!fs.existsSync(config.ttsCacheDir)) {
      fs.mkdirSync(config.ttsCacheDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        text,
        voice: 'af_heart',
        speed: 1.0,
        return_phonemes: true
      });

      const url = new URL(this.url + '/synthesize');
      const req = https.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 30000
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', async () => {
          try {
            const body = Buffer.concat(chunks);
            const data = JSON.parse(body.toString());
            
            if (data.audio) {
              // Write audio file
              fs.writeFileSync(audioPath, Buffer.from(data.audio, 'base64'));
            } else {
              throw new Error('No audio in Kokoro response');
            }

            const phonemes: Phoneme[] = (data.phonemes || []).map((p: any) => ({
              phoneme: p.phoneme,
              start: p.start,
              end: p.end
            }));

            // Estimate duration from phonemes or default
            const duration = phonemes.length > 0 
              ? phonemes[phonemes.length - 1].end 
              : text.length * 0.06; // Rough estimate

            resolve({
              audioPath,
              audioUrl,
              phonemes,
              duration
            });
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Kokoro request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }
}
