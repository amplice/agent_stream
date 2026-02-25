// Feature 2: Project context widget — shows repo/branch/file/commit at top center

export class ProjectContext {
  private el: HTMLElement;
  private repoEl: HTMLElement;
  private fileEl: HTMLElement;
  private commitEl: HTMLElement;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'project-context';
    this.el.innerHTML = `<span class="pc-repo"></span><span class="pc-sep">·</span><span class="pc-file"></span><span class="pc-sep">·</span><span class="pc-commit"></span>`;
    document.body.appendChild(this.el);
    this.repoEl = this.el.querySelector('.pc-repo')!;
    this.fileEl = this.el.querySelector('.pc-file')!;
    this.commitEl = this.el.querySelector('.pc-commit')!;
  }

  update(data: { repo?: string; branch?: string; file?: string; commit?: string }): void {
    const repoBranch = [data.repo, data.branch].filter(Boolean).join('/');
    this.repoEl.textContent = repoBranch || '';
    this.fileEl.textContent = data.file ? data.file.split('/').pop() || data.file : '';
    this.commitEl.textContent = data.commit ? (data.commit.length > 40 ? data.commit.slice(0, 40) + '…' : data.commit) : '';

    const hasContent = repoBranch || data.file || data.commit;
    this.el.classList.toggle('visible', !!hasContent);
  }
}
