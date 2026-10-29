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
import { decodeReadiness, parseFrame } from './protocol-values';
import { ClockEstimator } from '../sync/clock';
import { decodeMedia, type MediaDescriptor } from './contracts';

export interface Command {
  v: 1;
  type: 'playback.command' | 'media.select' | 'waiting.exclude';
  commandId: string;
  epoch: string;
  mediaGeneration: number;
  expectedRevision: number;
  payload:
    | { action: 'play' | 'pause' | 'replay' }
    | { action: 'seek'; positionMs: number }
    | { media: MediaDescriptor }
    | { memberId: string; excluded: boolean };
}
export interface SocketEvents {
  snapshot(snapshot: Snapshot): void;
  status(status: string): void;
  lease(active: boolean): void;
  error(message: string): void;
  uncertain(command: Command | undefined): void;
}
export class RoomSocket {
  readonly clock = new ClockEstimator();
  snapshot?: Snapshot;
  active = false;
  connected = false;
  private socket?: WebSocket;
  private stopped = false;
  private terminal = false;
  private closedRoom = false;
  get roomClosed(): boolean {
    return this.closedRoom;
  }
  private sequence = 0;
  private attempts = 0;
  private lastMessage = 0;
  private lastCalibration = 0;
  private timer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pending: Command | undefined;
  private activateAfterWelcome = false;
  private pings = new Map<string, number>();
  constructor(
    private roomId: string,
    private events: SocketEvents,
  ) {}
  start(): void {
    this.stopped = false;
    this.terminal = false;
    this.connect();
    this.timer = setInterval(() => {
      if (this.connected && performance.now() - this.lastMessage >= 5000) {
        this.connected = false;
        this.events.status('Connection uncertain. Playback paused.');
        this.socket?.close();
      } else if (this.connected && performance.now() - this.lastCalibration >= 5000)
        this.calibrate(1);
    }, 250);
  }
  private connect(): void {
    if (this.stopped || this.terminal) return;
    this.clock.reset();
    this.pings.clear();
    this.sequence = 0;
    this.events.status('Connecting…');
    const url = new URL(`/ws/v1/rooms/${this.roomId}`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.socket !== socket || this.stopped) return;
      try {
        if (typeof event.data !== 'string') throw new Error('Invalid frame.');
        this.receive(parseFrame(event.data));
        this.lastMessage = performance.now();
      } catch {
        this.events.error('The room connection returned invalid data. Reconnecting.');
        socket.close();
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket || this.stopped) return;
      this.connected = false;
      this.clock.reset();
      this.events.status(
        this.closedRoom
          ? 'Room closed.'
          : this.terminal
            ? 'Playback inactive.'
            : 'Disconnected. Playback paused.',
      );
      if (!this.terminal) {
        const delay =
          Math.min(15000, 500 * 2 ** Math.min(this.attempts++, 5)) * (0.8 + Math.random() * 0.4);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    };
  }
  private receive(f: Record<string, unknown>): void {
    if (f.v !== 1) {
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
          this.send({ v: 1, type: 'heartbeat', requestId: key, payload: { reply: true } });
      } else {
        shape(p, ['clientSendMs', 'serverReceiveMs', 'serverSendMs']);
        const c0 = this.pings.get(key);
        this.pings.delete(key);
        if (c0 !== undefined && integer(p.clientSendMs) === c0)
          this.clock.add(
            c0,
            integer(p.serverReceiveMs),
            integer(p.serverSendMs),
            Math.ceil(performance.now()),
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
      shape(p, ['connectionId', 'connectionGeneration', 'playbackLease', 'snapshot']);
      id(p.connectionId);
      integer(p.connectionGeneration);
      if (typeof p.playbackLease !== 'boolean') throw new Error('Invalid lease.');
      this.active = p.playbackLease;
      this.events.lease(this.active);
      this.connected = true;
      this.attempts = 0;
      sessionStorage.removeItem('ovs-protocol-reload');
      this.events.status('Connected');
      this.acceptSnapshot(decodeSnapshot(p.snapshot), epoch);
      this.calibrate(5);
      if (this.activateAfterWelcome) {
        this.activateAfterWelcome = false;
        this.activate();
      }
    } else if (kind === 'room.snapshot') this.acceptSnapshot(decodeSnapshot(p), epoch);
    else if (kind === 'member.status') {
      shape(p, [
        'memberId',
        'presence',
        'playbackActive',
        'playbackEligible',
        'excludedFromWaiting',
        'readiness',
      ]);
      const memberId = id(p.memberId),
        snapshot = this.snapshot;
      if (
        !snapshot ||
        snapshot.epoch !== epoch ||
        !snapshot.members.some((m) => m.memberId === memberId)
      )
        throw new Error('Invalid member status.');
      const readiness = p.readiness === null ? null : decodeReadiness(p.readiness);
      if (readiness && readiness.mediaGeneration < snapshot.mediaGeneration) return;
      if (readiness && readiness.mediaGeneration > snapshot.mediaGeneration)
        throw new Error('Invalid readiness generation.');
      this.acceptSnapshot(
        decodeSnapshot({
          ...snapshot,
          members: snapshot.members.map((m) =>
            m.memberId === memberId
              ? {
                  ...m,
                  presence: p.presence,
                  playbackActive: p.playbackActive,
                  playbackEligible: p.playbackEligible,
                  excludedFromWaiting: p.excludedFromWaiting,
                  readiness,
                }
              : m,
          ),
        }),
        epoch,
      );
    } else if (kind === 'command.result') {
      if (this.snapshot?.epoch !== epoch) throw new Error('Invalid result epoch.');
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
      if (!['lease_transferred', 'session_revoked'].includes(text(p.reason)))
        throw new Error('Invalid lifecycle.');
      this.active = false;
      this.events.lease(false);
      this.terminal = true;
      this.connected = false;
      this.socket?.close();
      this.events.status(
        p.reason === 'lease_transferred'
          ? 'Playback is active in another tab.'
          : 'Your room session ended.',
      );
    } else if (kind === 'server.stopping') {
      shape(p, ['reason']);
      if (p.reason !== 'shutdown') throw new Error('Invalid shutdown.');
      this.connected = false;
      this.events.status('Server is stopping. Playback paused.');
      this.socket?.close();
    } else if (kind === 'room.closed') {
      shape(p, ['roomId', 'revision']);
      id(p.roomId);
      integer(p.revision);
      this.terminal = true;
      this.connected = false;
      this.closedRoom = true;
      this.active = false;
      this.events.lease(false);
      this.events.status('Room closed.');
      this.socket?.close();
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
    this.events.error(new APIError(code).message);
    if (code === 'storage_unavailable') {
      this.connected = false;
      this.socket?.close();
    }
  }
  private upgrade(): void {
    this.terminal = true;
    this.socket?.close();
    if (!sessionStorage.getItem('ovs-protocol-reload')) {
      sessionStorage.setItem('ovs-protocol-reload', '1');
      location.reload();
    } else
      this.events.error(
        'Update required. Reload after the server and browser assets use the same version.',
      );
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
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value));
  }
  calibrate(count = 5): void {
    if (!this.connected) return;
    this.lastCalibration = performance.now();
    for (let i = 0; i < count; i++) {
      const key = requestKey(),
        at = Math.floor(performance.now());
      this.pings.set(key, at);
      this.send({ v: 1, type: 'clock.ping', requestId: key, payload: { clientSendMs: at } });
    }
    if (this.pings.size > 20) this.pings = new Map([...this.pings].slice(-20));
  }
  command(payload: Command['payload']): void {
    const s = this.snapshot;
    if (!s || !this.connected || !this.active || this.pending) {
      this.events.error('Controls need an active connection and a resolved previous command.');
      return;
    }
    const safePayload = 'media' in payload ? { media: decodeMedia(payload.media) } : payload;
    const command: Command = {
      v: 1,
      type:
        'media' in safePayload
          ? 'media.select'
          : 'memberId' in safePayload
            ? 'waiting.exclude'
            : 'playback.command',
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
    if (this.connected && this.active && this.pending?.epoch === this.snapshot?.epoch)
      this.send(this.pending);
  }
  readiness(payload: unknown): void {
    if (this.connected && this.active && this.snapshot)
      this.send({ v: 1, type: 'member.readiness', epoch: this.snapshot.epoch, payload });
  }
  activate(): void {
    if (this.closedRoom) return;
    this.terminal = false;
    if (this.connected && this.snapshot)
      this.send({
        v: 1,
        type: 'member.activate',
        requestId: requestKey(),
        epoch: this.snapshot.epoch,
      });
    else {
      this.activateAfterWelcome = true;
      this.connect();
    }
  }
  resetClock(): void {
    this.clock.reset();
    this.calibrate();
  }
  dispose(): void {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.clock.reset();
    this.pending = undefined;
  }
}
