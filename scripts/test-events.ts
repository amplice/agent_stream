import WebSocket from 'ws';

const secret = process.env.NOX_SECRET || '';
const url = `ws://localhost:3200/ws/openclaw`;

const ws = new WebSocket(url, {
  headers: secret ? { 'Authorization': `Bearer ${secret}` } : {}
});

ws.on('open', async () => {
  console.log('Connected to nox-server');

  const send = (event: any) => {
    console.log('Sending:', event.type);
    ws.send(JSON.stringify(event));
  };

  // Simulate: thinking → typing → speaking → idle
  send({ type: 'thinking', ts: Date.now(), payload: {} });

  await sleep(2000);
  send({ type: 'typing', ts: Date.now(), payload: { token: 'Hello', fullText: 'Hello', done: false } });

  await sleep(500);
  send({ type: 'typing', ts: Date.now(), payload: { token: ' world', fullText: 'Hello world', done: false } });

  await sleep(500);
  send({ type: 'typing', ts: Date.now(), payload: { token: '!', fullText: 'Hello world!', done: true } });

  await sleep(1000);
  send({ type: 'speaking', ts: Date.now(), payload: { text: 'Hello world! How is everyone doing today?' } });

  await sleep(4000);
  send({ type: 'idle', ts: Date.now(), payload: {} });

  await sleep(1000);
  send({ type: 'executing', ts: Date.now(), payload: { command: 'npm test', sessionId: 'test1' } });

  await sleep(2000);
  send({ type: 'idle', ts: Date.now(), payload: {} });

  console.log('Test sequence complete');
  ws.close();
});

ws.on('error', (e) => console.error('WS Error:', e.message));

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}