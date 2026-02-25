import type { VRM } from '@pixiv/three-vrm';
import type { AudioPlayer } from './audioPlayer';

/** Try setting expression, silently ignore if not found */
function safeSetExpression(vrm: VRM, name: string, value: number): void {
  try {
    vrm.expressionManager?.setValue(name, value);
  } catch {
    // Expression not available on this model
  }
}

interface Phoneme {
  phoneme: string;
  start: number;
  end: number;
}

const PHONEME_TO_VISEME: Record<string, string> = {
  'AA': 'aa', 'AE': 'aa', 'AH': 'aa', 'AY': 'aa',
  'EH': 'ee', 'EY': 'ee', 'ER': 'ee',
  'IH': 'ih', 'IY': 'ih',
  'OH': 'oh', 'OW': 'oh', 'OY': 'oh',
  'UH': 'ou', 'UW': 'ou', 'AW': 'ou',
  'PP': 'aa', 'BB': 'aa', 'MM': 'aa',
  'FF': 'ih', 'VV': 'ih',
  'TH': 'oh', 'DH': 'oh',
  'DD': 'aa', 'TT': 'aa', 'NN': 'aa', 'LL': 'aa',
  'CH': 'ee', 'JH': 'ee', 'SH': 'ee', 'ZH': 'ee',
  'SS': 'ih', 'ZZ': 'ih',
  'RR': 'oh',
  'KK': 'aa', 'GG': 'aa', 'NG': 'aa',
  'SIL': 'neutral', 'SP': 'neutral',
};

// VRM 0.x expression names (BotBunny uses VRM 0.x via @pixiv/three-vrm@1.x)
const VISEME_EXPRESSIONS = ['aa', 'ee', 'ih', 'oh', 'ou'];

export class LipSync {
  private vrm: VRM;
  private player: AudioPlayer | null = null;
  private phonemes: Phoneme[] = [];
  private active = false;
  private mode: 'phoneme' | 'amplitude' = 'amplitude';
  private currentViseme = 'neutral';
  private targetViseme = 'neutral';
  private blend = 1;

  constructor(vrm: VRM) {
    this.vrm = vrm;
  }

  startWithPhonemes(phonemes: Phoneme[], player: AudioPlayer): void {
    this.phonemes = phonemes;
    this.player = player;
    this.mode = 'phoneme';
    this.active = true;
  }

  startAmplitude(player: AudioPlayer): void {
    this.player = player;
    this.mode = 'amplitude';
    this.active = true;
  }

  stop(): void {
    this.active = false;
    this.clearVisemes();
  }

  get isActive(): boolean {
    return this.active;
  }

  update(dt: number): void {
    if (!this.active || !this.vrm.expressionManager) return;

    if (this.mode === 'phoneme' && this.player) {
      const t = this.player.currentTime;
      const active = this.phonemes.find(p => t >= p.start && t < p.end);
      const newV = active ? (PHONEME_TO_VISEME[active.phoneme] ?? 'neutral') : 'neutral';

      if (newV !== this.targetViseme) {
        this.currentViseme = this.targetViseme;
        this.targetViseme = newV;
        this.blend = 0;
      }

      this.blend = Math.min(1, this.blend + dt / 0.045);
      this.clearVisemes();

      if (this.currentViseme !== 'neutral') {
        safeSetExpression(this.vrm, this.currentViseme, 1 - this.blend);
      }
      if (this.targetViseme !== 'neutral') {
        safeSetExpression(this.vrm, this.targetViseme, this.blend);
      }
    } else if (this.mode === 'amplitude' && this.player) {
      const vol = this.player.getVolume();
      this.clearVisemes();
      // Map volume to mouth open — aa for wide, oh for round
      safeSetExpression(this.vrm, 'aa', vol * 0.85);
      safeSetExpression(this.vrm, 'oh', vol * 0.25);
    }
  }

  private clearVisemes(): void {
    if (!this.vrm.expressionManager) return;
    for (const v of VISEME_EXPRESSIONS) {
      safeSetExpression(this.vrm, v, 0);
    }
  }
}