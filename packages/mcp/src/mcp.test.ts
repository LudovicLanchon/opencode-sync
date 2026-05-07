import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MessageEnvelope } from '@opencode-sync/shared';
import { CONFLICT_EXPIRY_MS, CONFLICT_WINDOW_MS } from '@opencode-sync/shared';
import { conflictDetector, extractFilePaths } from './conflict-detector.ts';

const ROOT = '/Users/ludoviclanchon/.config/opencode/opencode-sync';
const RELAY_PORT = 4898;
const RELAY_URL = `ws://localhost:${RELAY_PORT}`;
const TOOL_TIMEOUT_MS = 8_000;

interface MpcHarness {
  client: Client;
  transport: StdioClientTransport;
}

interface SocketHarness {
  ws: WebSocket;
  messages: MessageEnvelope[];
}

let relayProcess: Bun.Subprocess | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectSocket(peerId = crypto.randomUUID()): Promise<SocketHarness> {
  const ws = new WebSocket(`${RELAY_URL}?peerId=${peerId}`);
  const socket: SocketHarness = { ws, messages: [] };

  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    try {
      socket.messages.push(JSON.parse(event.data) as MessageEnvelope);
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

  return socket;
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

  throw new Error(`Timed out waiting for socket message. Seen: ${JSON.stringify(socket.messages)}`);
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

async function startMcpHarness(env: Record<string, string | undefined>): Promise<MpcHarness> {
  const client = new Client({ name: 'opencode-sync-test-client', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['run', 'packages/mcp/src/index.ts'],
    cwd: ROOT,
    env,
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

function getText(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return result.content?.[0]?.text ?? '';
}

async function waitForPairStatus(
  harness: MpcHarness,
  predicate: (status: {
    connected: boolean;
    roomCode: string | null;
    peerCount: number;
    peerId: string;
    conflicts: unknown[];
    lastActivity?: number | null;
  }) => boolean,
  timeoutMs = TOOL_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const statusResult = await harness.client.callTool({ name: 'pair_status', arguments: {} });
    const parsed = JSON.parse(getText(statusResult)) as {
      connected: boolean;
      roomCode: string | null;
      peerCount: number;
      peerId: string;
      conflicts: unknown[];
      lastActivity?: number | null;
    };

    if (predicate(parsed)) {
      return true;
    }

    await sleep(50);
  }

  return false;
}

async function startJoinedMcpHarness() {
  const host = await connectSocket(`host-${crypto.randomUUID()}`);
  sendEnvelope(host, { type: 'create', peerId: 'host-peer' });
  const created = await waitForEnvelope(host, (message) => message.type === 'status');
  const roomCode = (created.payload as { code: string }).code;

  const harness = await startMcpHarness({
    ...process.env,
    OPENCODE_SYNC_RELAY: RELAY_URL,
    OPENCODE_SYNC_ROOM: roomCode,
  });

  const connected = await waitForPairStatus(
    harness,
    (status) => status.connected && status.roomCode === roomCode && status.peerCount === 2,
  );

  expect(connected).toBeTrue();

  return { harness, host, roomCode };
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

describe('MCP tool handlers', () => {
  it('gracefully degrades when the relay is down', async () => {
    const harness = await startMcpHarness({
      ...process.env,
      OPENCODE_SYNC_RELAY: 'ws://localhost:5998',
    });

    try {
      await sleep(250);

      const shareResult = await harness.client.callTool({
        name: 'pair_share',
        arguments: { content: 'hello from offline client', label: 'offline' },
      });
      const contextResult = await harness.client.callTool({ name: 'pair_context', arguments: {} });
      const statusResult = await harness.client.callTool({ name: 'pair_status', arguments: {} });

      expect(getText(shareResult)).toContain('Not connected to relay');

      const context = JSON.parse(getText(contextResult)) as { items: unknown[]; note: string };
      expect(context.items).toEqual([]);
      expect(context.note).toContain('Not connected to relay');

      const status = JSON.parse(getText(statusResult)) as { connected: boolean; roomCode: string | null };
      expect(status.connected).toBeFalse();
      expect(status.roomCode).toBeNull();
    } finally {
      await stopMcpHarness(harness);
    }
  });

  it('shares context locally when connected and returns items in reverse chronological order', async () => {
    const { harness, host } = await startJoinedMcpHarness();

    try {
      const firstShare = await harness.client.callTool({
        name: 'pair_share',
        arguments: { content: 'first item src/alpha.ts', label: 'first' },
      });
      await sleep(10);
      const secondShare = await harness.client.callTool({
        name: 'pair_share',
        arguments: { content: 'second item src/beta.ts', label: 'second' },
      });

      expect(getText(firstShare)).toContain('Shared:');
      expect(getText(secondShare)).toContain('Shared:');

      const contextResult = await harness.client.callTool({ name: 'pair_context', arguments: { limit: 2 } });
      const items = JSON.parse(getText(contextResult)) as Array<{ label?: string; content: string }>;

      expect(items).toHaveLength(2);
      expect(items[0]?.label).toBe('second');
      expect(items[0]?.content).toContain('second item');
      expect(items[1]?.label).toBe('first');
      expect(items[1]?.content).toContain('first item');

      const latestResource = await harness.client.readResource({ uri: 'pair://context/latest' });
      const latestItems = JSON.parse(latestResource.contents[0]?.text ?? '[]') as Array<{ label?: string }>;
      expect(latestItems[0]?.label).toBe('second');
    } finally {
      await stopMcpHarness(harness);
      await closeSocket(host);
    }
  });

  it('reports connected room status once paired', async () => {
    const { harness, host, roomCode } = await startJoinedMcpHarness();

    try {
      const statusResult = await harness.client.callTool({ name: 'pair_status', arguments: {} });
      const status = JSON.parse(getText(statusResult)) as {
        connected: boolean;
        roomCode: string | null;
        peerCount: number;
        peerId: string;
        conflicts: unknown[];
      };

      expect(status.connected).toBeTrue();
      expect(status.roomCode).toBe(roomCode);
      expect(status.peerCount).toBe(2);
      expect(status.peerId).toStartWith('peer-');
      expect(status.conflicts).toEqual([]);

      const statusResource = await harness.client.readResource({ uri: 'pair://status' });
      const resourceStatus = JSON.parse(statusResource.contents[0]?.text ?? '{}') as { connected: boolean; roomCode: string | null; peerCount: number };
      expect(resourceStatus.connected).toBeTrue();
      expect(resourceStatus.roomCode).toBe(roomCode);
      expect(resourceStatus.peerCount).toBe(2);
    } finally {
      await stopMcpHarness(harness);
      await closeSocket(host);
    }
  });
});

describe('conflict detector', () => {
  it('extracts file paths from content', () => {
    const paths = extractFilePaths('Updated ./src/index.ts, /tmp/data.yaml, docs/guide.md, and src/index.ts again');
    expect(paths).toEqual(['./src/index.ts', '/tmp/data.yaml', 'docs/guide.md', 'src/index.ts']);
  });

  it('detects cross-peer conflicts within the conflict window and ignores same-peer reshares', () => {
    const originalDateNow = Date.now;

    try {
      Date.now = () => 1_000;
      const samePeer = conflictDetector.record('peer-a', 'Touched src/conflict-window.ts');
      expect(samePeer).toEqual([]);

      Date.now = () => 1_000 + CONFLICT_WINDOW_MS - 1;
      const samePeerReshare = conflictDetector.record('peer-a', 'Touched src/conflict-window.ts again');
      expect(samePeerReshare).toEqual([]);

      Date.now = () => 1_500 + CONFLICT_WINDOW_MS - 1;
      const crossPeer = conflictDetector.record('peer-b', 'Touched src/conflict-window.ts from another peer');
      expect(crossPeer).toHaveLength(1);
      expect(crossPeer[0]?.filePath).toBe('src/conflict-window.ts');
      expect(crossPeer[0]?.peers).toEqual(['peer-b', 'peer-a']);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('filters expired conflicts from the active set', () => {
    const originalDateNow = Date.now;

    try {
      Date.now = () => 10_000 + CONFLICT_EXPIRY_MS + 1;

      const active = conflictDetector.getActive([
        {
          filePath: 'src/fresh.ts',
          peers: ['peer-a', 'peer-b'],
          detectedAt: Date.now() - CONFLICT_EXPIRY_MS + 100,
        },
        {
          filePath: 'src/stale.ts',
          peers: ['peer-c', 'peer-d'],
          detectedAt: Date.now() - CONFLICT_EXPIRY_MS - 100,
        },
      ]);

      expect(active).toEqual([
        {
          filePath: 'src/fresh.ts',
          peers: ['peer-a', 'peer-b'],
          detectedAt: Date.now() - CONFLICT_EXPIRY_MS + 100,
        },
      ]);
    } finally {
      Date.now = originalDateNow;
    }
  });
});
