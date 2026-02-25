export interface Phoneme {
  phoneme: string;
  start: number;
  end: number;
}

export interface TTSResult {
  audioPath: string;
  audioUrl: string;
  phonemes: Phoneme[];
  duration: number;
}

export interface TTSEngine {
  synthesize(text: string): Promise<TTSResult>;
  isAvailable(): Promise<boolean>;
}
