// Room message types
export type RoomMessageType = 'join' | 'leave' | 'share' | 'status' | 'error' | 'conflict' | 'create' | 'ping' | 'pong';

// Main message envelope sent over WebSocket
export interface MessageEnvelope {
  type: RoomMessageType;
  roomId: string;
  peerId: string;
  payload: unknown;
  timestamp: number;
}

// A chunk of shared context
export interface SharedContextItem {
  id: string;
  peerId: string;
  label?: string;
  content: string;
  timestamp: number;
}

// Peer in a room
export interface PeerInfo {
  id: string;
  name?: string;
  joinedAt: number;
}

// Room state
export interface RoomInfo {
  code: string;
  peers: PeerInfo[];
  createdAt: number;
}

// Conflict notification when both peers edit same file
export interface ConflictNotification {
  filePath: string;
  peers: string[]; // peer IDs
  detectedAt: number;
}

// Room code: 6-char uppercase alphanumeric
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// Max WebSocket message size: 100KB
export const MAX_MESSAGE_SIZE = 100 * 1024;

// Heartbeat interval: 30s
export const HEARTBEAT_INTERVAL_MS = 30_000;

// Max peers per room
export const MAX_PEERS_PER_ROOM = 2;

// Conflict detection window: 60s
export const CONFLICT_WINDOW_MS = 60_000;

// Conflict expiry: 5 minutes
export const CONFLICT_EXPIRY_MS = 5 * 60_000;
