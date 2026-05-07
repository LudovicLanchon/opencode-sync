#!/usr/bin/env bun
// opencode-sync CLI

const [,, command, ...args] = process.argv;

function printHelp(): void {
  console.log(`
opencode-sync - Shared context pair programming for opencode

USAGE:
  opencode-sync <command> [options]

COMMANDS:
  relay [--port <port>]          Start the WebSocket relay server
  join <room-code> [--relay <url>]  Output MCP config JSON for opencode

OPTIONS:
  --help, -h     Show this help message
  --version, -v  Show version

EXAMPLES:
  opencode-sync relay
  opencode-sync relay --port 4800
  opencode-sync join ABC123
  opencode-sync join ABC123 --relay ws://myserver.example.com:4800
`);
}

function printVersion(): void {
  console.log('opencode-sync v0.1.0');
}

async function startRelay(args: string[]): Promise<void> {
  // Pass args to relay server
  process.argv = [...process.argv.slice(0, 2), ...args];
  await import('./relay-start.ts');
}

async function joinRoom(roomCode: string, args: string[]): Promise<void> {
  if (!roomCode || roomCode === '--help' || roomCode === '-h') {
    console.log(`
USAGE: opencode-sync join <room-code> [--relay <ws-url>]

Outputs an MCP server config JSON that you can add to your opencode config.

EXAMPLE:
  opencode-sync join ABC123
  opencode-sync join ABC123 --relay ws://localhost:4800
`);
    return;
  }

  const relayIdx = args.indexOf('--relay');
  const relayUrl = relayIdx !== -1 ? args[relayIdx + 1] : 'ws://localhost:4800';

  const config = {
    mcpServers: {
      'opencode-sync': {
        type: 'stdio',
        command: 'bun',
        args: [
          // This will be the path to the installed CLI
          'run',
          'opencode-sync/packages/mcp/src/index.ts',
        ],
        env: {
          OPENCODE_SYNC_RELAY: relayUrl,
          OPENCODE_SYNC_ROOM: roomCode,
        },
      },
    },
  };

  console.log(JSON.stringify(config, null, 2));
}

// Handle --help and --version at top level
if (!command || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  printVersion();
  process.exit(0);
}

if (command === 'relay') {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
USAGE: opencode-sync relay [--port <port>]

Start the WebSocket relay server.

OPTIONS:
  --port <port>  Port to listen on (default: 4800)
  --help, -h     Show this help

EXAMPLE:
  opencode-sync relay
  opencode-sync relay --port 9000
`);
    process.exit(0);
  }
  await startRelay(args);
} else if (command === 'join') {
  await joinRoom(args[0] ?? '', args.slice(1));
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}
