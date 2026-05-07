import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createState } from './state.ts';
import { relayClient, DEFAULT_RELAY_URL } from './relay-client.ts';
import type { SharedContextItem } from '@opencode-sync/shared';

const state = createState();

const relayUrl = process.env.OPENCODE_SYNC_RELAY ?? DEFAULT_RELAY_URL;
relayClient.connect(relayUrl, state);

const server = new McpServer({ name: 'opencode-sync', version: '0.1.0' });

server.tool(
  'pair_share',
  'Share a context item with your paired peer',
  { content: z.string(), label: z.string().optional() },
  async ({ content, label }) => {
    if (!state.connected) {
      return { content: [{ type: 'text', text: 'Not connected to relay. Use the relay server to pair first.' }] };
    }

    const item: SharedContextItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      peerId: state.peerId,
      label,
      content,
      timestamp: Date.now(),
    };

    try {
      relayClient.send({
        type: 'share',
        roomId: state.roomInfo?.code ?? '',
        peerId: state.peerId,
        payload: item,
        timestamp: Date.now(),
      });
      state.receivedItems.push(item);
      return { content: [{ type: 'text', text: `Shared: ${item.id}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Send failed: ${String(err)}` }] };
    }
  }
);

server.tool(
  'pair_context',
  'Get received context items from your paired peer',
  { limit: z.number().optional() },
  async ({ limit = 10 }) => {
    if (!state.connected) {
      return { content: [{ type: 'text', text: JSON.stringify({ items: [], note: 'Not connected to relay — no items received yet.' }) }] };
    }

    const items = [...state.receivedItems].reverse().slice(0, limit);
    return { content: [{ type: 'text', text: JSON.stringify(items) }] };
  }
);

server.tool(
  'pair_status',
  'Get current pairing status',
  {},
  async () => {
    const status = {
      connected: state.connected,
      roomCode: state.roomInfo?.code ?? null,
      peerCount: state.roomInfo?.peers.length ?? 0,
      peerId: state.peerId,
      lastActivity: state.receivedItems.length > 0
        ? state.receivedItems[state.receivedItems.length - 1]!.timestamp
        : null,
      conflicts: state.conflicts,
    };
    return { content: [{ type: 'text', text: JSON.stringify(status) }] };
  }
);

server.resource(
  'pair://context/latest',
  'pair://context/latest',
  async () => {
    const items = [...state.receivedItems].reverse().slice(0, 5);
    return {
      contents: [{
        uri: 'pair://context/latest',
        text: JSON.stringify(items),
        mimeType: 'application/json',
      }],
    };
  }
);

server.resource(
  'pair://status',
  'pair://status',
  async () => {
    const status = {
      connected: state.connected,
      roomCode: state.roomInfo?.code ?? null,
      peerCount: state.roomInfo?.peers.length ?? 0,
      peerId: state.peerId,
    };
    return {
      contents: [{
        uri: 'pair://status',
        text: JSON.stringify(status),
        mimeType: 'application/json',
      }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

export { state, relayClient };
