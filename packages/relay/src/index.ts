import type { ServerWebSocket } from 'bun';
import {
  type MessageEnvelope,
  type RoomMessageType,
  ROOM_CODE_LENGTH,
  ROOM_CODE_CHARS,
  MAX_MESSAGE_SIZE,
  HEARTBEAT_INTERVAL_MS,
  MAX_PEERS_PER_ROOM,
} from '@opencode-sync/shared';

interface WsData {
  peerId: string;
  roomId: string | null;
  lastPong: number;
}

interface Room {
  code: string;
  peers: Map<string, ServerWebSocket<WsData>>;
}

const rooms = new Map<string, Room>();

function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function makeUniqueRoomCode(): string {
  let code = generateRoomCode();
  while (rooms.has(code)) {
    code = generateRoomCode();
  }
  return code;
}

function respond(ws: ServerWebSocket<WsData>, type: RoomMessageType, roomId: string, peerId: string, payload: unknown): void {
  const msg: MessageEnvelope = { type, roomId, peerId, payload, timestamp: Date.now() };
  ws.send(JSON.stringify(msg));
}

function leaveRoom(ws: ServerWebSocket<WsData>): void {
  const { peerId, roomId } = ws.data;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) {
    ws.data.roomId = null;
    return;
  }

  room.peers.delete(peerId);
  ws.data.roomId = null;

  for (const [otherPeerId, peer] of room.peers) {
    respond(peer, 'status', roomId, otherPeerId, { code: roomId, peerCount: room.peers.size });
  }

  if (room.peers.size === 0) {
    rooms.delete(roomId);
  }
}

const server = Bun.serve<WsData>({
    port: (() => {
      const argIdx = process.argv.indexOf('--port');
    if (argIdx !== -1 && process.argv[argIdx + 1]) {
      return parseInt(process.argv[argIdx + 1], 10);
    }
    return parseInt(process.env.PORT ?? '4800', 10);
  })(),

  fetch(req, srv) {
    const url = new URL(req.url);
    const peerId = url.searchParams.get('peerId') ?? crypto.randomUUID();

    const upgraded = srv.upgrade(req, {
      data: { peerId, roomId: null, lastPong: Date.now() } satisfies WsData,
    });
    if (upgraded) return undefined;
    return new Response('Not a WebSocket request', { status: 400 });
  },

  websocket: {
    maxPayloadLength: MAX_MESSAGE_SIZE,

    message(ws, raw) {
      let envelope: MessageEnvelope;
      try {
        if (typeof raw !== 'string') {
          respond(ws, 'error', '', ws.data.peerId, { message: 'Binary messages not supported' });
          return;
        }
        if (raw.length > MAX_MESSAGE_SIZE) {
          respond(ws, 'error', '', ws.data.peerId, { message: 'Message too large' });
          return;
        }
        envelope = JSON.parse(raw) as MessageEnvelope;
      } catch {
        respond(ws, 'error', '', ws.data.peerId, { message: 'Invalid JSON' });
        return;
      }

      const { type, roomId, peerId } = envelope;

      const senderPeerId = ws.data.peerId || peerId;

      switch (type) {
        case 'create': {
          if (ws.data.roomId) {
            respond(ws, 'error', ws.data.roomId, senderPeerId, { message: 'Already in a room' });
            return;
          }
          const code = makeUniqueRoomCode();
          const room: Room = { code, peers: new Map([[senderPeerId, ws]]) };
          rooms.set(code, room);
          ws.data.roomId = code;
          respond(ws, 'status', code, senderPeerId, { code, peerCount: 1 });
          break;
        }

        case 'join': {
          if (ws.data.roomId) {
            respond(ws, 'error', ws.data.roomId, senderPeerId, { message: 'Already in a room' });
            return;
          }
          const room = rooms.get(roomId);
          if (!room) {
            respond(ws, 'error', roomId, senderPeerId, { message: 'Room not found' });
            return;
          }
          if (room.peers.size >= MAX_PEERS_PER_ROOM) {
            respond(ws, 'error', roomId, senderPeerId, { message: 'Room full' });
            return;
          }
          room.peers.set(senderPeerId, ws);
          ws.data.roomId = roomId;

          respond(ws, 'status', roomId, senderPeerId, { code: roomId, peerCount: room.peers.size });

          for (const [existingPeerId, peer] of room.peers) {
            if (existingPeerId !== senderPeerId) {
              respond(peer, 'status', roomId, existingPeerId, { code: roomId, peerCount: room.peers.size });
            }
          }
          break;
        }

        case 'leave': {
          leaveRoom(ws);
          break;
        }

        case 'share': {
          const currentRoomId = ws.data.roomId;
          if (!currentRoomId) {
            respond(ws, 'error', '', senderPeerId, { message: 'Not in a room' });
            return;
          }
          const room = rooms.get(currentRoomId);
          if (!room) {
            respond(ws, 'error', currentRoomId, senderPeerId, { message: 'Room not found' });
            return;
          }
          const outgoing: MessageEnvelope = {
            type: 'share',
            roomId: currentRoomId,
            peerId: senderPeerId,
            payload: envelope.payload,
            timestamp: envelope.timestamp,
          };
          const serialized = JSON.stringify(outgoing);
          for (const [pId, peer] of room.peers) {
            if (pId !== senderPeerId) {
              peer.send(serialized);
            }
          }
          break;
        }

        case 'ping': {
          ws.data.lastPong = Date.now();
          respond(ws, 'pong', ws.data.roomId ?? '', senderPeerId, {});
          break;
        }

        case 'pong': {
          ws.data.lastPong = Date.now();
          break;
        }

        default: {
          respond(ws, 'error', '', senderPeerId, { message: `Unknown message type: ${type}` });
        }
      }
    },

    open(ws) {
      ws.data.lastPong = Date.now();
    },

    close(ws) {
      leaveRoom(ws);
    },

    error(ws) {
      leaveRoom(ws);
    },
  },
});

console.log('Relay server listening on port', server.port);

setInterval(() => {
  const now = Date.now();
  const staleThreshold = HEARTBEAT_INTERVAL_MS + 10_000;

  for (const room of rooms.values()) {
    for (const [peerId, ws] of room.peers) {
      if (now - ws.data.lastPong > staleThreshold) {
        console.log(`Disconnecting stale peer ${peerId}`);
        ws.close(1001, 'Heartbeat timeout');
      } else {
        respond(ws, 'ping', room.code, peerId, {});
      }
    }
  }
}, HEARTBEAT_INTERVAL_MS);
