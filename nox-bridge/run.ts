/**
 * nox-bridge/run.ts
 *
 * Polls the real OpenClaw session transcript via /tools/invoke
 * and streams actual tool calls + outputs to the nox server.
 *
 * Events sent to /ws/openclaw:
 *   { type: 'thinking' }
 *   { type: 'executing', payload: { command: 'exec', input: 'git push ...' } }
 *   { type: 'tool_result', payload: { output: '...' } }
 *   { type: 'speaking', payload: { text: '...' } }
 *   { type: 'idle' }
 */

const NOX_WS = 'wss://nox-stream-production.up.railway.app/ws/openclaw';
const GATEWAY = 'http://127.0.0.1:18789';
const GW_TOKEN = '377b9799e11a9dfa71e24b10f680b270332d9eeb39da9e36';
const SESSION_KEY = 'agent:main:main';
const POLL_MS = 600;

// Max chars of tool input/output to show
const MAX_INPUT = 120;
const MAX_OUTPUT = 200;

function truncate(s: string, max: number): string {
  if (!s) return '';
  const clean = s.replace(/\n+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

async function gwInvoke(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${GATEWAY}/tools/invoke`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GW_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tool, args }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  const data = await res.json() as { ok: boolean; result?: { details?: unknown } };
  if (!data.ok) throw new Error('gateway error');
  return (data.result as any)?.details ?? null;
}

function send(ws: WebSocket, type: string, payload: unknown = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ts: Date.now(), payload }));
  }
}

function getToolInput(block: any): string {
  const inp = block.input;
  if (!inp) return '';
  if (typeof inp === 'string') return inp;
  // For exec: show command
  if (inp.command) return inp.command;
  // For read/write/edit: show path
  if (inp.file_path || inp.path) return inp.file_path ?? inp.path;
  // For web_search: show query
  if (inp.query) return inp.query;
  // For web_fetch: show url
  if (inp.url) return inp.url;
  // Generic: first string value
  const vals = Object.values(inp).filter(v => typeof v === 'string');
  if (vals.length) return vals[0] as string;
  return JSON.stringify(inp).slice(0, MAX_INPUT);
}

function getToolOutput(block: any): string {
  const content = block.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text ?? '')
      .join(' ');
    return text;
  }
  return '';
}

type Message = {
  role: string;
  content: any;
};

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('[bridge] connecting to', NOX_WS);

  let ws: WebSocket | null = null;
  let wsReady = false;

  function connect() {
    ws = new WebSocket(NOX_WS);
    ws.onopen = () => { wsReady = true; console.log('[bridge] ws connected'); };
    ws.onclose = () => { wsReady = false; console.log('[bridge] ws closed, reconnecting...'); setTimeout(connect, 2000); };
    ws.onerror = () => { wsReady = false; };
  }
  connect();

  // Wait for ws
  for (let i = 0; i < 20 && !wsReady; i++) await sleep(500);
  if (!wsReady) { console.error('[bridge] ws never connected'); process.exit(1); }

  let lastMessageCount = 0;
  let idleTimeout: ReturnType<typeof setTimeout> | null = null;
  let currentState = 'idle';

  function setState(state: string, payload: unknown = {}) {
    if (idleTimeout) { clearTimeout(idleTimeout); idleTimeout = null; }
    currentState = state;
    if (ws && wsReady) send(ws, state, payload);
    if (state !== 'idle' && state !== 'thinking') {
      idleTimeout = setTimeout(() => {
        if (ws && wsReady) send(ws, 'idle', {});
        currentState = 'idle';
      }, 8000);
    }
  }

  console.log('[bridge] polling session:', SESSION_KEY);

  while (true) {
    try {
      if (!wsReady) { await sleep(POLL_MS); continue; }

      const data = await gwInvoke('sessions_history', {
        sessionKey: SESSION_KEY,
        limit: 30,
        includeTools: true,
      }) as { messages?: Message[] } | null;

      const messages: Message[] = data?.messages ?? [];
      if (messages.length === 0) { await sleep(POLL_MS); continue; }

      if (messages.length === lastMessageCount) {
        await sleep(POLL_MS);
        continue;
      }

      // Process new messages
      const newMessages = lastMessageCount === 0
        ? [] // skip on first load to avoid spamming old history
        : messages.slice(lastMessageCount);

      lastMessageCount = messages.length;

      for (const msg of newMessages) {
        const content = msg.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          if (!block || typeof block !== 'object') continue;

          const type = block.type;

          if (type === 'thinking' || type === 'text') {
            // Assistant is writing/thinking — speaking state
            if (msg.role === 'assistant') {
              const text = truncate(block.text ?? '', MAX_OUTPUT);
              setState('speaking', { text });
            }
          }

          if (type === 'tool_use' || type === 'toolCall') {
            const toolName = block.name ?? block.tool ?? 'tool';
            const input = truncate(getToolInput(block), MAX_INPUT);
            setState('executing', { command: toolName, input });
          }

          if (type === 'tool_result' || type === 'toolResult') {
            const output = truncate(getToolOutput(block), MAX_OUTPUT);
            setState('tool_result', { output });
          }
        }

        // User message = model is about to think
        if (msg.role === 'user') {
          setState('thinking', {});
        }
      }

    } catch (e) {
      // swallow poll errors
    }

    await sleep(POLL_MS);
  }
}

main().catch(e => {
  console.error('[bridge] fatal:', e);
  process.exit(1);
});
