/**
 * Terminal panel — bottom right, ALWAYS visible.
 * Shows commands, output, and auto-generates filler when idle.
 */
export class Terminal {
  private el: HTMLElement;
  private contentEl: HTMLElement;
  private uptimeEl: HTMLElement;
  private lines: string[] = [];
  private maxLines = 18;
  private cursor = true;
  private cursorInterval: ReturnType<typeof setInterval>;
  private fillerInterval: ReturnType<typeof setInterval>;
  private startTime = Date.now();
  private lastRealLine = Date.now();
  private lastCommandTime = 0;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'terminal';

    const header = document.createElement('div');
    header.id = 'terminal-header';
    header.innerHTML = `
      <span id="terminal-title">▸ nox-term</span>
      <span id="terminal-uptime">up 0m</span>
    `;

    this.contentEl = document.createElement('div');
    this.contentEl.id = 'terminal-content';

    this.el.appendChild(header);
    this.el.appendChild(this.contentEl);
    document.body.appendChild(this.el);

    this.uptimeEl = header.querySelector('#terminal-uptime')!;

    // Blinking cursor
    this.cursorInterval = setInterval(() => {
      this.cursor = !this.cursor;
      this.render();
    }, 530);

    // Uptime counter
    setInterval(() => this.updateUptime(), 10000);

    // Auto-generate filler when idle
    this.fillerInterval = setInterval(() => this.maybeGenerateFiller(), 4000);

    // Initial lines
    this.addRaw('<span style="color:#6633cc">nox-stream</span> initialized');
    this.addRaw('<span style="color:#555">pid 1 | mem 42MB | threads 4</span>');
  }

  private updateUptime() {
    const mins = Math.floor((Date.now() - this.startTime) / 60000);
    if (mins < 60) {
      this.uptimeEl.textContent = `up ${mins}m`;
    } else {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      this.uptimeEl.textContent = `up ${h}h${m}m`;
    }
  }

  private maybeGenerateFiller() {
    // Only generate filler if no real content in last 8s
    if (Date.now() - this.lastRealLine < 8000) return;

    const now = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const fillers = [
      () => `<span style="color:#333">[${now}] waiting for input</span>`,
      () => `<span style="color:#333">[${now}] idle — heartbeat ok</span>`,
      () => `<span style="color:#333">[${now}] mem ${(38 + Math.random() * 25).toFixed(0)}MB | uptime ${this.uptimeEl.textContent}</span>`,
    ];

    const filler = fillers[Math.floor(Math.random() * fillers.length)]();
    this.addRaw(filler);
  }

  show() { /* no-op, always visible */ }
  hide() { /* no-op, always visible */ }

  command(cmd: string) {
    this.lastRealLine = Date.now();
    this.lastCommandTime = Date.now();
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    this.addRaw(`<span style="color:#444">[${time}]</span> <span style="color:#6688ff">❯</span> ${this.escape(cmd)}`);
  }

  output(text: string, color = '#88ffcc') {
    this.lastRealLine = Date.now();
    const elapsed = this.lastCommandTime ? ` <span style="color:#333">${Date.now() - this.lastCommandTime}ms</span>` : '';
    const firstLine = text.split('\n').find(l => l.trim()) ?? '';
    if (firstLine) this.addRaw(`<span style="color:${color}">  ${this.escape(firstLine)}</span>${elapsed}`);
    this.lastCommandTime = 0;
  }

  thinking(text: string) {
    this.lastRealLine = Date.now();
    this.addRaw(`<span style="color:#9955ff">~ ${this.escape(text)}</span>`);
  }

  clear() {
    this.lines = [];
    this.render();
  }

  private addRaw(html: string) {
    this.lines.push(html);
    this.trim();
    this.render();
  }

  private trim() {
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(this.lines.length - this.maxLines);
    }
  }

  private escape(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private render() {
    const cursorHtml = this.cursor
      ? '<span style="color:#00ccff;opacity:0.8">▋</span>'
      : '<span style="opacity:0">▋</span>';
    this.contentEl.innerHTML = this.lines.join('<br>') + '<br>' + cursorHtml;
    this.contentEl.scrollTop = this.contentEl.scrollHeight;
  }
}
