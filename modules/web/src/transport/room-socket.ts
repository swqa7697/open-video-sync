import { message, type Message } from '../i18n';
import {
  APIError,
  decodeSnapshot,
  id,
  integer,
  object,
  requestKey,
  shape,
  text,
  type Snapshot,
} from './api';
import { parseFrame } from './protocol-values';
import { ClockEstimator } from '../sync/clock';
import { decodeMedia, type MediaDescriptor } from './contracts';

export interface Command {
  v: 2;
  type: 'playback.command' | 'media.select';
  commandId: string;
  epoch: string;
  mediaGeneration: number;
  expectedRevision: number;
  payload:
    | { action: 'play' | 'pause' | 'replay' }
    | { action: 'seek'; positionMs: number }
    | { media: MediaDescriptor };
}
// Why a room connection ended for good. Other closures reconnect with backoff.
export type EndReason =
  | 'replaced'
  | 'closed'
  | 'removed'
  | 'session_ended'
  | 'room_unavailable'
  | 'revoked';
// The browser cannot read HTTP statuses of refused WebSocket upgrades; an HTTP probe can.
export type ProbeResult =
  'reachable' | 'session_ended' | 'room_unavailable' | 'unreachable';
export interface SocketEvents {
  snapshot(snapshot: Snapshot): void;
  status(status: Message): void;
  lease(active: boolean): void;
  error(
    message: Message | '',
    options?: { reload?: boolean; recheck?: boolean }
  ): void;
  uncertain(command: Command | undefined): void;
  ended(reason: EndReason): void;
}
export class RoomSocket {
  readonly clock = new ClockEstimator();
  snapshot?: Snapshot;
  active = false;
  connected = false;
  private socket?: WebSocket;
  private stopped = false;
  private terminal = false;
  private welcomed = false;
  private refusals = 0;
  private probing: AbortController | undefined;
  private sequence = 0;
  private attempts = 0;
  private lastMessage = 0;
  private lastCalibration = 0;
  private timer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pending: Command | undefined;
  private pings = new Map<string, number>();
  constructor(
    private roomId: string,
    private events: SocketEvents,
    private probe: (signal: AbortSignal) => Promise<ProbeResult> = () =>
      Promise.resolve('unreachable')
  ) {}
  start(): void {
    this.stopped = false;
    this.terminal = false;
    this.connect();
    this.timer = setInterval(() => {
      if (this.connected && performance.now() - this.lastMessage >= 5000) {
        this.connected = false;
        this.events.status(message('socket.uncertain'));
        this.socket?.close();
      } else if (
        this.connected &&
        performance.now() - this.lastCalibration >= 5000
      )
        this.calibrate(1);
    }, 250);
  }
  private connect(): void {
    if (this.stopped || this.terminal) return;
    this.clock.reset();
    this.pings.clear();
    this.sequence = 0;
    this.events.status(message('player.connecting'));
    const url = new URL(`/ws/v2/rooms/${this.roomId}`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.socket = socket;
    this.welcomed = false;
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.socket !== socket || this.stopped) return;
      try {
        if (typeof event.data !== 'string') throw new Error('Invalid frame.');
        this.receive(parseFrame(event.data));
        this.lastMessage = performance.now();
      } catch {
        this.events.error(message('socket.invalidData'));
        socket.close();
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket || this.stopped || this.terminal) return;
      this.connected = false;
      this.clock.reset();
      this.events.status(message('socket.disconnected'));
      if (this.welcomed) this.schedule();
      else void this.diagnose();
    };
  }
  private schedule(): void {
    const delay =
      Math.min(15000, 500 * 2 ** Math.min(this.attempts++, 5)) *
      (0.8 + Math.random() * 0.4);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
  // A refusal before welcome may be terminal. Only OVS answers can end retries; proxy and
  // network failures keep the backoff.
  private async diagnose(): Promise<void> {
    const probing = new AbortController();
    this.probing = probing;
    let result: ProbeResult;
    try {
      result = await this.probe(probing.signal);
    } catch {
      result = 'unreachable';
    }
    if (this.probing !== probing || this.stopped || this.terminal) return;
    this.probing = undefined;
    if (result === 'session_ended' || result === 'room_unavailable') {
      this.end(result);
      return;
    }
    if (result === 'reachable' && ++this.refusals === 3)
      this.events.error(message('socket.refused'));
    this.schedule();
  }
  private end(reason: EndReason): void {
    this.terminal = true;
    this.connected = false;
    this.active = false;
    this.pending = undefined;
    this.events.uncertain(undefined);
    this.events.lease(false);
    this.socket?.close();
    this.events.status(
      reason === 'replaced'
        ? message('socket.otherPage')
        : message('socket.ended')
    );
    this.events.ended(reason);
  }
  private receive(f: Record<string, unknown>): void {
    if (f.v !== 2) {
      this.upgrade();
      return;
    }
    const kind = text(f.type),
      p = object(f.payload);
    if (kind === 'clock.pong' || kind === 'heartbeat') {
      shape(f, ['v', 'type', 'requestId', 'payload']);
      const key = id(f.requestId);
      if (kind === 'heartbeat') {
        shape(p, ['reply']);
        if (typeof p.reply !== 'boolean') throw new Error('Invalid heartbeat.');
        if (!p.reply)
          this.send({
            v: 2,
            type: 'heartbeat',
            requestId: key,
            payload: { reply: true },
          });
      } else {
        shape(p, ['clientSendMs', 'serverReceiveMs', 'serverSendMs']);
        const c0 = this.pings.get(key);
        this.pings.delete(key);
        if (c0 !== undefined && integer(p.clientSendMs) === c0)
          this.clock.add(
            c0,
            integer(p.serverReceiveMs),
            integer(p.serverSendMs),
            Math.ceil(performance.now())
          );
      }
      return;
    }
    shape(f, ['v', 'type', 'epoch', 'eventSeq', 'payload']);
    const seq = integer(f.eventSeq);
    if (seq !== this.sequence + 1) throw new Error('Room event gap.');
    this.sequence = seq;
    if (kind === 'error') {
      this.publicError(p);
      return;
    }
    const epoch = id(f.epoch);
    if (kind === 'session.welcome') {
      shape(p, ['connectionId', 'snapshot']);
      id(p.connectionId);
      this.active = true;
      this.events.lease(true);
      this.connected = true;
      this.welcomed = true;
      this.attempts = 0;
      // A refusal explanation no longer applies once the room admits this page.
      if (this.refusals >= 3) this.events.error('');
      this.refusals = 0;
      sessionStorage.removeItem('ovs-protocol-reload');
      this.events.status(message('socket.connected'));
      this.acceptSnapshot(decodeSnapshot(p.snapshot), epoch);
      this.calibrate(5);
    } else if (kind === 'room.snapshot')
      this.acceptSnapshot(decodeSnapshot(p), epoch);
    else if (kind === 'command.result') {
      if (this.snapshot?.epoch !== epoch)
        throw new Error('Invalid result epoch.');
      shape(p, ['commandId', 'accepted', 'revision', 'error']);
      const key = id(p.commandId);
      if (typeof p.accepted !== 'boolean') throw new Error('Invalid result.');
      if (p.accepted) {
        integer(p.revision);
        if (p.error !== null) throw new Error('Invalid result.');
      } else {
        if (p.revision !== null) throw new Error('Invalid result.');
        this.publicError(object(p.error));
      }
      if (this.pending?.commandId === key) {
        this.pending = undefined;
        this.events.uncertain(undefined);
      }
    } else if (kind === 'session.replaced') {
      shape(p, ['reason']);
      if (!['connection_replaced', 'session_revoked'].includes(text(p.reason)))
        throw new Error('Invalid lifecycle.');
      if (p.reason === 'connection_replaced') this.end('replaced');
      else {
        // Removal, a forgotten identity, and session expiry share one frame; HTTP tells them apart.
        this.terminal = true;
        this.connected = false;
        this.active = false;
        this.events.lease(false);
        this.socket?.close();
        const probing = new AbortController();
        this.probing = probing;
        void this.probe(probing.signal)
          .catch((): ProbeResult => 'unreachable')
          .then((result) => {
            if (this.probing !== probing || this.stopped) return;
            this.probing = undefined;
            this.end(
              result === 'session_ended'
                ? 'session_ended'
                : result === 'room_unavailable'
                  ? 'removed'
                  : 'revoked'
            );
          });
      }
    } else if (kind === 'server.stopping') {
      shape(p, ['reason']);
      if (p.reason !== 'shutdown') throw new Error('Invalid shutdown.');
      this.connected = false;
      this.events.status(message('socket.stopping'));
      this.socket?.close();
    } else if (kind === 'room.closed') {
      shape(p, ['roomId', 'revision']);
      id(p.roomId);
      integer(p.revision);
      this.end('closed');
    } else throw new Error('Unknown event.');
  }
  private publicError(p: Record<string, unknown>): void {
    shape(p, ['code', 'message', 'requestId', 'retryable']);
    const code = text(p.code);
    text(p.message);
    id(p.requestId);
    if (typeof p.retryable !== 'boolean') throw new Error('Invalid error.');
    if (code === 'upgrade_required') {
      this.upgrade();
      return;
    }
    const description =
      code === 'forbidden'
        ? message('socket.forbidden')
        : code === 'stale_state'
          ? message('socket.stale')
          : code === 'storage_unavailable'
            ? message('socket.storage')
            : p.retryable
              ? message('socket.retry')
              : new APIError(code).text;
    this.events.error(description, { recheck: code === 'storage_unavailable' });
  }
  private upgrade(): void {
    this.terminal = true;
    this.socket?.close();
    if (!sessionStorage.getItem('ovs-protocol-reload')) {
      sessionStorage.setItem('ovs-protocol-reload', '1');
      location.reload();
    } else this.events.error(message('socket.upgrade'), { reload: true });
  }
  private acceptSnapshot(snapshot: Snapshot, epoch: string): void {
    if (snapshot.roomId !== this.roomId || snapshot.epoch !== epoch)
      throw new Error('Invalid room.');
    if (this.snapshot?.epoch !== snapshot.epoch) {
      this.clock.reset();
      if (this.pending && this.pending.epoch !== snapshot.epoch) {
        this.pending = undefined;
        this.events.uncertain(undefined);
      }
    }
    this.snapshot = snapshot;
    this.events.snapshot(snapshot);
  }
  private send(value: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(value));
  }
  calibrate(count = 5): void {
    if (!this.connected) return;
    this.lastCalibration = performance.now();
    for (let i = 0; i < count; i++) {
      const key = requestKey(),
        at = Math.floor(performance.now());
      this.pings.set(key, at);
      this.send({
        v: 2,
        type: 'clock.ping',
        requestId: key,
        payload: { clientSendMs: at },
      });
    }
    if (this.pings.size > 20) this.pings = new Map([...this.pings].slice(-20));
  }
  command(payload: Command['payload']): void {
    const s = this.snapshot;
    if (!s || !this.connected || !this.active || this.pending) {
      this.events.error(message('socket.controls'));
      return;
    }
    const safePayload =
      'media' in payload ? { media: decodeMedia(payload.media) } : payload;
    const command: Command = {
      v: 2,
      type: 'media' in safePayload ? 'media.select' : 'playback.command',
      commandId: requestKey(),
      epoch: s.epoch,
      mediaGeneration: s.mediaGeneration,
      expectedRevision: s.revision,
      payload: safePayload,
    };
    this.pending = command;
    this.events.uncertain(command);
    this.send(command);
  }
  resolveUncertain(): void {
    if (
      this.connected &&
      this.active &&
      this.pending?.epoch === this.snapshot?.epoch
    )
      this.send(this.pending);
  }
  readiness(payload: unknown): void {
    if (this.connected && this.active && this.snapshot)
      this.send({
        v: 2,
        type: 'member.readiness',
        epoch: this.snapshot.epoch,
        payload,
      });
  }
  resetClock(): void {
    this.clock.reset();
    this.calibrate();
  }
  dispose(): void {
    this.stopped = true;
    this.probing?.abort();
    this.probing = undefined;
    clearInterval(this.timer);
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.clock.reset();
    this.pending = undefined;
  }
}
