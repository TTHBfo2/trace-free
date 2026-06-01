#!/usr/bin/env node
// CLI entry point — npx trimwares analyze

import { SessionLog } from '../dist/telemetry/index.js';
import { renderReport } from '../dist/cli/analyze.js';

const [,, command = 'analyze'] = process.argv;

if (command === 'analyze') {
  const log = new SessionLog();
  const entries = log.readAll();
  process.stdout.write(renderReport({ entries }));
  process.exit(0);
}

if (command === 'clear') {
  const { unlinkSync, existsSync } = await import('fs');
  const path = '.trimwares/session.jsonl';
  if (existsSync(path)) { unlinkSync(path); console.log('Session log cleared.'); }
  else { console.log('No session log found.'); }
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
console.error('Usage: npx trimwares analyze|clear');
process.exit(1);
