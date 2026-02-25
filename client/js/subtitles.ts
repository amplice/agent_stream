export class SubtitleRenderer {
  private element: HTMLElement;
  private typewriterTimeout: ReturnType<typeof setTimeout> | null = null;
  private fadeTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(element: HTMLElement) {
    this.element = element;
  }

  showTyping(token: string, fullText: string): void {
    this.clear();
    
    let index = 0;
    const reveal = () => {
      if (index < fullText.length) {
        this.element.textContent = fullText.slice(0, index + 1);
        index++;
        this.typewriterTimeout = setTimeout(reveal, 30 + Math.random() * 50);
      }
    };
    
    reveal();
  }

  showSpeaking(text: string): void {
    this.clear();
    this.element.textContent = text;

    if (this.fadeTimeout) {
      clearTimeout(this.fadeTimeout);
    }

    this.fadeTimeout = setTimeout(() => {
      this.element.textContent = '';
    }, 5000);
  }

  clear(): void {
    if (this.typewriterTimeout) {
      clearTimeout(this.typewriterTimeout);
      this.typewriterTimeout = null;
    }
    if (this.fadeTimeout) {
      clearTimeout(this.fadeTimeout);
      this.fadeTimeout = null;
    }
    this.element.textContent = '';
  }
}