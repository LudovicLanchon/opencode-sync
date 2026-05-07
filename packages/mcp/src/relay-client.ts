import type { MessageEnvelope, SharedContextItem, ConflictNotification } from '@opencode-sync/shared';
import type { MpcState } from './state.ts';

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'in-room';

const DEFAULT_RELAY_URL = 'ws://localhost:4800';
const MAX_RECONNECT_ATTEMPTS = 3;

class RelayClient {
  private ws: WebSocket | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private state: MpcState | null = null;

  connect(relayUrl: string, state: MpcState): void {
    this.state = state;
    this.connectionState = 'connecting';
    state.relayUrl = relayUrl;
    this.openWebSocket(relayUrl);
  }

  disconnect(): void {
    this.reconnectAttempts = MAX_RECONNECT_ATTEMPTS;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connectionState = 'disconnected';
    if (this.state) {
      this.state.connected = false;
    }
  }

  send(msg: MessageEnvelope): void {
    if (!this.ws || this.connectionState === 'disconnected' || this.connectionState === 'connecting') {
      throw new Error('Not connected to relay');
    }
    this.ws.send(JSON.stringify(msg));
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  private openWebSocket(relayUrl: string): void {
    try {
      this.ws = new WebSocket(relayUrl);
    } catch {
      this.handleDisconnect();
      return;
    }

    this.ws.addEventListener('open', () => {
      this.connectionState = 'connected';
      this.reconnectAttempts = 0;
      if (this.state) {
        this.state.connected = true;
      }
    });

    this.ws.addEventListener('message', (event: MessageEvent) => {
      this.handleMessage(event.data as string);
    });

    this.ws.addEventListener('close', () => {
      this.handleDisconnect();
    });

    this.ws.addEventListener('error', () => {
      this.handleDisconnect();
    });
  }

  private handleMessage(raw: string): void {
    if (!this.state) return;

    let envelope: MessageEnvelope;
    try {
      envelope = JSON.parse(raw) as MessageEnvelope;
    } catch {
      return;
    }

    if (envelope.type === 'share') {
      const item = envelope.payload as SharedContextItem;
      this.state.receivedItems.push(item);
    } else if (envelope.type === 'conflict') {
      const conflict = envelope.payload as ConflictNotification;
      this.state.conflicts.push(conflict);
    } else if (envelope.type === 'join' || envelope.type === 'create') {
      this.connectionState = 'in-room';
    } else if (envelope.type === 'leave') {
      if (envelope.peerId !== this.state.peerId && this.state.roomInfo) {
        this.state.roomInfo.peers = this.state.roomInfo.peers.filter(p => p.id !== envelope.peerId);
      }
    }
  }

  private handleDisconnect(): void {
    if (this.state) {
      this.state.connected = false;
    }
    this.connectionState = 'disconnected';
    this.ws = null;

    if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS && this.state?.relayUrl) {
      const delay = Math.pow(2, this.reconnectAttempts) * 1000;
      this.reconnectAttempts++;
      setTimeout(() => {
        if (this.state?.relayUrl) {
          this.connectionState = 'connecting';
          this.openWebSocket(this.state.relayUrl);
        }
      }, delay);
    }
  }
}

export const relayClient = new RelayClient();
export { DEFAULT_RELAY_URL };
