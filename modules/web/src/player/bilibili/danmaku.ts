import { boundedText, exact, HelperError, integer, object } from './bridge';
export interface Comment {
  time: number;
  mode: number;
  color: number;
  text: string;
}
export function decodeComments(value: unknown, duration: number): Comment[] {
  const reply = object(value);
  exact(reply, ['comments']);
  if (!Array.isArray(reply.comments) || reply.comments.length > 1500)
    throw new HelperError('invalid-danmaku');
  return reply.comments.map((value) => {
    const c = object(value);
    exact(c, ['time', 'mode', 'color', 'text']);
    if (
      typeof c.time !== 'number' ||
      !Number.isFinite(c.time) ||
      c.time < 0 ||
      c.time > duration ||
      ![1, 4, 5].includes(c.mode as number)
    )
      throw new HelperError('invalid-danmaku');
    return {
      time: c.time,
      mode: c.mode as number,
      color: integer(c.color, 0, 0xffffff),
      text: boundedText(c.text, 200),
    };
  });
}
// Rendering uses observed media time. Pause, seek, and rate correction need no separate clock.
export class DanmakuRenderer {
  comments: Comment[] = [];
  visible = true;
  density = 20;
  fontSize = 20;
  private frame = 0;
  private nodes = new Map<Comment, HTMLSpanElement>();
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  constructor(
    private video: HTMLVideoElement,
    private overlay: HTMLElement
  ) {
    this.frame = requestAnimationFrame(this.draw);
  }
  clear(): void {
    this.comments = [];
    this.nodes.clear();
    this.overlay.replaceChildren();
  }
  private draw = (): void => {
    const now = this.video.currentTime;
    const shown = this.visible
      ? this.comments
          .filter((c) => c.time <= now && c.time + 6 > now)
          .slice(0, Math.min(40, this.density))
      : [];
    for (const [c, node] of this.nodes)
      if (!shown.includes(c)) {
        node.remove();
        this.nodes.delete(c);
      }
    for (const [i, c] of shown.entries()) {
      let node = this.nodes.get(c);
      if (!node) {
        node = document.createElement('span');
        node.textContent = c.text;
        this.nodes.set(c, node);
        this.overlay.append(node);
      }
      node.style.color = `#${c.color.toString(16).padStart(6, '0')}`;
      node.style.fontSize = `${this.fontSize}px`;
      node.style.top =
        c.mode === 4
          ? `${Math.max(0, this.overlay.clientHeight - 32 - (i % 3) * 30)}px`
          : `${(i % 10) * 30}px`;
      node.style.left =
        c.mode === 1 && !this.reduced.matches
          ? `${this.overlay.clientWidth - ((now - c.time) / 6) * (this.overlay.clientWidth + 400)}px`
          : '20%';
    }
    this.frame = requestAnimationFrame(this.draw);
  };
  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.clear();
  }
}
