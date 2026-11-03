import { parseBridgeJSON } from '@ovs/helper/bridge-json';
import release from '@ovs/helper/release';
import { LocalizedError, message, type Message } from '../../i18n';

export const helperRelease = release;
// All privileged values remain in the helper. This bridge owns one player channel.
type FailureStatus = 'access_denied' | 'unsupported' | 'error';
interface FailureGroup {
  codes: RegExp;
  message: Message;
  status: FailureStatus;
  reload?: boolean;
}
// Helper and adapter codes grouped by the action a participant can take. First match wins.
const groups: FailureGroup[] = [
  {
    codes: /^helper-missing$/,
    message: message('helper.errorMissing'),
    status: 'error',
    reload: true,
  },
  {
    codes: /^helper-incompatible$/,
    message: message('helper.errorIncompatible'),
    status: 'error',
    reload: true,
  },
  {
    codes: /^(bridge-timeout|invalid-reply|reply-too-large|invalid-request)$/,
    message: message('helper.errorReply'),
    status: 'error',
  },
  {
    codes: /^login-required$/,
    message: message('helper.errorLogin'),
    status: 'access_denied',
  },
  {
    codes: /^(platform-access-denied|access-expired)$/,
    message: message('helper.errorAccess'),
    status: 'access_denied',
  },
  {
    codes: /^(unsupported-codec)$/,
    message: message('helper.errorCodec'),
    status: 'unsupported',
  },
  {
    codes: /^(unsupported-stream)$/,
    message: message('helper.errorStream'),
    status: 'unsupported',
  },
  {
    codes: /^(rate-limited|busy|http-412|http-429)$/,
    message: message('helper.errorRate'),
    status: 'error',
  },
  {
    codes: /^(unavailable|part-unavailable|http-404)$/,
    message: message('helper.errorUnavailable'),
    status: 'error',
  },
  {
    codes: /^(media-changed|stale-generation|unknown-handle)$/,
    message: message('helper.errorChanged'),
    status: 'error',
  },
  {
    codes: /^(destination-denied|redirect-denied)$/,
    message: message('helper.errorDestination'),
    status: 'error',
  },
  {
    codes: /^(network-or-permission-denied|request-timeout|http-5[0-9]{2})$/,
    message: message('helper.errorNetwork'),
    status: 'error',
  },
];
const unusable: FailureGroup = {
  codes: /./,
  message: message('helper.errorData'),
  status: 'error',
};
export class HelperError extends LocalizedError {
  readonly status: FailureStatus;
  readonly reload: boolean;
  constructor(readonly code: string) {
    const group = groups.find((g) => g.codes.test(code)) ?? unusable;
    super(group.message);
    this.status = group.status;
    this.reload = group.reload ?? false;
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HelperError('invalid-reply');
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, fields: string[]): void {
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((f) => !Object.hasOwn(value, f))
  )
    throw new HelperError('invalid-reply');
}
export function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
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
  optional: boolean;
  source: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export class HelperBridge {
  private readonly client = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (b) => b.toString(16).padStart(2, '0'),
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
          typeof reply.error === 'string' &&
            /^[a-z0-9-]{1,64}$/.test(reply.error)
            ? reply.error
            : 'invalid-reply',
        );
      }
    } catch (error) {
      pending.reject(
        error instanceof HelperError ? error : new HelperError('invalid-reply'),
      );
    }
  };
  async hello(probe = false): Promise<void> {
    const value = await this.handshake(probe);
    if (
      value.version !== release.protocol ||
      value.helper !== release.version ||
      value.maxChunk !== 256 * 1024 ||
      value.build !== release.build
    )
      throw new HelperError('helper-incompatible');
  }
  async handshake(probe = false): Promise<{
    version: number;
    helper: string;
    maxChunk: number;
    build?: string;
  }> {
    let reply: unknown;
    // A manager can register its document listener after the application mounts.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        reply = await this.call(
          probe ? 'probe' : 'hello',
          { version: release.protocol },
          500,
        );
        break;
      } catch (error) {
        if (
          !(error instanceof HelperError) ||
          error.code !== 'helper-missing' ||
          attempt === 4
        )
          throw error;
      }
    }
    const value = object(reply);
    exact(value, [
      'version',
      'helper',
      'maxChunk',
      ...(Object.hasOwn(value, 'build') ? ['build'] : []),
    ]);
    // Accept legacy handshakes for onboarding, then require the deployed build in hello().
    const build = Object.hasOwn(value, 'build')
      ? boundedText(value.build, 64)
      : undefined;
    if (build !== undefined && !/^[a-f0-9]{64}$/.test(build))
      throw new HelperError('invalid-reply');
    return {
      version: integer(value.version, 1, 100),
      helper: boundedText(value.helper, 32),
      maxChunk: integer(value.maxChunk, 1, 1024 * 1024),
      ...(build !== undefined ? { build } : {}),
    };
  }
  call(
    op: string,
    args: Record<string, unknown> = {},
    // Resolving metadata needs two sequential requests within the helper budget.
    deadline = ['preview', 'open'].includes(op) ? 30000 : 15000,
    source = 0,
  ): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    const optional = op === 'thumbnails' || op === 'thumbnail';
    // Background replies are grouped by opaque CDN identity, independently of controls.
    const occupied = [...this.pending.values()].filter(
      (pending) =>
        pending.optional === optional &&
        (!optional || pending.source === source),
    ).length;
    if (occupied >= (optional ? 2 : 4))
      return Promise.reject(new HelperError('busy'));
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
        reject(
          new HelperError(
            op === 'hello' || op === 'probe'
              ? 'helper-missing'
              : 'bridge-timeout',
          ),
        );
      }, deadline);
      this.pending.set(id, { optional, source, resolve, reject, timer });
      window.postMessage(request, location.origin);
    });
  }
  seek(handle: string, generation: number, seek: number): void {
    if (this.closed) return;
    // Cancellation must bypass occupied byte-request slots.
    window.postMessage(
      JSON.stringify({
        channel: 'ovs-bilibili-request',
        client: this.client,
        id: ++this.sequence,
        op: 'seek',
        handle,
        generation,
        seek,
      }),
      location.origin,
    );
  }
  close(generation: number, releaseOwner = true): void {
    if (this.closed) return;
    // Cancellation bypasses both foreground and background reply capacity.
    if (releaseOwner)
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
