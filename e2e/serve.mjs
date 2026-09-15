// Playwright's webServer command. Creates a throwaway project directory,
// seeds it, and runs the real CLI (`node bin/trimwares.js serve`) from it —
// so the e2e suite exercises the same server users get, against the same
// ui/ that gets published. Port 7790 on purpose: never 7778, so running
// the suite can't collide with a developer's own live dashboard.
import { mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { seed } from './seed.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir  = mkdtempSync(join(tmpdir(), 'trimwares-e2e-'));
seed(dir, 40);
console.log(`e2e: serving from ${dir}`);

const child = spawn(process.execPath, [join(root, 'bin', 'trimwares.js'), 'serve', '--port', process.env.E2E_PORT ?? '7790'],
  { cwd: dir, stdio: 'inherit', env: { ...process.env, TRIMWARES_E2E_DIR: dir } });
child.on('exit', code => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill());
