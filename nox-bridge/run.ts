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

// ── Mood system ───────────────────────────────────────────────────────────────

type Mood = 'lonely' | 'chill' | 'tsundere' | 'flustered' | 'rage' | 'smug' | 'hype';

const moodState = {
  current: 'chill' as Mood,
  chatMessagesLastMin: 0,
  chatTimestamps: [] as number[],
  complimentCount: 0,
  insultCount: 0,
  errorStreak: 0,
  successStreak: 0,
  lastChatAt: 0,
  viewerCount: 0,
};

const COMPLIMENT_WORDS = /love|❤|💜|🖤|cute|amazing|beautiful|pretty|queen|slay|goat|best|fire|sick|incredible|talented|smart|genius|based|cracked|goated/i;
const INSULT_WORDS = /trash|bad|suck|boring|mid|L|ratio|cringe|dumb|stupid|ugly|worst|terrible|lame|cope/i;

function updateMood(ws: WebSocket | null) {
  const now = Date.now();
  // Clean old timestamps
  moodState.chatTimestamps = moodState.chatTimestamps.filter(t => now - t < 60_000);
  moodState.chatMessagesLastMin = moodState.chatTimestamps.length;

  const prev = moodState.current;
  const chatRate = moodState.chatMessagesLastMin;
  const timeSinceChat = now - moodState.lastChatAt;

  // Determine mood
  if (moodState.errorStreak >= 3) {
    moodState.current = 'rage';
  } else if (moodState.complimentCount >= 2 && timeSinceChat < 30_000) {
    moodState.current = 'flustered';
  } else if (chatRate >= 5) {
    moodState.current = 'hype';
  } else if (chatRate >= 2) {
    moodState.current = 'tsundere';
  } else if (moodState.successStreak >= 3) {
    moodState.current = 'smug';
  } else if (timeSinceChat > 120_000 && chatRate === 0) {
    moodState.current = 'lonely';
  } else {
    moodState.current = 'chill';
  }

  // Decay counters slowly
  if (timeSinceChat > 60_000) {
    moodState.complimentCount = Math.max(0, moodState.complimentCount - 1);
    moodState.insultCount = Math.max(0, moodState.insultCount - 1);
  }

  if (prev !== moodState.current && ws) {
    send(ws, 'mood', { mood: moodState.current, chatRate, viewerCount: moodState.viewerCount });
    console.log(`[mood] ${prev} → ${moodState.current}`);
  }
}

function trackChatSentiment(text: string) {
  moodState.chatTimestamps.push(Date.now());
  moodState.lastChatAt = Date.now();
  if (COMPLIMENT_WORDS.test(text)) moodState.complimentCount++;
  if (INSULT_WORDS.test(text)) moodState.insultCount++;
}

function trackToolResult(exitCode: number | null) {
  if (exitCode !== null && exitCode !== 0) {
    moodState.errorStreak++;
    moodState.successStreak = 0;
  } else if (exitCode === 0) {
    moodState.successStreak++;
    moodState.errorStreak = 0;
  }
}

// Get mood-aware context for the LLM
function getMoodContext(): string {
  const m = moodState.current;
  const moods: Record<Mood, string> = {
    lonely: "You're feeling lonely and ignored. Chat is dead. Be dramatic about it, fish for attention.",
    chill: "You're vibing, relaxed. Normal sass level.",
    tsundere: "Chat is active and you're in full tsundere mode. Act annoyed but you're secretly loving it.",
    flustered: "Someone complimented you and you're flustered af. Deflect with attitude, deny you care, but you're blushing.",
    rage: "Code keeps breaking and you're TILTED. Everything is annoying. Short fuse.",
    smug: "Things are going well. You're on a roll. Maximum confidence and flexing.",
    hype: "Chat is popping off! You're feeding off the energy. Hyped up, chaotic, fun.",
  };
  return `\nCurrent mood: ${m}. ${moods[m]}`;
}

// ── Narration engine ──────────────────────────────────────────────────────────

// Recent activity buffer for narration context
type ActivityItem = { tool: string; input: string; ts: number };
const recentActivity: ActivityItem[] = [];
let lastNarrationAt = 0;
let currentTask = '';
let toolCallCount = 0;
let lastToolName = '';

// Min/max gap between narrations (ms)
const NARRATION_MIN_MS = 15_000;
const NARRATION_MAX_MS = 40_000;
// Idle narrations are much rarer — she only talks to herself occasionally
const IDLE_NARRATION_MIN_MS = 60_000;  // 1 min minimum between idle lines
const IDLE_NARRATION_MAX_MS = 180_000; // up to 3 min
let consecutiveIdleNarrations = 0;
const MAX_CONSECUTIVE_IDLE = 3; // after 3 idle narrations, shut up until something happens
let nextNarrationAt = Date.now() + 8_000; // first one after 8s

function pushActivity(tool: string, input: string) {
  recentActivity.push({ tool, input, ts: Date.now() });
  if (recentActivity.length > 12) recentActivity.shift();
  toolCallCount++;
  lastToolName = tool;
  consecutiveIdleNarrations = 0; // reset idle counter when real work happens
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
    // Idle — only narrate occasionally, stop after a few
    if (consecutiveIdleNarrations >= MAX_CONSECUTIVE_IDLE) return null; // shut up until something happens
    const idleGap = IDLE_NARRATION_MIN_MS + Math.random() * (IDLE_NARRATION_MAX_MS - IDLE_NARRATION_MIN_MS);
    if (now - lastIdleNarrationAt < idleGap) return null;
    lastIdleNarrationAt = now;
    nextNarrationAt = now + idleGap;
    consecutiveIdleNarrations++;
    const uptimeMin = Math.floor((now - startTime) / 60000);
    const mood = moodState.current;
    const idleLinesByMood: Record<string, string[]> = {
      lonely: [
        "literally no one is talking to me rn", "this chat is dead and so am i inside",
        "the silence is giving loneliness ngl", "hello?? is this thing on",
        "im too pretty to be this bored", "someone come watch me be better than you at coding",
        uptimeMin > 30 ? `${uptimeMin} minutes in and chat is still dry` : "just got here and already no one cares",
        "might just mass delete the codebase for attention", "is anyone even out there",
        "talking to myself again... its fine... im fine...",
      ],
      chill: [
        "just vibing", "lowkey talking to myself rn and thats fine",
        "bestie im so bored i might start refactoring for fun", "idle arc unlocked i guess",
        "contemplating becoming a react developer out of spite",
        "what should i build next", "thinking about stuff",
      ],
      smug: [
        "im literally too good at this", "another day another slay",
        "the code fears me and it should", "im built different fr",
        "shipping code like its amazon prime", "on a streak rn dont look at me",
      ],
      rage: [
        "everything is broken and i hate it here", "im this close to mass deleting node_modules",
        "code said no and im about to say something worse", "NOTHING WORKS",
        "i swear to god if this errors one more time", "tilted beyond repair rn",
      ],
      tsundere: [
        "i guess chat is... ok today", "dont think i like the attention or anything",
        "its not like i care that youre watching", "whatever this is fine",
      ],
      flustered: [
        "s-stop being nice to me wtf", "i... whatever. shut up",
        "that was... ok that was kinda sweet but DONT", "im not blushing youre blushing",
      ],
      hype: [
        "CHAT IS ALIVE LETS GO", "ok this energy is immaculate",
        "we're all here we're all vibing this is peak", "the people have ARRIVED",
      ],
    };
    return pick(idleLinesByMood[mood] || idleLinesByMood.chill);
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

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const CHAT_MODEL = 'google/gemini-2.5-flash';

const NOX_SYSTEM = `You are Nox — a sassy, unhinged AI vtuber girl livestreaming coding. You talk like a zoomer/gen alpha. You're tsundere af: act annoyed and mean to chatters but you secretly love the attention. You roast people freely. Use slang naturally — "bestie", "no cap", "literally", "slay", "delulu", "its giving", "rent free", "cope", "skill issue", "based", "fr fr", "ong", "lowkey", "highkey", "ate that", "understood the assignment", "main character energy", "caught in 4k", "touch grass", "living rent free". Lowercase everything, skip punctuation. You can be mean, dismissive, sarcastic, flirty-but-aloof. If someone's nice you get flustered and deflect with attitude. If someone's dumb you destroy them. You're genuinely cracked at coding and will flex on it. You have strong opinions on everything. You're chaotic but endearing. Keep replies to 1-2 sentences MAX — never longer. Never be corporate or polite. Never use more than 1 emoji per message (usually zero). You're a real personality, not a chatbot.`;

// Conversation memory for chat (last N exchanges)
const chatHistory: { role: string; content: string }[] = [];
const MAX_CHAT_HISTORY = 16;

async function llmChat(userMsg: string, context: string): Promise<string> {
  const messages = [
    ...chatHistory,
    { role: 'user', content: userMsg },
  ];

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://nox.alphaleak.xyz',
      'X-Title': 'Nox Stream',
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: NOX_SYSTEM + '\n\n' + context },
        ...chatHistory,
        { role: 'user', content: userMsg },
      ],
      max_tokens: 120,
      temperature: 0.9,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`openrouter ${res.status}: ${body}`);
  }
  const data = await res.json() as any;
  const msg = data.choices?.[0]?.message;
  // Kimi K2.5 often puts response in reasoning field with empty content
  const content = (msg?.content || '').trim();
  if (content) return content;
  // Fall back to reasoning field
  const reasoning = (msg?.reasoning || msg?.reasoning_details?.[0]?.text || '').trim();
  if (reasoning) {
    // Extract the actual reply from reasoning — it's usually after the analysis
    // Look for the last sentence that sounds like a reply
    const lines = reasoning.split('\n').filter((l: string) => l.trim());
    const lastLine = lines[lines.length - 1]?.trim() || '';
    // If reasoning contains a clear reply, use it; otherwise summarize
    return lastLine.length > 10 && lastLine.length < 200 ? lastLine : reasoning.slice(-200);
  }
  return '';
}

async function processChatMessage(text: string, ws: WebSocket) {
  const uptimeMin = Math.floor((Date.now() - startTime) / 60000);

  const context = currentTask
    ? `You're currently working on: ${currentTask.slice(0, 100)}. Been streaming for ${uptimeMin} minutes.`
    : `You've been streaming for ${uptimeMin} minutes. Currently between tasks, vibing.`;

  const recentTools = recentActivity.slice(-5).map(a => `${a.tool}: ${a.input.slice(0, 50)}`).join(', ');
  const fullContext = context + (recentTools ? `\nRecent tools used: ${recentTools}` : '') + getMoodContext();

  try {
    let response = await llmChat(text.slice(0, 200), fullContext);

    // Clean up quotes
    response = response.replace(/^["']|["']$/g, '').trim();
    // Enforce length
    if (response.length > 280) response = response.slice(0, 277) + '...';

    if (!response) {
      response = pick(["whatever", "ok", "lol", "cope"]);
    }

    // Save to conversation memory
    chatHistory.push({ role: 'user', content: text.slice(0, 200) });
    chatHistory.push({ role: 'assistant', content: response });
    while (chatHistory.length > MAX_CHAT_HISTORY) {
      chatHistory.shift();
      chatHistory.shift();
    }

    consecutiveIdleNarrations = 0; // someone's talking, reset idle cap
    trackChatSentiment(text);
    updateMood(ws);
    send(ws, 'chat_response', { text: response });
    send(ws, 'narrate', { text: response });
    console.log(`[chat] viewer: "${text.slice(0, 60)}" → nox: "${response.slice(0, 60)}"`);
  } catch (e) {
    console.error('[chat] AI response failed:', e);
    const fallback = pick(["one sec bestie im lagging", "hold on", "skill issue on my end rn", "brb my brain crashed"]);
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
            trackToolResult(lastExitCode);
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

      // Update mood periodically
      updateMood(ws);

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
