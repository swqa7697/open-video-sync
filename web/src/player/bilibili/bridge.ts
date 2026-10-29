import { parseBridgeJSON } from '../../../../userscripts/bridge-json.js';
// All privileged values remain in the helper. This bridge owns one player channel.
export class HelperError extends Error {
  constructor(readonly code: string) {
    super(
      Object.hasOwn(messages, code)
        ? messages[code]
        : 'Bilibili playback failed. Reload media or check your local platform access.',
    );
  }
}
const messages: Record<string, string> = {
  'helper-missing': 'Install or enable the OVS Bilibili helper, then reload this page.',
  'helper-incompatible':
    'Update the OVS Bilibili helper from this instance, then reload this page.',
  'bridge-timeout':
    'The Bilibili helper did not respond. Check manager permissions and reload media.',
  'part-unavailable': 'This Bilibili part is unavailable.',
  'media-changed': 'The Bilibili part or stream changed. Select the video again.',
  'unsupported-codec': 'This browser cannot decode the selected Bilibili AVC/AAC streams.',
  'unsupported-stream':
    'This Bilibili video does not provide a supported on-demand AVC/AAC stream.',
  'platform-access-denied':
    'Bilibili refused this browser’s video access. Check your local session and access rights.',
  'network-or-permission-denied':
    'Bilibili requests were blocked. Check network access and Tampermonkey permissions.',
  'login-required': 'Sign in to Bilibili in this browser profile, then reload media.',
};
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HelperError('invalid-reply');
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some((f) => !Object.hasOwn(value, f)))
    throw new HelperError('invalid-reply');
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new HelperError('invalid-reply');
  return value;
}
export function boundedText(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    Array.from(value).some((c) => {
      const n = c.codePointAt(0)!;
      return n < 32 || (n >= 127 && n <= 159);
    })
  )
    throw new HelperError('invalid-reply');
  return value;
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export class HelperBridge {
  private readonly client = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private closed = false;
  constructor() {
    window.addEventListener('message', this.receive);
  }
  private receive = (event: MessageEvent<unknown>): void => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      typeof event.data !== 'string' ||
      event.data.length > 384 * 1024 ||
      new TextEncoder().encode(event.data).length > 384 * 1024
    )
      return;
    let reply: Record<string, unknown>;
    try {
      reply = parseBridgeJSON(event.data, 384 * 1024);
    } catch {
      return;
    }
    if (
      reply.channel !== 'ovs-bilibili-response' ||
      reply.client !== this.client ||
      typeof reply.id !== 'number'
    )
      return;
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(reply.id);
    try {
      if (reply.ok === true) {
        exact(reply, ['channel', 'client', 'id', 'ok', 'value']);
        pending.resolve(reply.value);
      } else {
        exact(reply, ['channel', 'client', 'id', 'ok', 'error']);
        throw new HelperError(
          typeof reply.error === 'string' && /^[a-z0-9-]{1,64}$/.test(reply.error)
            ? reply.error
            : 'invalid-reply',
        );
      }
    } catch (error) {
      pending.reject(error instanceof HelperError ? error : new HelperError('invalid-reply'));
    }
  };
  async hello(): Promise<void> {
    let reply: unknown;
    // A manager can register its document listener after the application mounts.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        reply = await this.call('hello', { version: 1 }, 500);
        break;
      } catch (error) {
        if (!(error instanceof HelperError) || error.code !== 'helper-missing' || attempt === 4)
          throw error;
      }
    }
    const value = object(reply);
    exact(value, ['version', 'helper', 'maxChunk']);
    if (value.version !== 1 || value.helper !== '1.0.0' || value.maxChunk !== 256 * 1024)
      throw new HelperError('helper-incompatible');
  }
  call(op: string, args: Record<string, unknown> = {}, deadline = 15000): Promise<unknown> {
    if (this.closed) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    if (this.pending.size >= 4) return Promise.reject(new HelperError('busy'));
    const id = ++this.sequence;
    const request = JSON.stringify({
      channel: 'ovs-bilibili-request',
      client: this.client,
      id,
      op,
      ...args,
    });
    if (new TextEncoder().encode(request).length > 2048)
      return Promise.reject(new HelperError('invalid-request'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperError(op === 'hello' ? 'helper-missing' : 'bridge-timeout'));
      }, deadline);
      this.pending.set(id, { resolve, reject, timer });
      window.postMessage(request, location.origin);
    });
  }
  close(generation: number): void {
    if (this.closed) return;
    // Cancellation must remain available when all four request slots are occupied.
    window.postMessage(
      JSON.stringify({
        channel: 'ovs-bilibili-request',
        client: this.client,
        id: ++this.sequence,
        op: 'dispose',
        generation,
      }),
      location.origin,
    );
    this.closed = true;
    window.removeEventListener('message', this.receive);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new DOMException('Cancelled', 'AbortError'));
    }
    this.pending.clear();
  }
}
