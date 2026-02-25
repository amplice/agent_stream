export const config = {
  port: parseInt(process.env.PORT || '3200', 10),
  secret: process.env.NOX_SECRET || '',
  noxSecret: process.env.NOX_SECRET || '',
  elevenlabsKey: process.env.ELEVENLABS_KEY || '',
  elevenlabsVoiceId: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
  kokoroUrl: process.env.KOKORO_URL || 'http://localhost:3202',
  ttsCacheDir: process.env.TTS_CACHE_DIR || '/tmp/nox-tts',
  chatMaxLength: parseInt(process.env.CHAT_MAX_LENGTH || '280', 10),
  chatRateLimit: parseInt(process.env.CHAT_RATE_LIMIT || '3', 10),
  chatRateWindowMs: 10000,
};
