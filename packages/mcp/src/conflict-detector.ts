import type { ConflictNotification } from '@opencode-sync/shared';
import { CONFLICT_WINDOW_MS, CONFLICT_EXPIRY_MS } from '@opencode-sync/shared';

export function extractFilePaths(content: string): string[] {
  // Matches path/to/file.ext, ./relative/path.ts, /absolute/path.go etc.
  const pathRegex = /(?:\.\/|\/)?[\w./-]+\.(?:ts|js|tsx|jsx|py|rb|go|rs|java|cpp|c|h|php|vue|svelte|md|json|yaml|yml|toml|css|scss|html)/g;
  return [...new Set(content.match(pathRegex) ?? [])];
}

interface FileActivity {
  filePath: string;
  peerId: string;
  timestamp: number;
}

class ConflictDetector {
  private activities: FileActivity[] = [];

  record(peerId: string, content: string): ConflictNotification[] {
    const paths = extractFilePaths(content);
    const now = Date.now();

    this.activities = this.activities.filter(a => now - a.timestamp < CONFLICT_EXPIRY_MS);

    const newConflicts: ConflictNotification[] = [];

    for (const filePath of paths) {
      const window = now - CONFLICT_WINDOW_MS;
      const conflicting = this.activities.filter(
        a => a.filePath === filePath && a.peerId !== peerId && a.timestamp > window
      );

      if (conflicting.length > 0) {
        newConflicts.push({
          filePath,
          peers: [peerId, ...new Set(conflicting.map(c => c.peerId))],
          detectedAt: now,
        });
      }

      this.activities.push({ filePath, peerId, timestamp: now });
    }

    return newConflicts;
  }

  getActive(conflicts: ConflictNotification[]): ConflictNotification[] {
    const now = Date.now();
    return conflicts.filter(c => now - c.detectedAt < CONFLICT_EXPIRY_MS);
  }
}

export const conflictDetector = new ConflictDetector();
