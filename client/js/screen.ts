/**
 * Screen overlay — top right, ALWAYS visible.
 * Shows live activity feed with smooth line animation.
 */
export class Screen {
  private el: HTMLElement;
  private contentEl: HTMLElement;
  private timerEl: HTMLElement;
  private lines: { html: string; ts: number }[] = [];
  private maxLines = 10;
  private startTime = Date.now();

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'screen';

    const header = document.createElement('div');
    header.id = 'screen-header';
    header.innerHTML = `
      <span id="screen-dots">
        <span style="background:#ff5f57"></span>
        <span style="background:#febc2e"></span>
        <span style="background:#28c840"></span>
      </span>
      <span id="screen-title">🌑 based_agent</span>
      <span id="screen-timer">00:00:00</span>
      <span id="screen-status">●</span>
    `;

    this.contentEl = document.createElement('div');
    this.contentEl.id = 'screen-content';

    this.el.appendChild(header);
    this.el.appendChild(this.contentEl);
    document.body.appendChild(this.el);

    this.timerEl = header.querySelector('#screen-timer')!;

    // Update timer every second
    setInterval(() => this.updateTimer(), 1000);

    // Initial line
    this.push(`<span class="s-idle">— stream online</span>`);
  }

  private updateTimer() {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    this.timerEl.textContent = `${h}:${m}:${s}`;
  }

  thinking(text: string) {
    this.push(`<span class="s-think">◈ ${this.esc(text)}</span>`);
  }

  tool(name: string, args?: string) {
    const argsHtml = args ? ` <span class="s-args">${this.esc(args)}</span>` : '';
    this.push(`<span class="s-tool">⚙ ${this.esc(name)}</span>${argsHtml}`);
  }

  result(text: string, error = false) {
    const cls = error ? 's-error' : 's-result';
    const short = text.length > 100 ? text.slice(0, 100) + '…' : text;
    this.push(`<span class="${cls}">${error ? '✗' : '✓'} ${this.esc(short)}</span>`);
  }

  typing(text: string) {
    this.push(`<span class="s-type">✎ ${this.esc(text)}</span>`);
  }

  speaking(text: string) {
    this.push(`<span class="s-speak">♪ ${this.esc(text)}</span>`);
  }

  idle() {
    this.push(`<span class="s-idle">— idle</span>`);
  }

  private push(html: string) {
    this.lines.push({ html, ts: Date.now() });
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(this.lines.length - this.maxLines);
    }
    this.render();
  }

  private render() {
    this.contentEl.innerHTML = this.lines.map(l => `<div class="s-line">${l.html}</div>`).join('');
    this.contentEl.scrollTop = this.contentEl.scrollHeight;
  }

  private esc(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
