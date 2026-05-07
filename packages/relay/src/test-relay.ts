import { spawn } from 'bun';

const PORT = 4899;
const SERVER_URL = `ws://localhost:${PORT}`;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const serverProc = spawn(['bun', 'packages/relay/src/index.ts', '--port', String(PORT)], {
  stdout: 'pipe',
  stderr: 'pipe',
  cwd: new URL('../../..', import.meta.url).pathname,
});

await sleep(500);

let passed = false;
let errorMsg = '';

try {
  const peerA = 'peer-a-' + crypto.randomUUID();
  const peerB = 'peer-b-' + crypto.randomUUID();

  const wsA = new WebSocket(`${SERVER_URL}?peerId=${peerA}`);
  const wsB = new WebSocket(`${SERVER_URL}?peerId=${peerB}`);

  await new Promise<void>((resolve, reject) => {
    let openCount = 0;
    const onOpen = () => { if (++openCount === 2) resolve(); };
    wsA.onopen = onOpen;
    wsB.onopen = onOpen;
    wsA.onerror = wsB.onerror = (e) => reject(new Error('WebSocket connection failed'));
    setTimeout(() => reject(new Error('Timeout opening connections')), 3000);
  });

  let roomCode = '';

  const createPromise = new Promise<void>((resolve, reject) => {
    wsA.onmessage = (e) => {
      const msg = JSON.parse(e.data as string);
      if (msg.type === 'status' && msg.payload?.code) {
        roomCode = msg.payload.code;
        resolve();
      } else {
        reject(new Error(`Unexpected message: ${JSON.stringify(msg)}`));
      }
    };
    setTimeout(() => reject(new Error('Timeout waiting for create response')), 3000);
  });

  wsA.send(JSON.stringify({ type: 'create', roomId: '', peerId: peerA, payload: {}, timestamp: Date.now() }));
  await createPromise;

  if (!roomCode) throw new Error('No room code received');

  const joinPromise = new Promise<void>((resolve, reject) => {
    let statusCount = 0;
    const checkDone = () => { if (++statusCount >= 2) resolve(); };
    wsB.onmessage = (e) => {
      const msg = JSON.parse(e.data as string);
      if (msg.type === 'status') checkDone();
      else reject(new Error(`Unexpected B message: ${JSON.stringify(msg)}`));
    };
    wsA.onmessage = (e) => {
      const msg = JSON.parse(e.data as string);
      if (msg.type === 'status') checkDone();
      else reject(new Error(`Unexpected A message: ${JSON.stringify(msg)}`));
    };
    setTimeout(() => reject(new Error('Timeout waiting for join')), 3000);
  });

  wsB.send(JSON.stringify({ type: 'join', roomId: roomCode, peerId: peerB, payload: {}, timestamp: Date.now() }));
  await joinPromise;

  const testPayload = { hello: 'world', value: 42 };
  const receivePromise = new Promise<void>((resolve, reject) => {
    wsB.onmessage = (e) => {
      const msg = JSON.parse(e.data as string);
      if (msg.type === 'share' && JSON.stringify(msg.payload) === JSON.stringify(testPayload)) {
        resolve();
      } else {
        reject(new Error(`Unexpected share message: ${JSON.stringify(msg)}`));
      }
    };
    setTimeout(() => reject(new Error('Timeout waiting for share message')), 3000);
  });

  wsA.send(JSON.stringify({ type: 'share', roomId: roomCode, peerId: peerA, payload: testPayload, timestamp: Date.now() }));
  await receivePromise;

  wsA.close();
  wsB.close();
  passed = true;
} catch (e) {
  errorMsg = String(e);
} finally {
  serverProc.kill();
}

if (passed) {
  console.log('RELAY TEST PASSED: two clients connected, message relayed successfully');
  process.exit(0);
} else {
  console.error('RELAY TEST FAILED:', errorMsg);
  process.exit(1);
}
