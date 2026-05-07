# opencode-sync

**AI-powered pair programming context sharing for opencode sessions**

opencode-sync enables real-time context sharing between two developers working in opencode, powered by the Model Context Protocol (MCP). Share session data, receive context updates, and detect editing conflicts with automatic synchronization.

## Architecture

```
┌─────────────────────┐                    ┌─────────────────────┐
│    Developer A      │                    │    Developer B      │
│  (opencode + MCP)   │                    │  (opencode + MCP)   │
└──────────┬──────────┘                    └──────────┬──────────┘
           │                                          │
           │        ┌──────────────────┐              │
           └────────│  WebSocket Relay │──────────────┘
                    │   (2 peers max)  │
                    └──────────────────┘
                            │
                    ┌───────┴────────┐
              Room A         Room B
            (in-memory)   (in-memory)
```

## Quickstart

### 1. Start the relay server

```bash
opencode-sync relay
```

The server listens on `ws://localhost:4800` by default. Customize the port:

```bash
opencode-sync relay --port 9000
```

### 2. Join a room

On Developer A's machine:

```bash
opencode-sync join ABC123
```

This outputs MCP configuration JSON. Save it to your opencode config file.

### 3. Configure opencode

Add the output from step 2 to your opencode `AGENTS.md` or `.opencode/config.json`. Restart opencode and the MCP server connects automatically.

## CLI Reference

### `opencode-sync relay`

Start the WebSocket relay server.

**Syntax:**
```
opencode-sync relay [--port <port>]
```

**Options:**
- `--port <port>` — Listening port (default: 4800)
- `--help, -h` — Show help

**Examples:**
```bash
# Default port 4800
opencode-sync relay

# Custom port
opencode-sync relay --port 9000
```

### `opencode-sync join <room-code>`

Output MCP server configuration for joining a pairing session.

**Syntax:**
```
opencode-sync join <room-code> [--relay <url>]
```

**Options:**
- `<room-code>` — 6-character room identifier (e.g., `ABC123`)
- `--relay <url>` — WebSocket relay URL (default: `ws://localhost:4800`)
- `--help, -h` — Show help

**Examples:**
```bash
# Join room on local relay
opencode-sync join ABC123

# Join room on remote relay
opencode-sync join ABC123 --relay ws://relay.example.com:4800
```

**Output:**
```json
{
  "mcpServers": {
    "opencode-sync": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "opencode-sync/packages/mcp/src/index.ts"],
      "env": {
        "OPENCODE_SYNC_RELAY": "ws://localhost:4800",
        "OPENCODE_SYNC_ROOM": "ABC123"
      }
    }
  }
}
```

## Configuration

### Environment Variables

Set these when configuring the MCP server:

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_SYNC_RELAY` | `ws://localhost:4800` | WebSocket relay server URL |
| `OPENCODE_SYNC_ROOM` | (required) | 6-character room code to join |

### MCP Tools

The opencode-sync MCP server exposes three tools:

#### `pair_share`

Share a context item with your paired peer.

**Parameters:**
- `content` (string, required) — Text to share
- `label` (string, optional) — Brief label for the context

**Example:**
```
pair_share("Here's the error log", label="Error Log")
```

#### `pair_context`

Retrieve received context items from your peer.

**Parameters:**
- `limit` (number, optional) — Max items to return (default: 10)

**Returns:** JSON array of shared context items

#### `pair_status`

Get current pairing session status.

**Returns:** JSON object with:
- `connected` — Whether connected to relay
- `roomCode` — Current room identifier
- `peerCount` — Number of peers in room (max 2)
- `peerId` — Your peer identifier
- `lastActivity` — Timestamp of last received item
- `conflicts` — Array of detected editing conflicts

### MCP Resources

Resources provide read-only access to pairing data:

| Resource | Returns |
|---|---|
| `pair://context/latest` | Last 5 shared context items as JSON |
| `pair://status` | Current pairing session status as JSON |

## How It Works

1. **Room creation**: One peer creates a room on the relay server; the relay generates a 6-character code.
2. **Joining**: The other peer joins using the room code.
3. **Context sharing**: Both peers send context items (code snippets, logs, etc.) through the relay.
4. **Conflict detection**: If both peers edit the same file within 60 seconds, a conflict is recorded and reported.
5. **Room lifecycle**: When all peers leave, the room is destroyed and its data cleared.

The relay maintains only in-memory state. All data is ephemeral.

## Limitations

- **2 peers maximum** per room. Trying to add a third peer fails with "Room full".
- **No persistence**. Rooms and data exist only while peers are connected.
- **No authentication**. Room codes are 6-digit alphanumeric identifiers. Treat them like passwords.
- **No encryption**. Communication is unencrypted over WebSocket. Use only on trusted networks.
- **100 KB message limit**. Larger payloads are rejected.
- **30-second heartbeat**. Peers must respond to pings or disconnect after 40 seconds of silence.

## Future Work

- Support more than 2 peers per room
- Persistent room storage with optional database backend
- TLS/WSS encryption for relay connections
- Conflict resolution strategies (merge, pick side, etc.)
- Session history and recovery
- Multi-relay federation for geographic distribution
- Advanced conflict detection (AST-aware, language-specific)
- API rate limiting and quotas
- Admin dashboard for relay monitoring
- Comprehensive test suite and benchmarks

## Prerequisites

- **Bun** (v1.0 or later) — Runtime for TypeScript execution
- **Node.js** (v18+) — For npm package compatibility, if needed

## Installation

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Run tests
bun test
```

## License

MIT, 2026 — LudovicLanchon
