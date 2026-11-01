import { boundedText, exact, HelperError, integer, object } from './bridge';
const SCROLL_DURATION_SECONDS = 10;
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
interface DisplayComment {
  node: HTMLSpanElement;
  mode: number;
  lane: number;
  width: number;
  x: number;
  velocity: number;
  remaining: number;
}

// Rendering uses observed media time. Pause, seek, and rate correction need no separate clock.
export class DanmakuRenderer {
  visible = true;
  density = 20;
  fontSize = 20;
  speed = 1;
  // Fraction of player height available to mode 1 comments, including reduced motion.
  area = 1;
  private frame = 0;
  private entries: Comment[] = [];
  private cursor = 0;
  private active: DisplayComment[] = [];
  private previousTime: number | undefined;
  private layout = '';
  private measurement = document.createElement('canvas').getContext('2d');
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  constructor(
    private video: HTMLVideoElement,
    private overlay: HTMLElement
  ) {
    this.frame = requestAnimationFrame(this.draw);
  }
  get comments(): Comment[] {
    return this.entries;
  }
  set comments(value: Comment[]) {
    this.entries = [...value].sort((a, b) => a.time - b.time);
    this.reset();
  }
  clear(): void {
    this.comments = [];
  }
  // Rebuild at the observed media time while retaining the loaded segment.
  reset(): void {
    this.active = [];
    this.overlay.replaceChildren();
    this.cursor = 0;
    this.previousTime = undefined;
  }
  private draw = (): void => {
    // Read layout before writing styles. Text measurement never forces DOM layout.
    const now = this.video.currentTime,
      width = this.overlay.clientWidth,
      height = this.overlay.clientHeight,
      stageHeight = this.overlay.parentElement?.clientHeight ?? height,
      fontSize = Math.max(16, Math.min(32, this.fontSize)),
      limit = Math.max(1, Math.min(40, this.density)),
      speed = Math.max(0.5, Math.min(1.5, this.speed)),
      lineHeight = Math.ceil(fontSize * 1.5),
      fullLanes = Math.max(0, Math.floor((height - 12) / lineHeight)),
      scrollHeight = Math.min(
        height,
        stageHeight * Math.max(0.25, Math.min(1, this.area))
      ),
      scrollLanes = Math.max(0, Math.floor((scrollHeight - 12) / lineHeight)),
      layout = `${width}:${height}:${fontSize}:${this.reduced.matches}:${this.visible}`;
    if (
      layout !== this.layout ||
      (this.previousTime !== undefined && now < this.previousTime)
    ) {
      this.reset();
      this.layout = layout;
      if (this.measurement)
        this.measurement.font = `600 ${fontSize}px ${getComputedStyle(this.overlay).fontFamily || 'sans-serif'}`;
    }
    const elapsed =
      this.previousTime === undefined ? 0 : now - this.previousTime;
    this.previousTime = now;
    this.active = this.active.filter((entry, i) => {
      entry.x -= elapsed * entry.velocity * speed;
      entry.remaining -= elapsed;
      if (
        i >= limit ||
        (entry.mode === 1 && entry.lane >= scrollLanes) ||
        (entry.velocity ? entry.x + entry.width <= 0 : entry.remaining <= 0)
      ) {
        entry.node.remove();
        return false;
      }
      return true;
    });
    while (this.cursor < this.entries.length) {
      const c = this.entries[this.cursor]!;
      if (c.time > now) break;
      this.cursor++;
      const age = now - c.time,
        lanes = c.mode === 1 ? scrollLanes : fullLanes;
      // Skip old history and consume crowded comments once, so they cannot
      // flash into a vacated lane.
      if (
        age >= SCROLL_DURATION_SECONDS / 0.5 ||
        !this.visible ||
        !lanes ||
        width <= 0 ||
        this.active.length >= limit
      )
        continue;
      const textWidth =
          Math.ceil(
            this.measurement?.measureText(c.text).width ??
              Array.from(c.text).length * fontSize
          ) + 2,
        scrolling = c.mode === 1 && !this.reduced.matches,
        velocity = scrolling
          ? (width + textWidth) / SCROLL_DURATION_SECONDS
          : 0,
        x = scrolling
          ? width - age * velocity * speed
          : Math.max(12, (width - textWidth) / 2);
      if (scrolling ? x + textWidth <= 0 : age >= 6) continue;
      let lane = -1;
      for (let i = 0; i < lanes; i++) {
        const candidate = c.mode === 4 ? lanes - 1 - i : i;
        const safe = this.active.every((entry) => {
          if (entry.lane !== candidate) return true;
          if (!velocity || !entry.velocity) return false;
          const right = entry.x + entry.width + 24;
          // Leave space now and until the preceding text has fully exited.
          return (
            x >= right &&
            (velocity <= entry.velocity ||
              x - (velocity * right) / entry.velocity >= 0)
          );
        });
        if (safe) {
          lane = candidate;
          break;
        }
      }
      if (lane === -1) continue;
      const node = document.createElement('span');
      node.textContent = c.text;
      node.style.color = `#${c.color.toString(16).padStart(6, '0')}`;
      node.style.fontSize = `${fontSize}px`;
      node.style.lineHeight = `${lineHeight}px`;
      node.style.top = `${12 + lane * lineHeight}px`;
      if (!scrolling) {
        node.style.maxWidth = `${Math.max(0, width - 24)}px`;
        node.style.overflow = 'hidden';
        node.style.textOverflow = 'ellipsis';
      }
      this.overlay.append(node);
      this.active.push({
        node,
        mode: c.mode,
        lane,
        width: textWidth,
        x,
        velocity,
        remaining: 6 - age,
      });
    }
    for (const entry of this.active)
      entry.node.style.transform = `translate3d(${entry.x}px, 0, 0)`;
    this.frame = requestAnimationFrame(this.draw);
  };
  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.clear();
  }
}
