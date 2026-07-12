import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// Writes failed provider calls to .trimwares/errors.jsonl.
// Never stores prompt content — only provider, model, error message, and timing.

export interface ErrorEntry {
  timestamp:  number;
  provider:   string;
  model:      string;
  error:      string;
  latencyMs:  number;
}

const LOG_DIR  = '.trimwares';
const ERR_FILE = 'errors.jsonl';

export class ErrorLog {
  private logPath: string;
  private enabled: boolean;

  constructor(options: { enabled?: boolean; dir?: string } = {}) {
    this.enabled = options.enabled ?? true;
    const dir    = options.dir ?? process.env.TRIMWARES_LOG_DIR ?? LOG_DIR;
    this.logPath = join(process.cwd(), dir, ERR_FILE);
    if (this.enabled) {
      try { mkdirSync(join(process.cwd(), dir), { recursive: true }); }
      catch { this.enabled = false; }
    }
  }

  write(entry: ErrorEntry): void {
    if (!this.enabled) return;
    try { appendFileSync(this.logPath, JSON.stringify(entry) + '\n', 'utf8'); }
    catch { /* non-fatal */ }
  }
}
