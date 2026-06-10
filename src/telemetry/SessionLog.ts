import { createHash } from 'crypto';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { SessionLogEntry } from '../types/index.js';

// Writes metadata-only session logs to .trimwares/session.jsonl and history.jsonl
// NEVER stores prompt content, response content, or API keys — only counts and costs.

const LOG_DIR   = '.trimwares';
const LOG_FILE  = 'session.jsonl';
const HIST_FILE = 'history.jsonl';

export class SessionLog {
  private logPath: string;
  private historyPath: string;
  private enabled: boolean;
  private buffer: SessionLogEntry[] = [];

  constructor(options: { enabled?: boolean; dir?: string } = {}) {
    this.enabled = options.enabled ?? true;
    const dir = options.dir ?? LOG_DIR;
    this.logPath     = join(process.cwd(), dir, LOG_FILE);
    this.historyPath = join(process.cwd(), dir, HIST_FILE);

    if (this.enabled) {
      try {
        mkdirSync(join(process.cwd(), dir), { recursive: true });
      } catch {
        this.enabled = false;
      }
    }
  }

  write(entry: SessionLogEntry): void {
    if (!this.enabled) return;
    this.buffer.push(entry);
    try {
      const line = JSON.stringify(entry) + '\n';
      writeFileSync(this.logPath,     line, { flag: 'a', encoding: 'utf8' });
      writeFileSync(this.historyPath, line, { flag: 'a', encoding: 'utf8' });
    } catch {
      // non-fatal — never crash the app over telemetry
    }
  }

  readAll(): SessionLogEntry[] {
    if (!existsSync(this.logPath)) return [];
    try {
      return readFileSync(this.logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap(line => { try { return [JSON.parse(line) as SessionLogEntry]; } catch { return []; } });
    } catch {
      return [];
    }
  }

  // In-memory buffer for the current session (no disk read needed)
  getBuffer(): SessionLogEntry[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }
}

// Stable one-way hash of model+provider — used for aggregation without revealing values
export function hashDimension(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}
