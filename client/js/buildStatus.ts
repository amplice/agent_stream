// Feature 4: Build status card

export class BuildStatus {
  private el: HTMLElement;
  private building = false;
  private buildStart = 0;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'build-status';
    document.body.appendChild(this.el);
  }

  startBuild(tool: string, input: string): void {
    this.building = true;
    this.buildStart = performance.now();
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    this.el.className = 'active';
    this.el.innerHTML = `<span class="bs-spinner"></span> building...`;
  }

  endBuild(success: boolean, output: string): void {
    if (!this.building) return;
    this.building = false;
    const elapsed = ((performance.now() - this.buildStart) / 1000).toFixed(1);

    if (success) {
      this.el.className = 'success';
      this.el.innerHTML = `<span class="bs-icon">✓</span> build ok <span class="bs-time">${elapsed}s</span>`;
    } else {
      const firstError = this.extractError(output);
      this.el.className = 'failure';
      this.el.innerHTML = `<span class="bs-icon">✗</span> build failed <span class="bs-error">${firstError}</span>`;
    }

    this.hideTimer = setTimeout(() => this.hide(), 4000);
  }

  get isBuilding(): boolean { return this.building; }

  hide(): void {
    this.el.className = '';
    this.building = false;
  }

  private extractError(output: string): string {
    const lines = output.split('\n');
    const errLine = lines.find(l => /error|Error|ERR/i.test(l));
    const text = errLine || lines[0] || '';
    return text.length > 60 ? text.slice(0, 60) + '…' : text;
  }
}
