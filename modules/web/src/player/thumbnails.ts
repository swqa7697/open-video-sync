// Preview decoding never uses the synchronized playback element.
export function drawThumbnail(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  const context = canvas.getContext('2d');
  if (!context) return false;
  const scale = Math.min(canvas.width / width, canvas.height / height);
  const w = width * scale,
    h = height * scale;
  context.fillStyle = '#000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    source,
    x,
    y,
    width,
    height,
    (canvas.width - w) / 2,
    (canvas.height - h) / 2,
    w,
    h,
  );
  return true;
}

export class LocalThumbnails {
  private video: HTMLVideoElement | undefined;
  private lifetime = new AbortController();
  constructor(private readonly url: string) {}

  async draw(
    positionMs: number,
    canvas: HTMLCanvasElement,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.lifetime.signal.aborted || signal.aborted) return false;
    if (!this.video) {
      this.video = document.createElement('video');
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.preload = 'auto';
      this.video.src = this.url;
    }
    const video = this.video;
    if (video.readyState < 2)
      await this.wait(video, signal, () => video.readyState >= 2);
    // End-of-file seeks can have no decoded frame. Use the last playable instant.
    const target = Math.max(
      0,
      Math.min(positionMs / 1000, video.duration - 0.05),
    );
    const atTarget = () =>
      !video.seeking &&
      video.readyState >= 2 &&
      Math.abs(video.currentTime - target) < 0.02;
    if (!atTarget())
      await this.wait(video, signal, atTarget, () => {
        video.currentTime = target;
      });
    if (signal.aborted || this.lifetime.signal.aborted) return false;
    return drawThumbnail(
      canvas,
      video,
      0,
      0,
      video.videoWidth,
      video.videoHeight,
    );
  }

  dispose(): void {
    this.lifetime.abort();
    this.video?.removeAttribute('src');
    this.video?.load();
    this.video = undefined;
  }

  private wait(
    video: HTMLVideoElement,
    signal: AbortSignal,
    ready: () => boolean,
    operation?: () => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let frame: number | undefined;
      let presented = typeof video.requestVideoFrameCallback !== 'function';
      const cleanup = () => {
        clearTimeout(timer);
        if (frame !== undefined) video.cancelVideoFrameCallback(frame);
        for (const event of ['loadeddata', 'seeked'])
          video.removeEventListener(event, done);
        video.removeEventListener('error', fail);
        signal.removeEventListener('abort', abort);
        this.lifetime.signal.removeEventListener('abort', abort);
      };
      const done = () => {
        if (presented && ready()) {
          cleanup();
          resolve();
        }
      };
      const fail = () => {
        cleanup();
        reject(new Error('Thumbnail unavailable'));
      };
      const abort = () => {
        cleanup();
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      const timer = setTimeout(fail, 5000);
      for (const event of ['loadeddata', 'seeked'])
        video.addEventListener(event, done);
      video.addEventListener('error', fail, { once: true });
      signal.addEventListener('abort', abort, { once: true });
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted || this.lifetime.signal.aborted) {
        abort();
        return;
      }
      try {
        // seeked/currentTime can advance before drawImage sees the new frame.
        // Register before changing the source position so a fast presentation is owned.
        if (!presented)
          frame = video.requestVideoFrameCallback(() => {
            presented = true;
            done();
          });
        operation?.();
        done();
      } catch {
        fail();
      }
    });
  }
}
