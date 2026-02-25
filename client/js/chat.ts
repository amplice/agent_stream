// Feature 5: Viewer chat widget

import type { WSClient } from './wsClient';

interface ChatMessage {
  sender: string;
  text: string;
}

export class Chat {
  private el: HTMLElement;
  private messagesEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private viewerCountEl: HTMLElement;
  private ws: WSClient;
  private messages: ChatMessage[] = [];
  private visible = false;
  private viewerCount = Math.floor(12 + Math.random() * 8);

  constructor(ws: WSClient) {
    this.ws = ws;

    this.el = document.createElement('div');
    this.el.id = 'chat-widget';
    this.el.innerHTML = `
      <div class="chat-header">
        <span class="chat-title">CHAT</span>
        <span class="chat-viewers" id="chat-viewers">${this.viewerCount} watching</span>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-row">
        <input type="text" class="chat-input" id="chat-input" placeholder="say something..." maxlength="200" />
        <button class="chat-send" id="chat-send">→</button>
      </div>
    `;
    document.body.appendChild(this.el);

    this.messagesEl = this.el.querySelector('#chat-messages')!;
    this.inputEl = this.el.querySelector('#chat-input')!;
    this.viewerCountEl = this.el.querySelector('#chat-viewers')!;

    const sendBtn = this.el.querySelector('#chat-send')!;
    sendBtn.addEventListener('click', () => this.sendMessage());
    this.inputEl.addEventListener('keydown', (e) => {
      e.stopPropagation(); // prevent C key toggling chat while typing
      if (e.key === 'Enter') this.sendMessage();
    });

    // Toggle with C key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'c' || e.key === 'C') {
        if (document.activeElement === this.inputEl) return;
        this.toggle();
      }
    });

    // Drift viewer count
    setInterval(() => {
      this.viewerCount += Math.floor(Math.random() * 3) - 1;
      if (this.viewerCount < 8) this.viewerCount = 8;
      if (this.viewerCount > 35) this.viewerCount = 35;
      this.viewerCountEl.textContent = `${this.viewerCount} watching`;
    }, 15000);

    // Listen for chat messages from server
    ws.on('chat_message', (payload: any) => {
      this.addMessage(payload.sender || 'viewer', payload.text || '');
    });
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.classList.toggle('visible', this.visible);
    if (this.visible) this.inputEl.focus();
  }

  addMessage(sender: string, text: string): void {
    this.messages.push({ sender, text });
    if (this.messages.length > 5) this.messages.shift();
    this.render();
  }

  private render(): void {
    this.messagesEl.innerHTML = this.messages.map(m => {
      const cls = m.sender === 'nox' ? 'chat-msg-nox' : 'chat-msg-viewer';
      const label = m.sender === 'nox' ? 'nox' : m.sender;
      return `<div class="chat-msg ${cls}"><span class="chat-sender">${label}:</span> ${this.escapeHtml(m.text)}</div>`;
    }).join('');
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private sendMessage(): void {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.ws.emit('chat_message', { text });
    this.addMessage('you', text);
    this.inputEl.value = '';
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
