import { createHash } from 'crypto';
import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { SessionLogEntry } from '../types/index.js';

// Writes metadata-only session logs to .trimwares/session.jsonl
// NEVER stores prompt content, response content, or API keys — only counts and costs.

const LOG_DIR    = '.trimwares';
const LOG_FILE   = 'session.jsonl';
const MAX_BYTES  = 10 * 1024 * 1024;  // 10 MB hard cap per file
const KEEP_BYTES =  5 * 1024 * 1024;  // trim to last 5 MB (newest entries)

export class SessionLog {
  private logPath: string;
  private enabled: boolean;
  private buffer: SessionLogEntry[] = [];

  constructor(options: { enabled?: boolean; dir?: string } = {}) {
    this.enabled = options.enabled ?? true;
    const dir = options.dir ?? process.env.TRIMWARES_LOG_DIR ?? LOG_DIR;
    this.logPath = join(process.cwd(), dir, LOG_FILE);

    if (this.enabled) {
      try {
        mkdirSync(join(process.cwd(), dir), { recursive: true });
      } catch (err) {
        this.enabled = false;
        console.warn(`[trimwares] Session log disabled: could not create ${join(process.cwd(), dir)} — ${(err as Error).message ?? String(err)}`);
      }
    }
  }

  write(entry: SessionLogEntry): void {
    if (!this.enabled) return;
    this.buffer.push(entry);
    try {
      const line = JSON.stringify(entry) + '\n';
      writeFileSync(this.logPath, line, { flag: 'a', encoding: 'utf8' });
      this.compactIfNeeded(this.logPath);
    } catch {
      // non-fatal — never crash the app over telemetry
    }
  }

  private compactIfNeeded(filePath: string): void {
    try {
      if (!existsSync(filePath)) return;
      const size = statSync(filePath).size;
      if (size <= MAX_BYTES) return;
      // Read the tail (KEEP_BYTES from end), find the first complete line boundary
      const content = readFileSync(filePath, 'utf8');
      const trimmed = content.slice(-KEEP_BYTES);
      const firstNewline = trimmed.indexOf('\n');
      const clean = firstNewline >= 0 ? trimmed.slice(firstNewline + 1) : trimmed;
      writeFileSync(filePath, clean, { encoding: 'utf8' });
    } catch {
      // non-fatal
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
