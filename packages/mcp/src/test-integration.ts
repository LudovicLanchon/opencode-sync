import { RelayClient } from './relay-client.ts';
import { createState } from './state.ts';
import type { MpcState } from './state.ts';

const RELAY_PORT = 4899;
const RELAY_URL = `ws://localhost:${RELAY_PORT}`;
const TIMEOUT_MS = 8000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForCondition(fn: () => boolean, timeoutMs = TIMEOUT_MS, intervalMs = 50): Promise<boolean> {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (fn()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, intervalMs);
    };
    check();
  });
}

async function main() {
  console.log('Starting integration test...');

  const relayProc = Bun.spawn(
    ['bun', 'run', 'packages/relay/src/index.ts', '--port', String(RELAY_PORT)],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PORT: String(RELAY_PORT) },
    }
  );

  await sleep(500);

  let passed = true;
  const errors: string[] = [];

  try {
    const stateA: MpcState = createState();
    const stateB: MpcState = createState();

    const clientA = new RelayClient();
    const clientB = new RelayClient();

    clientA.connect(RELAY_URL, stateA);
    clientB.connect(RELAY_URL, stateB);

    const connectedA = await waitForCondition(() => clientA.getConnectionState() !== 'disconnected' && clientA.getConnectionState() !== 'connecting');
    const connectedB = await waitForCondition(() => clientB.getConnectionState() !== 'disconnected' && clientB.getConnectionState() !== 'connecting');

    if (!connectedA) { errors.push('Client A failed to connect'); passed = false; }
    if (!connectedB) { errors.push('Client B failed to connect'); passed = false; }

    if (!passed) throw new Error('Connection failed');

    console.log('Both clients connected');

    clientA.send({ type: 'create', roomId: '', peerId: stateA.peerId, payload: {}, timestamp: Date.now() });

    const gotRoomA = await waitForCondition(() => stateA.roomInfo !== null && stateA.roomInfo.code.length > 0);
    if (!gotRoomA) { errors.push('Client A did not receive room code'); passed = false; throw new Error(); }

    const roomCode = stateA.roomInfo!.code;
    console.log(`Client A created room: ${roomCode}`);

    clientB.send({ type: 'join', roomId: roomCode, peerId: stateB.peerId, payload: {}, timestamp: Date.now() });

    const gotRoomB = await waitForCondition(() => stateB.roomInfo !== null);
    if (!gotRoomB) { errors.push('Client B did not join room'); passed = false; throw new Error(); }

    console.log(`Client B joined room: ${roomCode}`);
    await waitForCondition(() => (stateA.roomInfo?.peers.length ?? 0) >= 2);

    const testItem = {
      id: 'test-item-1',
      peerId: stateA.peerId,
      label: 'test',
      content: 'Hello from A!',
      timestamp: Date.now(),
    };

    clientA.send({ type: 'share', roomId: roomCode, peerId: stateA.peerId, payload: testItem, timestamp: Date.now() });
    console.log('Client A sent share');

    const receivedByB = await waitForCondition(() => stateB.receivedItems.length > 0);
    if (!receivedByB) {
      errors.push('Client B did not receive shared item');
      passed = false;
    } else {
      const received = stateB.receivedItems[0]!;
      if (received.content !== testItem.content) {
        errors.push(`Content mismatch: expected "${testItem.content}", got "${received.content}"`);
        passed = false;
      } else {
        console.log(`Client B received: "${received.content}"`);
      }
    }

    clientA.disconnect();
    clientB.disconnect();
  } catch (err) {
    if (errors.length === 0) errors.push(String(err));
    passed = false;
  } finally {
    relayProc.kill();
  }

  if (passed) {
    console.log('\n✅ PASS');
    process.exit(0);
  } else {
    console.log('\n❌ FAIL');
    for (const e of errors) console.log(`  - ${e}`);
    process.exit(1);
  }
}

main();
