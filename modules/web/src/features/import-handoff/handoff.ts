import { id, integer, object, requestKey, shape } from '../../transport/api';
import { decodeMedia, type MediaDescriptor } from '../../transport/contracts';

export interface ImportTarget {
  tabId: string;
  roomId: string;
  epoch: string;
  mediaGeneration: number;
  expectedRevision: number;
}

export interface ImportRequest {
  requestId: string;
  target: ImportTarget;
  media: Extract<MediaDescriptor, { kind: 'bilibili' }>;
}

const statuses = [
  'accepted',
  'stale',
  'unavailable',
  'busy',
  'rejected',
  'outcome_unknown',
] as const;
export interface ImportResult {
  status: (typeof statuses)[number];
}

interface HandoffOptions {
  // Return nothing unless this page currently owns a connected host socket.
  room?: () => Omit<ImportTarget, 'tabId'> | undefined;
  // Resolve accepted only after the matching server command result. Retries keep requestId.
  execute?: (request: ImportRequest) => Promise<ImportResult>;
}

export interface HandoffChannel {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: unknown): void;
  close(): void;
}

type Message =
  | { v: 1; kind: 'discover'; requestId: string; roomId: string }
  | { v: 1; kind: 'offer'; requestId: string; target: ImportTarget }
  | ({ v: 1; kind: 'submit' } & ImportRequest)
  | {
      v: 1;
      kind: 'result';
      requestId: string;
      tabId: string;
      status: ImportResult['status'];
    };

interface Pending {
  kind: 'discover' | 'submit';
  tabId?: string | undefined;
  roomId?: string | undefined;
  finish(value: ImportTarget | ImportResult | undefined): void;
}

interface Receipt {
  signature: string;
  expiresAt: number;
  result?: ImportResult;
  running?: Promise<ImportResult> | undefined;
}

function target(value: unknown): ImportTarget {
  const input = object(value);
  shape(input, [
    'tabId',
    'roomId',
    'epoch',
    'mediaGeneration',
    'expectedRevision',
  ]);
  const revision = integer(input.expectedRevision);
  if (revision < 1) throw Error('invalid import');
  return {
    tabId: id(input.tabId),
    roomId: id(input.roomId),
    epoch: id(input.epoch),
    mediaGeneration: integer(input.mediaGeneration),
    expectedRevision: revision,
  };
}

function status(value: unknown): ImportResult['status'] {
  for (const candidate of statuses) if (candidate === value) return candidate;
  throw Error('invalid import');
}

function decode(value: unknown): Message {
  const input = object(value);
  if (input.v !== 1) throw Error('invalid import');
  const requestId = id(input.requestId);
  switch (input.kind) {
    case 'discover':
      shape(input, ['v', 'kind', 'requestId', 'roomId']);
      return { v: 1, kind: 'discover', requestId, roomId: id(input.roomId) };
    case 'offer':
      shape(input, ['v', 'kind', 'requestId', 'target']);
      return { v: 1, kind: 'offer', requestId, target: target(input.target) };
    case 'submit': {
      shape(input, ['v', 'kind', 'requestId', 'target', 'media']);
      const media = decodeMedia(input.media);
      if (media.kind !== 'bilibili') throw Error('invalid import');
      return {
        v: 1,
        kind: 'submit',
        requestId,
        target: target(input.target),
        media,
      };
    }
    case 'result':
      shape(input, ['v', 'kind', 'requestId', 'tabId', 'status']);
      return {
        v: 1,
        kind: 'result',
        requestId,
        tabId: id(input.tabId),
        status: status(input.status),
      };
    default:
      throw Error('invalid import');
  }
}

function sameRoom(a: ImportTarget, b: ImportTarget): boolean {
  return (
    a.tabId === b.tabId &&
    a.roomId === b.roomId &&
    a.epoch === b.epoch &&
    a.mediaGeneration === b.mediaGeneration &&
    a.expectedRevision === b.expectedRevision
  );
}

// BroadcastChannel scopes discovery and dispatch to this origin and storage partition.
// It provides no authorization; the active socket and server still enforce every command.
export class ImportHandoff {
  private readonly tabId = requestKey();
  private channel: HandoffChannel | undefined;
  private pending = new Map<string, Pending>();
  private receipts = new Map<string, Receipt>();
  private disposed = false;

  constructor(
    private options: HandoffOptions = {},
    createChannel: () => HandoffChannel = () =>
      new BroadcastChannel('ovs-video-import-v1'),
  ) {
    try {
      this.channel = createChannel();
      this.channel.addEventListener('message', this.receive);
    } catch {
      // Explicit room opening remains usable when cross-tab messaging is unavailable.
      this.channel = undefined;
    }
  }

  discover(
    roomId: string,
    signal?: AbortSignal,
  ): Promise<ImportTarget | undefined> {
    id(roomId);
    if (signal?.aborted || !this.channel || this.disposed)
      return Promise.resolve(undefined);
    const requestId = requestKey();
    return this.wait<ImportTarget | undefined>(
      requestId,
      'discover',
      undefined,
      1200,
      undefined,
      signal,
      () => this.post({ v: 1, kind: 'discover', requestId, roomId }),
      roomId,
    );
  }

  submit(
    destination: ImportTarget,
    media: MediaDescriptor,
    requestId = requestKey(),
    signal?: AbortSignal,
  ): Promise<ImportResult> {
    const command = decode({
      v: 1,
      kind: 'submit',
      requestId,
      target: destination,
      media,
    });
    if (signal?.aborted || !this.channel || this.disposed)
      return Promise.resolve({ status: 'unavailable' });
    return this.wait<ImportResult>(
      requestId,
      'submit',
      destination.tabId,
      15000,
      { status: 'outcome_unknown' },
      signal,
      () => this.post(command),
    );
  }

  private wait<T extends ImportTarget | ImportResult | undefined>(
    requestId: string,
    kind: Pending['kind'],
    tabId: string | undefined,
    milliseconds: number,
    fallback: T,
    signal: AbortSignal | undefined,
    send: () => void,
    roomId?: string,
  ): Promise<T> {
    if (this.pending.has(requestId) || this.pending.size >= 8)
      return Promise.resolve(fallback);
    return new Promise<T>((resolve) => {
      const finish = (value: ImportTarget | ImportResult | undefined) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(value as T);
      };
      const abort = () => finish(fallback);
      const timer = setTimeout(abort, milliseconds);
      this.pending.set(requestId, { kind, tabId, roomId, finish });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        send();
      } catch {
        finish(fallback);
      }
    });
  }

  private post(message: Message): void {
    try {
      if (!this.disposed) this.channel?.postMessage(message);
    } catch {
      // The other page may have closed or storage access may have been revoked.
    }
  }

  private receive = (event: MessageEvent<unknown>): void => {
    let message: Message;
    try {
      message = decode(event.data);
    } catch {
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (
      message.kind === 'offer' &&
      pending?.kind === 'discover' &&
      pending.roomId === message.target.roomId
    ) {
      pending.finish(message.target);
      return;
    }
    if (
      message.kind === 'result' &&
      pending?.kind === 'submit' &&
      pending.tabId === message.tabId
    ) {
      pending.finish({ status: message.status });
      return;
    }
    if (message.kind === 'discover') {
      const current = this.current();
      if (current?.roomId === message.roomId)
        this.post({
          v: 1,
          kind: 'offer',
          requestId: message.requestId,
          target: current,
        });
    } else if (
      message.kind === 'submit' &&
      message.target.tabId === this.tabId
    ) {
      void this.execute(message);
    }
  };

  private current(): ImportTarget | undefined {
    try {
      const room = this.options.room?.();
      return room ? target({ ...room, tabId: this.tabId }) : undefined;
    } catch {
      return undefined;
    }
  }

  private async execute(request: ImportRequest): Promise<void> {
    const now = performance.now();
    for (const [key, receipt] of this.receipts)
      if (!receipt.running && receipt.expiresAt <= now)
        this.receipts.delete(key);
    const signature = JSON.stringify({
      target: request.target,
      media: request.media,
    });
    let receipt = this.receipts.get(request.requestId);
    if (receipt && receipt.signature !== signature) return;
    if (!receipt) {
      const current = this.current();
      const result: ImportResult | undefined = !current
        ? { status: 'unavailable' }
        : !sameRoom(current, request.target)
          ? { status: 'stale' }
          : !this.options.execute || this.receipts.size >= 32
            ? { status: 'busy' }
            : undefined;
      if (result) {
        this.result(request.requestId, result);
        return;
      }
      receipt = { signature, expiresAt: now + 60000 };
      this.receipts.set(request.requestId, receipt);
    }
    if (
      !receipt.running &&
      (!receipt.result || receipt.result.status === 'outcome_unknown')
    ) {
      receipt.running = Promise.resolve()
        .then((): ImportResult | Promise<ImportResult> =>
          this.disposed
            ? { status: 'unavailable' }
            : this.options.execute!(request),
        )
        .then((result) => ({ status: status(result.status) }))
        .catch((): ImportResult => ({ status: 'outcome_unknown' }));
    }
    if (receipt.running) {
      const running = receipt.running;
      receipt.result = await running;
      if (receipt.running === running) receipt.running = undefined;
    }
    this.result(request.requestId, receipt.result!);
  }

  private result(requestId: string, result: ImportResult): void {
    this.post({
      v: 1,
      kind: 'result',
      requestId,
      tabId: this.tabId,
      status: result.status,
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const pending of this.pending.values())
      pending.finish(
        pending.kind === 'discover' ? undefined : { status: 'outcome_unknown' },
      );
    this.channel?.removeEventListener('message', this.receive);
    this.channel?.close();
    this.channel = undefined;
    this.receipts.clear();
  }
}
