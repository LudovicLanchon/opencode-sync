import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MessageEnvelope } from '@opencode-sync/shared';
import { RelayClient } from './relay-client.ts';
import { createState } from './state.ts';

const ROOT = '/Users/ludoviclanchon/.config/opencode/opencode-sync';
const RELAY_PORT = 4899;
const RELAY_URL = `ws://localhost:${RELAY_PORT}`;
const TIMEOUT_MS = 8_000;

interface BootstrapRoom {
  client: RelayClient;
  state: ReturnType<typeof createState>;
}

interface MpcHarness {
  client: Client;
  transport: StdioClientTransport;
}

interface PairStatus {
  connected: boolean;
  roomCode: string | null;
  peerCount: number;
  peerId: string;
  lastActivity: number | null;
  conflicts: unknown[];
}

interface SocketHarness {
  ws: WebSocket;
  messages: MessageEnvelope[];
}

let relayProcess: Bun.Subprocess | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(check: () => boolean, timeoutMs = TIMEOUT_MS, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(intervalMs);
  }
  return check();
}

async function startMcpHarness(roomCode: string): Promise<MpcHarness> {
  const client = new Client({ name: 'opencode-sync-integration-client', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['run', 'packages/mcp/src/index.ts'],
    cwd: ROOT,
    env: {
      ...process.env,
      OPENCODE_SYNC_RELAY: RELAY_URL,
      OPENCODE_SYNC_ROOM: roomCode,
    },
    stderr: 'pipe',
  });

  await client.connect(transport);
  await client.listTools();

  return { client, transport };
}

async function stopMcpHarness(harness: MpcHarness): Promise<void> {
  await harness.client.close();
  await harness.transport.close();
}

function getText(result: { content?: Array<{ text?: string }> }): string {
  return result.content?.[0]?.text ?? '';
}

async function getStatus(harness: MpcHarness): Promise<PairStatus> {
  const result = await harness.client.callTool({ name: 'pair_status', arguments: {} });
  return JSON.parse(getText(result)) as PairStatus;
}

async function waitForStatus(harness: MpcHarness, predicate: (status: PairStatus) => boolean, timeoutMs = TIMEOUT_MS): Promise<PairStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: PairStatus | null = null;

  while (Date.now() < deadline) {
    lastStatus = await getStatus(harness);
    if (predicate(lastStatus)) {
      return lastStatus;
    }
    await sleep(50);
  }

  throw new Error(`Timed out waiting for MCP status: ${JSON.stringify(lastStatus)}`);
}

async function waitForContextCount(harness: MpcHarness, expectedCount: number, timeoutMs = TIMEOUT_MS): Promise<Array<{ id: string; content: string; label?: string }>> {
  const deadline = Date.now() + timeoutMs;
  let items: Array<{ id: string; content: string; label?: string }> = [];

  while (Date.now() < deadline) {
    const result = await harness.client.callTool({ name: 'pair_context', arguments: { limit: 10 } });
    items = JSON.parse(getText(result)) as Array<{ id: string; content: string; label?: string }>;
    if (items.length >= expectedCount) {
      return items;
    }
    await sleep(50);
  }

  throw new Error(`Timed out waiting for ${expectedCount} context items. Saw ${JSON.stringify(items)}`);
}

async function bootstrapRoom(): Promise<BootstrapRoom> {
  const state = createState();
  const client = new RelayClient();
  client.connect(RELAY_URL, state);

  const connected = await waitForCondition(() => client.getConnectionState() === 'connected' || client.getConnectionState() === 'in-room');
  expect(connected).toBeTrue();

  client.send({ type: 'create', roomId: '', peerId: state.peerId, payload: {}, timestamp: Date.now() });

  const roomReady = await waitForCondition(() => state.roomInfo !== null && state.roomInfo.code.length === 6 && state.roomInfo.peers.length === 1);
  expect(roomReady).toBeTrue();

  return { client, state };
}

async function connectSocket(peerId = crypto.randomUUID()): Promise<SocketHarness> {
  const ws = new WebSocket(`${RELAY_URL}?peerId=${peerId}`);
  const harness: SocketHarness = { ws, messages: [] };

  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    try {
      harness.messages.push(JSON.parse(event.data) as MessageEnvelope);
    } catch {}
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out connecting socket ${peerId}`)), 3_000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`Failed to connect socket ${peerId}`));
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

async function waitForEnvelope(socket: SocketHarness, predicate: (message: MessageEnvelope) => boolean, timeoutMs = 3_000): Promise<MessageEnvelope> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const index = socket.messages.findIndex(predicate);
    if (index !== -1) {
      const [message] = socket.messages.splice(index, 1);
      if (message) return message;
    }
    await sleep(20);
  }

  throw new Error(`Timed out waiting for websocket message. Seen: ${JSON.stringify(socket.messages)}`);
}

async function closeSocket(socket: SocketHarness): Promise<void> {
  if (socket.ws.readyState === WebSocket.CLOSING || socket.ws.readyState === WebSocket.CLOSED) return;

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

describe('relay + MCP client integration', () => {
  it('lets two MCP clients exchange context through the relay end-to-end', async () => {
    const bootstrap = await bootstrapRoom();
    let mcpA: MpcHarness | null = null;
    let mcpB: MpcHarness | null = null;

    try {
      const roomCode = bootstrap.state.roomInfo?.code;
      expect(roomCode).toBeString();
      if (!roomCode) throw new Error('Bootstrap room code missing');

      mcpA = await startMcpHarness(roomCode);
      await waitForStatus(mcpA, (status) => status.connected && status.roomCode === roomCode && status.peerCount === 2);

      bootstrap.client.disconnect();
      await waitForStatus(mcpA, (status) => status.connected && status.roomCode === roomCode && status.peerCount === 1);

      mcpB = await startMcpHarness(roomCode);

      const [statusA, statusB] = await Promise.all([
        waitForStatus(mcpA, (status) => status.connected && status.roomCode === roomCode && status.peerCount === 2),
        waitForStatus(mcpB, (status) => status.connected && status.roomCode === roomCode && status.peerCount === 2),
      ]);

      expect(statusA.roomCode).toBe(roomCode);
      expect(statusB.roomCode).toBe(roomCode);

      const shareFromA = await mcpA.client.callTool({
        name: 'pair_share',
        arguments: { content: 'A shares src/from-a.ts', label: 'from-a' },
      });
      expect(getText(shareFromA)).toContain('Shared:');

      const itemsOnB = await waitForContextCount(mcpB, 1);
      expect(itemsOnB[0]?.label).toBe('from-a');
      expect(itemsOnB[0]?.content).toContain('src/from-a.ts');

      const shareFromB = await mcpB.client.callTool({
        name: 'pair_share',
        arguments: { content: 'B shares src/from-b.ts', label: 'from-b' },
      });
      expect(getText(shareFromB)).toContain('Shared:');

      const itemsOnA = await waitForContextCount(mcpA, 2);
      expect(itemsOnA[0]?.label).toBe('from-b');
      expect(itemsOnA[0]?.content).toContain('src/from-b.ts');

      const invalidJoiner = await connectSocket(`invalid-${crypto.randomUUID()}`);
      try {
        sendEnvelope(invalidJoiner, { type: 'join', roomId: 'ZZZZZZ', peerId: 'invalid-joiner' });
        const joinError = await waitForEnvelope(invalidJoiner, (message) => message.type === 'error');
        expect(joinError.payload).toEqual({ message: 'Room not found' });
      } finally {
        await closeSocket(invalidJoiner);
      }
    } finally {
      bootstrap.client.disconnect();
      if (mcpB) await stopMcpHarness(mcpB);
      if (mcpA) await stopMcpHarness(mcpA);
    }
  });
});
