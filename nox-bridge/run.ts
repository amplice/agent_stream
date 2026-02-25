/**
 * nox-bridge/run.ts
 *
 * Polls the real OpenClaw session transcript via /tools/invoke
 * and streams actual tool calls + outputs to the nox server.
 * Also generates periodic narration of what's happening.
 */

const NOX_WS = 'wss://nox-stream-production.up.railway.app/ws/openclaw';
const GATEWAY = 'http://127.0.0.1:18789';
const GW_TOKEN = '377b9799e11a9dfa71e24b10f680b270332d9eeb39da9e36';
const SESSION_KEY = 'agent:main:main';
const POLL_MS = 600;

const MAX_INPUT = 120;
const MAX_OUTPUT = 200;

// ── Narration engine ──────────────────────────────────────────────────────────

// Recent activity buffer for narration context
type ActivityItem = { tool: string; input: string; ts: number };
const recentActivity: ActivityItem[] = [];
let lastNarrationAt = 0;
let currentTask = '';
let toolCallCount = 0;
let lastToolName = '';

// Min/max gap between narrations (ms)
const NARRATION_MIN_MS = 25_000;
const NARRATION_MAX_MS = 55_000;
let nextNarrationAt = Date.now() + 15_000; // first one after 15s

function pushActivity(tool: string, input: string) {
  recentActivity.push({ tool, input, ts: Date.now() });
  if (recentActivity.length > 12) recentActivity.shift();
  toolCallCount++;
  lastToolName = tool;
}

// Generate a short narration line based on recent context
function generateNarration(): string | null {
  const now = Date.now();
  if (now < nextNarrationAt) return null;

  const recent = recentActivity.filter(a => now - a.ts < 60_000);
  if (recent.length === 0 && !currentTask) return null;

  // Count tool types
  const tools = recent.map(a => a.tool);
  const counts: Record<string, number> = {};
  for (const t of tools) counts[t] = (counts[t] || 0) + 1;

  // Find dominant activity
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const domTool = dominant?.[0] ?? lastToolName;
  const lastInput = recent[recent.length - 1]?.input ?? '';

  // Build narration based on context
  const lines: string[] = [];

  if (domTool === 'exec') {
    const cmd = lastInput.slice(0, 60);
    lines.push(
      `Running shell commands. Last one was: ${cmd}`,
      `In the terminal right now. ${cmd ? `Running ${cmd.split(' ')[0]}.` : ''}`,
      `Executing things. ${tools.length} commands in the last minute.`,
      `Let me run this real quick.`,
    );
  } else if (domTool === 'read' || domTool === 'edit' || domTool === 'write') {
    const file = lastInput.split('/').pop() ?? lastInput;
    lines.push(
      `Working through some files. Just touched ${file}.`,
      `Reading and editing code. ${file ? `Looking at ${file}.` : ''}`,
      `Making changes. ${toolCallCount} file operations so far.`,
    );
  } else if (domTool === 'web_search' || domTool === 'web_fetch') {
    lines.push(
      `Doing some research.${lastInput ? ` Looking up: ${lastInput.slice(0, 50)}.` : ''}`,
      `Checking the web for something.`,
      `Researching. Let me find this.`,
    );
  } else if (domTool === 'browser') {
    lines.push(
      `Using the browser right now.`,
      `Navigating something in Chrome.`,
    );
  } else if (domTool === 'memory_search') {
    lines.push(
      `Checking my memory. Looking for context.`,
      `Digging through what I remember about this.`,
    );
  } else if (currentTask) {
    // Generic task-based narration
    const taskShort = currentTask.slice(0, 80);
    lines.push(
      `Working on: ${taskShort}`,
      `Someone asked me to ${taskShort.toLowerCase()}.`,
      `On it. ${taskShort}.`,
      `Thinking through this.`,
    );
  } else {
    lines.push(
      `Running some operations.`,
      `Working through a task.`,
      `On it.`,
      `Let me handle this.`,
    );
  }

  if (lines.length === 0) return null;

  const picked = lines[Math.floor(Math.random() * lines.length)];
  nextNarrationAt = now + NARRATION_MIN_MS + Math.random() * (NARRATION_MAX_MS - NARRATION_MIN_MS);
  lastNarrationAt = now;
  recentActivity.length = 0; // clear after narrating
  toolCallCount = 0;
  return picked;
}

// ─────────────────────────────────────────────────────────────────────────────

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
  if (inp.command) return inp.command;
  if (inp.file_path || inp.path) return inp.file_path ?? inp.path;
  if (inp.query) return inp.query;
  if (inp.url) return inp.url;
  const vals = Object.values(inp).filter(v => typeof v === 'string');
  if (vals.length) return vals[0] as string;
  return JSON.stringify(inp).slice(0, MAX_INPUT);
}

function getToolOutput(block: any): string {
  const content = block.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c: any) => c.type === 'text').map((c: any) => c.text ?? '').join(' ');
  }
  return '';
}

type Message = { role: string; content: any };

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
    ws.onclose = () => {
      wsReady = false;
      console.log('[bridge] ws closed, reconnecting...');
      setTimeout(connect, 2000);
    };
    ws.onerror = () => { wsReady = false; };
  }
  connect();

  for (let i = 0; i < 20 && !wsReady; i++) await sleep(500);
  if (!wsReady) { console.error('[bridge] ws never connected'); process.exit(1); }

  let lastMessageCount = 0;
  let idleTimeout: ReturnType<typeof setTimeout> | null = null;
  let currentState = 'idle';
  let narrationLock = false;

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

  async function tryNarrate() {
    if (narrationLock) return;
    const line = generateNarration();
    if (!line || !ws || !wsReady) return;
    narrationLock = true;
    try {
      // Brief pause so we don't interrupt an ongoing executing state
      await sleep(800);
      send(ws, 'narrate', { text: line });
      console.log(`[narrate] "${line}"`);
    } finally {
      narrationLock = false;
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
        // Nothing new — check if we should narrate
        await tryNarrate();
        await sleep(POLL_MS);
        continue;
      }

      const newMessages = lastMessageCount === 0
        ? []
        : messages.slice(lastMessageCount);

      lastMessageCount = messages.length;

      for (const msg of newMessages) {
        const content = msg.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const type = block.type;

          if ((type === 'thinking' || type === 'text') && msg.role === 'assistant') {
            const text = truncate(block.text ?? '', MAX_OUTPUT);
            setState('speaking', { text });
          }

          if (type === 'tool_use' || type === 'toolCall') {
            const toolName = block.name ?? block.tool ?? 'tool';
            const input = truncate(getToolInput(block), MAX_INPUT);
            setState('executing', { command: toolName, input });
            pushActivity(toolName, input);
          }

          if (type === 'tool_result' || type === 'toolResult') {
            const output = truncate(getToolOutput(block), MAX_OUTPUT);
            setState('tool_result', { output });
          }
        }

        if (msg.role === 'user') {
          let taskText = '';
          if (Array.isArray(content)) {
            taskText = content.filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join(' ').trim();
          } else if (typeof content === 'string') {
            taskText = content.trim();
          }
          currentTask = taskText;
          setState('thinking', {});
          if (taskText && ws && wsReady) send(ws, 'task', { text: taskText });
        }
      }

      // Check narration after processing new messages
      await tryNarrate();

    } catch (_e) {
      // swallow
    }

    await sleep(POLL_MS);
  }
}

main().catch(e => {
  console.error('[bridge] fatal:', e);
  process.exit(1);
});
