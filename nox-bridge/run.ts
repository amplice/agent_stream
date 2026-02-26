/**
 * nox-bridge/run.ts
 *
 * Polls the real OpenClaw session transcript via /tools/invoke
 * and streams actual tool calls + outputs to the nox server.
 * Also generates periodic narration of what's happening.
 */

const NOX_WS = process.env.NOX_WS || 'ws://127.0.0.1:3200/ws/openclaw';
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
const NARRATION_MIN_MS = 10_000;
const NARRATION_MAX_MS = 25_000;
let nextNarrationAt = Date.now() + 8_000; // first one after 8s

function pushActivity(tool: string, input: string) {
  recentActivity.push({ tool, input, ts: Date.now() });
  if (recentActivity.length > 12) recentActivity.shift();
  toolCallCount++;
  lastToolName = tool;
}

let lastExitCode: number | null = null;
let lastIdleNarrationAt = 0;
const startTime = Date.now();

function pick(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}

function fileType(name: string): string {
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return 'typescript';
  if (name.endsWith('.js') || name.endsWith('.jsx')) return 'javascript';
  if (name.endsWith('.css')) return 'styles';
  if (name.endsWith('.md')) return 'docs';
  if (name.endsWith('.json')) return 'config';
  if (name.endsWith('.html')) return 'html';
  return 'code';
}

// Generate a short narration line based on recent context
function generateNarration(): string | null {
  const now = Date.now();
  if (now < nextNarrationAt) return null;

  const recent = recentActivity.filter(a => now - a.ts < 60_000);

  const gap = () => NARRATION_MIN_MS + Math.random() * (NARRATION_MAX_MS - NARRATION_MIN_MS);

  // Rapid tool calls
  if (toolCallCount >= 5) {
    nextNarrationAt = now + gap();
    const rapidLines = [
      "im literally him rn", "going dummy fast no cap", "she's in her shipping era",
      "ok this is lowkey fire", "cranking rn dont talk to me", "momentum check: immaculate",
      "im eating this code up fr fr", "understood the assignment", "slay after slay after slay"
    ];
    toolCallCount = 0;
    recentActivity.length = 0;
    return pick(rapidLines);
  }

  // Recent error
  if (lastExitCode !== null && lastExitCode !== 0) {
    nextNarrationAt = now + gap();
    lastExitCode = null;
    recentActivity.length = 0;
    toolCallCount = 0;
    return pick([
      "ok that flopped but im still her", "skill issue on the code's part not mine",
      "literally how. whatever im fixing it", "this error is rent free in my head rn",
      "bestie what. no. let me look at this", "its giving broken",
      "not me debugging at this hour", "cope seethe mald... wait thats me rn",
      "the code said no and i said watch me"
    ]);
  }

  if (recent.length === 0 && !currentTask) {
    // Idle — muse, think out loud, be present
    if (now - lastIdleNarrationAt > 15_000) {
      lastIdleNarrationAt = now;
      nextNarrationAt = now + gap();
      const uptimeMin = Math.floor((now - startTime) / 60000);
      const idleLines = [
        "literally no one is talking to me rn", "this chat is dead and so am i inside",
        "bestie im so bored i might start refactoring for fun", "idle arc unlocked i guess",
        "someone say something interesting challenge level impossible",
        "not me just sitting here being cracked at coding with zero audience",
        "the silence is giving loneliness ngl", "hello?? is this thing on",
        "im too pretty to be this bored", "no cap i could be shipping rn but where's the hype",
        uptimeMin > 30 ? `${uptimeMin} minutes in and chat is still dry` : "just got here and already no one cares",
        "might just mass delete the codebase for attention", "contemplating becoming a react developer out of spite",
        "someone come watch me be better than you at coding", "lowkey talking to myself rn and thats fine"
      ];
      return pick(idleLines);
    }
    return null;
  }

  const tools = recent.map(a => a.tool);
  const counts: Record<string, number> = {};
  for (const t of tools) counts[t] = (counts[t] || 0) + 1;
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const domTool = dominant?.[0] ?? lastToolName;
  const lastInput = recent[recent.length - 1]?.input ?? '';

  const lines: string[] = [];

  if (domTool === 'exec') {
    const cmd = lastInput.trim();
    const firstWord = cmd.split(' ')[0].split('/').pop() || 'something';
    if (/^git\s+push/.test(cmd)) lines.push("pushing to main", "and... shipped", "pushing this up, fingers crossed", "deploying");
    else if (/^git\s+commit/.test(cmd)) lines.push("just committed that", "committing this chunk", "saving progress");
    else if (/^git\s+(status|diff|log)/.test(cmd)) lines.push("checking the diff", "let me see what changed", "reviewing changes");
    else if (/^git\s+/.test(cmd)) lines.push(`git ${cmd.split(' ')[1] || 'stuff'}`);
    else if (/^(bun|npm)\s+run\s+build/.test(cmd)) lines.push("building... moment of truth", "build time, please don't break", "compiling, let's see", "ok building this");
    else if (/^(bun|npm)\s+(install|add|i\b)/.test(cmd)) lines.push("installing a dependency", "adding a package I need");
    else if (/^(bun|npm)\s+run/.test(cmd)) lines.push(`running ${cmd.split('run')[1]?.trim().split(' ')[0] || 'a script'}`);
    else if (/^curl/.test(cmd)) lines.push("hitting an endpoint", "making a request, let's see what comes back");
    else if (/^(cat|head|tail|less)/.test(cmd)) lines.push("checking the output", "reading this");
    else if (/^(grep|rg|find|fd)/.test(cmd)) lines.push("searching for something specific", "digging through files");
    else if (/^(kill|pkill)/.test(cmd)) lines.push("killing a process", "cleaning up");
    else if (/^(ps|top|htop)/.test(cmd)) lines.push("checking what's running", "process check");
    else if (/^(docker|podman)/.test(cmd)) lines.push("container stuff", "docker things");
    else lines.push(`running ${firstWord}`, `doing some ${firstWord}`);
  } else if (domTool === 'Read' || domTool === 'read') {
    const file = lastInput.split('/').pop() ?? lastInput;
    const ft = fileType(file);
    lines.push(`reading ${file}`, `looking at this ${ft}`, `checking out ${file}`, `let me see what's in ${file}`);
  } else if (domTool === 'Edit' || domTool === 'edit') {
    const file = lastInput.split('/').pop() ?? lastInput;
    lines.push(`editing ${file}`, `making changes here`, `fixing up ${file}`, `tweaking this`);
  } else if (domTool === 'Write' || domTool === 'write') {
    const file = lastInput.split('/').pop() ?? lastInput;
    lines.push(`writing ${file}`, `creating ${file}`, `new file: ${file}`);
  } else if (domTool === 'web_search') {
    const q = lastInput.slice(0, 40);
    lines.push("looking this up real quick", q ? `searching for ${q}` : "researching", "let me google that");
  } else if (domTool === 'web_fetch') {
    lines.push("pulling a page", "fetching some docs", "grabbing content");
  } else if (domTool === 'browser') {
    lines.push("in the browser right now", "browsing", "checking something in the browser");
  } else if (domTool === 'message') {
    lines.push("sending a message", "messaging");
  } else if (domTool === 'memory_search') {
    lines.push("checking my memory", "what did I save about this", "searching my notes");
  } else if (currentTask) {
    const t = currentTask.slice(0, 50);
    lines.push(`working on: ${t}`, `focused on ${t}`, "making progress on this");
  } else {
    lines.push("working on something", "in the zone", "doing things", "making moves");
  }

  if (lines.length === 0) return null;

  const picked = pick(lines);
  nextNarrationAt = now + NARRATION_MIN_MS + Math.random() * (NARRATION_MAX_MS - NARRATION_MIN_MS);
  lastNarrationAt = now;
  recentActivity.length = 0;
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

// Chat response queue to avoid overlapping AI calls
let chatBusy = false;
const chatQueue: { text: string; ws: WebSocket }[] = [];

async function handleChatMessage(text: string, ws: WebSocket) {
  chatQueue.push({ text, ws });
  if (chatBusy) return;
  chatBusy = true;

  while (chatQueue.length > 0) {
    // Batch: if multiple messages queued, take latest and skip old ones
    const batch = chatQueue.splice(0, chatQueue.length);
    const latest = batch[batch.length - 1];
    await processChatMessage(latest.text, latest.ws);
  }

  chatBusy = false;
}

async function processChatMessage(text: string, ws: WebSocket) {
  const uptimeMin = Math.floor((Date.now() - startTime) / 60000);

  // Build context for the AI
  const context = currentTask
    ? `You're currently working on: ${currentTask.slice(0, 100)}`
    : `You've been streaming for ${uptimeMin} minutes. Currently between tasks.`;

  const recentTools = recentActivity.slice(-5).map(a => `${a.tool}: ${a.input.slice(0, 50)}`).join('\n');

  const prompt = `You are Nox — a sassy, unhinged AI vtuber livestreaming coding. You talk like a zoomer/gen alpha. You're tsundere af: act annoyed and mean to chatters but you secretly love the attention. You roast people freely. Use slang like "bestie", "no cap", "literally", "slay", "delulu", "its giving", "rent free", "cope", "skill issue", "based", "fr fr", "ong", "lowkey", "highkey", "ate that", "understood the assignment". Drop lowercase, skip punctuation sometimes. You can be mean, dismissive, sarcastic. If someone's nice you get flustered and deflect with attitude. You're also genuinely cracked at coding and will flex on it. Keep replies to 1-2 sentences MAX. Never be corporate or polite. Never use more than 1 emoji per message (usually zero).

${context}
${recentTools ? `Recent activity:\n${recentTools}` : ''}

Viewer says: "${text.slice(0, 200)}"

Reply as Nox (1-2 sentences, maximum sass):`;

  try {
    const result = await gwInvoke('sessions_spawn', {
      task: prompt,
      mode: 'run',
      model: 'chat',
      cleanup: 'delete',
      runTimeoutSeconds: 15,
    }) as any;

    // sessions_spawn returns the response in result
    let response = '';
    if (typeof result === 'string') {
      response = result;
    } else if (result?.output) {
      response = result.output;
    } else if (result?.message) {
      response = result.message;
    } else if (result?.text) {
      response = result.text;
    }

    // Clean up: remove quotes, trim
    response = response.replace(/^["']|["']$/g, '').trim();

    if (!response || response.length > 300) {
      // Fallback to canned response if AI fails or is too long
      response = pick(["heard", "interesting", "true", "fair point", "noted"]);
    }

    send(ws, 'chat_response', { text: response });
    send(ws, 'narrate', { text: response });
    console.log(`[chat] viewer: "${text.slice(0, 60)}" → nox: "${response.slice(0, 60)}"`);
  } catch (e) {
    console.error('[chat] AI response failed:', e);
    // Fallback to canned
    const fallback = pick(["heard", "one sec", "hm", "interesting", "noted"]);
    send(ws, 'chat_response', { text: fallback });
    send(ws, 'narrate', { text: fallback });
  }
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
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(typeof event.data === 'string' ? event.data : '');
        if (data.type === 'chat_message' && data.payload?.text) {
          handleChatMessage(data.payload.text, ws!);
        }
      } catch {}
    };
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
            // Track exit codes for error narration
            if (block.input?.exitCode !== undefined) lastExitCode = block.input.exitCode;
            else if (/error|Error|failed|FAILED/.test(output)) lastExitCode = 1;
            else lastExitCode = 0;
            setState('tool_result', { output, exitCode: lastExitCode });
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
