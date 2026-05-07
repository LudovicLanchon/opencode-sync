import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MessageEnvelope } from '@opencode-sync/shared';
import { MAX_MESSAGE_SIZE, ROOM_CODE_LENGTH } from '@opencode-sync/shared';

const ROOT = '/Users/ludoviclanchon/.config/opencode/opencode-sync';
const RELAY_PORT = 4897;
const RELAY_URL = `ws://localhost:${RELAY_PORT}`;
const MESSAGE_TIMEOUT_MS = 3_000;

interface SocketHarness {
  ws: WebSocket;
  messages: MessageEnvelope[];
  closes: CloseEvent[];
}

let relayProcess: Bun.Subprocess | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roomCodePattern(): RegExp {
  return new RegExp(`^[A-Z0-9]{${ROOM_CODE_LENGTH}}$`);
}

async function waitForCondition(check: () => boolean, timeoutMs = MESSAGE_TIMEOUT_MS, intervalMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(intervalMs);
  }
  return check();
}

async function connectSocket(peerId = crypto.randomUUID()): Promise<SocketHarness> {
  const ws = new WebSocket(`${RELAY_URL}?peerId=${peerId}`);
  const harness: SocketHarness = { ws, messages: [], closes: [] };

  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    try {
      harness.messages.push(JSON.parse(event.data) as MessageEnvelope);
    } catch {}
  });

  ws.addEventListener('close', (event) => {
    harness.closes.push(event);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out connecting peer ${peerId}`)), MESSAGE_TIMEOUT_MS);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`Failed connecting peer ${peerId}`));
    }, { once: true });
  });

  return harness;
}

function sendEnvelope(socket: SocketHarness, envelope: Partial<MessageEnvelope> & Pick<MessageEnvelope, 'type'>): void {
  socket.ws.send(JSON.stringify({
    roomId: '',
    peerId: 'test-peer',
    payload: {},
    timestamp: Date.now(),
    ...envelope,
  } satisfies MessageEnvelope));
}

async function waitForEnvelope(socket: SocketHarness, predicate: (message: MessageEnvelope) => boolean, timeoutMs = MESSAGE_TIMEOUT_MS): Promise<MessageEnvelope> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const index = socket.messages.findIndex(predicate);
    if (index !== -1) {
      const [message] = socket.messages.splice(index, 1);
      if (message) return message;
    }
    await sleep(20);
  }

  throw new Error(`Timed out waiting for matching message. Seen: ${JSON.stringify(socket.messages)}`);
}

async function expectNoEnvelope(socket: SocketHarness, predicate: (message: MessageEnvelope) => boolean, windowMs = 250): Promise<void> {
  await sleep(windowMs);
  const match = socket.messages.find(predicate);
  expect(match).toBeUndefined();
}

async function closeSocket(socket: SocketHarness): Promise<void> {
  if (socket.ws.readyState === WebSocket.CLOSED || socket.ws.readyState === WebSocket.CLOSING) return;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 500);
    socket.ws.addEventListener('close', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.ws.close();
  });
}

beforeAll(async () => {
  relayProcess = Bun.spawn(['bun', 'run', 'packages/relay/src/index.ts', '--port', String(RELAY_PORT)], {
    cwd: ROOT,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...process.env, PORT: String(RELAY_PORT) },
  });

  await sleep(500);
});

afterAll(async () => {
  relayProcess?.kill();
  await relayProcess?.exited;
});

describe('relay room management', () => {
  it('creates a room with a valid 6-character uppercase alphanumeric code', async () => {
    const socket = await connectSocket('create-room-peer');

    try {
      sendEnvelope(socket, { type: 'create', peerId: 'create-room-peer' });
      const status = await waitForEnvelope(socket, (message) => message.type === 'status');
      const payload = status.payload as { code: string; peerCount: number };

      expect(payload.code).toMatch(roomCodePattern());
      expect(payload.code).toHaveLength(ROOM_CODE_LENGTH);
      expect(payload.peerCount).toBe(1);
    } finally {
      await closeSocket(socket);
    }
  });

  it('joins rooms, enforces the two-peer limit, and broadcasts status updates', async () => {
    const host = await connectSocket('host-peer');
    const guest = await connectSocket('guest-peer');
    const overflow = await connectSocket('overflow-peer');

    try {
      sendEnvelope(host, { type: 'create', peerId: 'host-peer' });
      const created = await waitForEnvelope(host, (message) => message.type === 'status');
      const roomCode = (created.payload as { code: string }).code;

      sendEnvelope(guest, { type: 'join', roomId: roomCode, peerId: 'guest-peer' });

      const guestStatus = await waitForEnvelope(guest, (message) => message.type === 'status');
      const hostStatus = await waitForEnvelope(host, (message) => message.type === 'status' && (message.payload as { peerCount: number }).peerCount === 2);

      expect((guestStatus.payload as { code: string; peerCount: number }).code).toBe(roomCode);
      expect((guestStatus.payload as { peerCount: number }).peerCount).toBe(2);
      expect((hostStatus.payload as { peerCount: number }).peerCount).toBe(2);

      sendEnvelope(overflow, { type: 'join', roomId: roomCode, peerId: 'overflow-peer' });
      const error = await waitForEnvelope(overflow, (message) => message.type === 'error');

      expect(error.roomId).toBe(roomCode);
      expect(error.payload).toEqual({ message: 'Room full' });
    } finally {
      await closeSocket(overflow);
      await closeSocket(guest);
      await closeSocket(host);
    }
  });

  it('relays share messages to the other peer and excludes the sender', async () => {
    const sender = await connectSocket('sender-peer');
    const receiver = await connectSocket('receiver-peer');

    try {
      sendEnvelope(sender, { type: 'create', peerId: 'sender-peer' });
      const created = await waitForEnvelope(sender, (message) => message.type === 'status');
      const roomCode = (created.payload as { code: string }).code;

      sendEnvelope(receiver, { type: 'join', roomId: roomCode, peerId: 'receiver-peer' });
      await waitForEnvelope(receiver, (message) => message.type === 'status');
      await waitForEnvelope(sender, (message) => message.type === 'status' && (message.payload as { peerCount: number }).peerCount === 2);

      const payload = { label: 'spec', content: 'shared context' };
      sendEnvelope(sender, {
        type: 'share',
        roomId: roomCode,
        peerId: 'sender-peer',
        payload,
      });

      const relayed = await waitForEnvelope(receiver, (message) => message.type === 'share');
      expect(relayed.peerId).toBe('sender-peer');
      expect(relayed.roomId).toBe(roomCode);
      expect(relayed.payload).toEqual(payload);

      await expectNoEnvelope(sender, (message) => message.type === 'share');
    } finally {
      await closeSocket(receiver);
      await closeSocket(sender);
    }
  });

  it('cleans up rooms on disconnect and deletes empty rooms', async () => {
    const host = await connectSocket('cleanup-host');
    const guest = await connectSocket('cleanup-guest');
    const lateJoiner = await connectSocket('late-joiner');

    try {
      sendEnvelope(host, { type: 'create', peerId: 'cleanup-host' });
      const created = await waitForEnvelope(host, (message) => message.type === 'status');
      const roomCode = (created.payload as { code: string }).code;

      sendEnvelope(guest, { type: 'join', roomId: roomCode, peerId: 'cleanup-guest' });
      await waitForEnvelope(guest, (message) => message.type === 'status');
      await waitForEnvelope(host, (message) => message.type === 'status' && (message.payload as { peerCount: number }).peerCount === 2);

      await closeSocket(guest);

      const hostAfterDisconnect = await waitForEnvelope(host, (message) => message.type === 'status' && (message.payload as { peerCount: number }).peerCount === 1);
      expect((hostAfterDisconnect.payload as { code: string; peerCount: number }).code).toBe(roomCode);
      expect((hostAfterDisconnect.payload as { peerCount: number }).peerCount).toBe(1);

      await closeSocket(host);
      await sleep(100);

      sendEnvelope(lateJoiner, { type: 'join', roomId: roomCode, peerId: 'late-joiner' });
      const missingRoom = await waitForEnvelope(lateJoiner, (message) => message.type === 'error');
      expect(missingRoom.payload).toEqual({ message: 'Room not found' });
    } finally {
      await closeSocket(lateJoiner);
      await closeSocket(guest);
      await closeSocket(host);
    }
  });
});

describe('relay edge cases', () => {
  it('returns an error for an invalid room code', async () => {
    const socket = await connectSocket('invalid-room-peer');

    try {
      sendEnvelope(socket, { type: 'join', roomId: 'BAD999', peerId: 'invalid-room-peer' });
      const error = await waitForEnvelope(socket, (message) => message.type === 'error');

      expect(error.roomId).toBe('BAD999');
      expect(error.payload).toEqual({ message: 'Room not found' });
    } finally {
      await closeSocket(socket);
    }
  });

  it('rejects oversized websocket messages', async () => {
    const socket = await connectSocket('oversized-peer');

    try {
      const oversizedEnvelope = JSON.stringify({
        type: 'create',
        roomId: '',
        peerId: 'oversized-peer',
        payload: { blob: 'x'.repeat(MAX_MESSAGE_SIZE + 1_024) },
        timestamp: Date.now(),
      } satisfies MessageEnvelope);

      socket.ws.send(oversizedEnvelope);

      const rejected = await waitForCondition(
        () => socket.closes.length > 0 || socket.messages.some((message) => message.type === 'error'),
        MESSAGE_TIMEOUT_MS,
      );

      expect(rejected).toBeTrue();

      const errorMessage = socket.messages.find((message) => message.type === 'error');
      if (errorMessage) {
        expect((errorMessage.payload as { message: string }).message).toContain('Message too large');
      } else {
        expect(socket.closes.length).toBeGreaterThan(0);
      }
    } finally {
      await closeSocket(socket);
    }
  });
});
