import { defaultSettings } from '../transport/api';

// Synthetic room and socket fakes shared by component and transport tests.
export const roomFixture = {
  roomId: 'b'.repeat(32),
  title: 'Private room',
  epoch: 'c'.repeat(32),
  revision: 1,
  hostMemberId: 'd'.repeat(32),
  selfMemberId: 'd'.repeat(32),
  settings: defaultSettings(),
  mediaGeneration: 0,
  media: null,
  barrier: null,
  serverNowMs: 100,
  playback: { phase: 'empty', positionMs: 0, anchorServerMs: 0, desiredPlaying: false },
  members: [
    {
      memberId: 'd'.repeat(32),
      displayName: 'Guest',
      role: 'host',
      presence: 'offline',
      readiness: null,
    },
  ],
};

// FakeSocket records connections; tests drive welcome, lifecycle frames, and closure.
export class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  private sequence = 0;
  constructor(readonly url: URL) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  frame(type: string, payload: unknown, epoch = roomFixture.epoch): void {
    this.onmessage?.({
      data: JSON.stringify({ v: 2, type, epoch, eventSeq: ++this.sequence, payload }),
    });
  }
  welcome(): void {
    this.readyState = 1;
    this.frame('session.welcome', { connectionId: 'e'.repeat(32), snapshot: roomFixture });
  }
}
