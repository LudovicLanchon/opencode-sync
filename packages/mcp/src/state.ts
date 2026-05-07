import type { SharedContextItem, ConflictNotification, RoomInfo } from '@opencode-sync/shared';

export interface MpcState {
  roomInfo: RoomInfo | null;
  peerId: string;
  peerName?: string;
  receivedItems: SharedContextItem[]; // most recent last
  conflicts: ConflictNotification[];
  connected: boolean;
  relayUrl: string | null;
}

export function createState(): MpcState {
  return {
    roomInfo: null,
    peerId: generatePeerId(),
    peerName: undefined,
    receivedItems: [],
    conflicts: [],
    connected: false,
    relayUrl: null,
  };
}

function generatePeerId(): string {
  return `peer-${Math.random().toString(36).slice(2, 10)}`;
}
