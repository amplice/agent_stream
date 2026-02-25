export class AudioPlayer {
  private audio: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private endCallbacks: (() => void)[] = [];
  private freqData: Uint8Array<ArrayBuffer> | null = null;

  constructor() {
    this.audio = document.createElement('audio');
    this.audio.crossOrigin = 'anonymous';
    this.audio.addEventListener('ended', () => {
      this.endCallbacks.forEach(cb => cb());
    });
  }

  private ensureContext(): void {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.source = this.ctx.createMediaElementSource(this.audio);
    this.source.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  async play(url: string): Promise<void> {
    this.ensureContext();
    if (this.ctx!.state === 'suspended') await this.ctx!.resume();
    this.audio.src = url;
    return this.audio.play();
  }

  stop(): void {
    this.audio.pause();
    this.audio.currentTime = 0;
  }

  get currentTime(): number {
    return this.audio.currentTime;
  }

  get playing(): boolean {
    return !this.audio.paused && !this.audio.ended;
  }

  /** Returns 0-1 RMS volume from frequency data */
  getVolume(): number {
    if (!this.analyser || !this.freqData) return 0;
    this.analyser.getByteFrequencyData(this.freqData);
    let sum = 0;
    const data = this.freqData as Uint8Array;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return sum / (data.length * 255);
  }

  onEnded(cb: () => void): void {
    this.endCallbacks.push(cb);
  }
}