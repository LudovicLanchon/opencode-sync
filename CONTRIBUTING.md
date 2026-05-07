# Contributing to opencode-sync

Thanks for your interest in contributing to opencode-sync. This guide covers development setup, package structure, and contribution workflow.

## Development Setup

### Prerequisites

- **Bun** (v1.0+) — Install from https://bun.sh
- **Node.js** (v18+) — For compatibility checks

### Installation

```bash
# Clone the repository
git clone https://github.com/LudovicLanchon/opencode-sync.git
cd opencode-sync

# Install dependencies
bun install

# Build all packages
bun run build

# Run tests
bun test
```

## Package Structure

opencode-sync is organized as a monorepo with three packages:

### `packages/shared`

Contains types and constants shared across all packages.

- **`src/types.ts`** — Protocol types, room codes, limits, constants
- **Exports:** All TypeScript types used by relay and MCP packages

### `packages/relay`

WebSocket relay server that manages rooms and peer communication.

- **`src/index.ts`** — Main Bun WebSocket server
- **Key features:**
  - Room management (create, join, leave)
  - Peer-to-peer message routing
  - Heartbeat/ping-pong for connection health
  - Max 2 peers per room
  - 100 KB message size limit
  - In-memory only (no persistence)

**Running the relay in development:**
```bash
cd packages/relay
bun run src/index.ts --port 4800
```

### `packages/mcp`

Model Context Protocol server that connects opencode to the relay.

- **`src/index.ts`** — MCP server entry point
- **`src/cli.ts`** — Command-line interface
- **`src/relay-client.ts`** — WebSocket client for relay communication
- **`src/conflict-detector.ts`** — Conflict detection logic
- **`src/state.ts`** — Local session state management

**Tools exposed:**
- `pair_share` — Send context to peer
- `pair_context` — Receive context from peer
- `pair_status` — Session status and conflicts

**Resources exposed:**
- `pair://context/latest` — Latest 5 context items
- `pair://status` — Current session status

**Running the MCP server in development:**
```bash
OPENCODE_SYNC_RELAY=ws://localhost:4800 OPENCODE_SYNC_ROOM=ABC123 bun run packages/mcp/src/index.ts
```

## Development Workflow

1. **Create a branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make changes** to relevant package(s).

3. **Build and test:**
   ```bash
   bun run build
   bun test
   ```

4. **Commit with clear messages:**
   ```bash
   git commit -m "feat: add feature description"
   ```

5. **Push and open a pull request:**
   ```bash
   git push origin feature/your-feature-name
   ```

## Testing

Run the full test suite:

```bash
bun test
```

Run tests for a specific package:

```bash
cd packages/relay
bun test
```

## Common Tasks

### Adding a new tool to the MCP server

Edit `packages/mcp/src/index.ts`:

```typescript
server.tool(
  'tool_name',
  'Tool description',
  { param1: z.string(), param2: z.number().optional() },
  async ({ param1, param2 }) => {
    // Implementation
    return { content: [{ type: 'text', text: 'Result' }] };
  }
);
```

### Adding a new relay message type

1. Add to `RoomMessageType` in `packages/shared/src/types.ts`
2. Implement handler in relay's `websocket.message` function (`packages/relay/src/index.ts`)
3. Update MCP client in `packages/mcp/src/relay-client.ts` if needed

### Changing limits or constants

Edit `packages/shared/src/types.ts`:

```typescript
export const MAX_PEERS_PER_ROOM = 2;  // Room capacity
export const MAX_MESSAGE_SIZE = 100 * 1024;  // 100 KB
export const HEARTBEAT_INTERVAL_MS = 30_000;  // 30 seconds
export const CONFLICT_WINDOW_MS = 60_000;  // 60 seconds
```

## Code Style

- Use TypeScript with strict mode enabled
- Format code with prettier (auto-formatted on commit if configured)
- Add JSDoc comments for exported functions and types
- Keep functions focused and single-responsibility

## Debugging

### Enable verbose logging

Add console.log or use Bun's built-in debugging:

```bash
bun --inspect packages/relay/src/index.ts
```

### Test relay connection

```bash
# Terminal 1: Start relay
opencode-sync relay

# Terminal 2: Connect with websocat
websocat ws://localhost:4800
```

Send JSON messages manually to test protocol:

```json
{"type":"create","roomId":"","peerId":"test1","payload":{},"timestamp":1234567890}
```

## Documentation

- Update `README.md` for user-facing features
- Keep `CONTRIBUTING.md` synchronized with workflow changes
- Add inline comments for complex logic
- Document breaking changes in commit messages

## Reporting Issues

Use GitHub issues to report bugs or suggest features. Include:

- Steps to reproduce
- Expected vs actual behavior
- Environment (OS, Bun version, Node version)
- Relevant logs or error messages

## License

All contributions are submitted under the MIT license. See LICENSE for details.
