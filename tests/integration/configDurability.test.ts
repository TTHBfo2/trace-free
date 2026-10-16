/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir, homedir } from 'os';
import { createHash } from 'crypto';

/**
 * The user-level state in ~/.trimwares must survive being written badly.
 *
 * A real config.json was found at zero bytes, which cost a paying customer
 * their activation. `writeFileSync` opens with 'w' — it truncates the
 * destination before writing a byte — so any process death in that window
 * (a gate's server.kill(), Ctrl+C, a crash) leaves an empty file. And because
 * an empty config read exactly like "never activated", the failure erased its
 * own evidence and told the customer to buy what they had already bought.
 *
 * These drive the real CLI as a subprocess with TRIMWARES_HOME_DIR pointed at
 * a throwaway directory, so nothing here can touch the developer's own
 * activation — which is itself one of the assertions below.
 *
 * NOT covered here, deliberately, and stated rather than implied: the
 * compare-and-swap in saveRefreshedToken (a background refresh losing a race
 * to `login`/`deactivate`) needs a reachable licence server to exercise
 * honestly, so it is covered by construction — the refresh re-reads and
 * compares the stored token before writing — and not by this suite.
 */

// Jest runs from the package root, and these tests are ESM so there is no
// __dirname to lean on.
const CLI = resolve(process.cwd(), 'bin', 'trimwares.js');

const dirs: string[] = [];
function isolatedHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-cfg-'));
  mkdirSync(join(d, '.trimwares'), { recursive: true });
  dirs.push(d);
  return d;
}
afterAll(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** Runs the CLI with an isolated state dir; returns stdout+stderr and exit code. */
function runCli(args: string[], home: string): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, TRIMWARES_HOME_DIR: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (e: any) {
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

const configOf = (home: string) => join(home, '.trimwares', 'config.json');

describe('a damaged config is reported accurately, not as "never activated"', () => {
  it('empty (0-byte) config says the activation was lost and how to restore it', () => {
    const home = isolatedHome();
    writeFileSync(configOf(home), '');
    const { out, code } = runCli(['check'], home);

    expect(code).not.toBe(0);
    expect(out).toMatch(/empty \(0 bytes\)/);
    expect(out).toMatch(/activation was lost/);
    expect(out).toMatch(/npx trimwares login --key/);
    // Must NOT imply they never had a licence, or tell them to go buy one.
    expect(out).not.toMatch(/Upgrade at|trimwares\.com\/pro/);
  });

  it('corrupt (non-JSON) config says so specifically', () => {
    const home = isolatedHome();
    writeFileSync(configOf(home), '{ this is not json');
    const { out, code } = runCli(['check'], home);

    expect(code).not.toBe(0);
    expect(out).toMatch(/not valid JSON/);
    expect(out).toMatch(/npx trimwares login --key/);
  });

  it('whitespace-only config counts as empty, not as corrupt', () => {
    const home = isolatedHome();
    writeFileSync(configOf(home), '   \n  \n');
    const { out } = runCli(['check'], home);
    expect(out).toMatch(/empty \(0 bytes\)/);
  });

  it('a genuinely absent config is NOT reported as damaged', () => {
    // This is the honest "you have not activated yet" case and must stay
    // distinguishable from the three above.
    const home = isolatedHome();
    expect(existsSync(configOf(home))).toBe(false);
    const { out } = runCli(['check'], home);
    expect(out).not.toMatch(/empty \(0 bytes\)|not valid JSON|could not be read/);
  });
});

describe('state writes are atomic', () => {
  it('genuinely concurrent `add` runs lose no entries', async () => {
    // An earlier version of this test used Promise.all over execFileSync.
    // execFileSync BLOCKS, so the children ran strictly one after another
    // (measured: 342, 681, 1020 ms) and it asserted nothing about concurrency.
    // These are async spawns parked on a barrier file, released together.
    //
    // This is the assertion that caught the remaining bug: the atomic write
    // was in place and this still returned 1 of 8, because `add` read the
    // registry outside the lock and wrote it back after.
    const home = isolatedHome();
    const N = 8;
    const projects = Array.from({ length: N }, (_, i) => {
      const p = join(home, `proj-${i}`);
      mkdirSync(p, { recursive: true });
      return p;
    });
    const barrier = join(home, 'go');

    // Attach the exit listener AT SPAWN, before any await. These children
    // finish in ~130ms; attaching after a sleep meant the fast ones had
    // already exited and Node does not replay 'exit' for a late listener, so
    // the suite hung until the timeout.
    const exits = projects.map(p => {
      const c = spawn(process.execPath, [CLI, 'add', p], {
        stdio: 'ignore',
        env: { ...process.env, TRIMWARES_HOME_DIR: home },
      });
      return new Promise<void>(res => c.on('exit', () => res()));
    });
    void barrier;  // all eight are spawned together; no barrier needed here
    await Promise.all(exits);

    const reg = join(home, '.trimwares', 'projects.json');
    expect(existsSync(reg)).toBe(true);
    expect(statSync(reg).size).toBeGreaterThan(0);
    const parsed = JSON.parse(readFileSync(reg, 'utf8'));  // throws if torn
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(N);
    expect(parsed.map((p: any) => p.path).sort()).toEqual(projects.sort());
  }, 60000);

  it('leaves no temp files behind', () => {
    const home = isolatedHome();
    const p = join(home, 'proj');
    mkdirSync(p, { recursive: true });
    runCli(['add', p], home);

    const leftovers = readdirSync(join(home, '.trimwares')).filter(f => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('test isolation is real', () => {
  it('TRIMWARES_HOME_DIR keeps the developer\'s own state byte-for-byte unchanged', () => {
    // The release gate used to run against the real user environment, which is
    // how a live activation got destroyed by a test run. If this ever fails,
    // the isolation has regressed and the gate can eat a real licence again.
    const realDir = join(homedir(), '.trimwares');
    const snapshot = () => {
      if (!existsSync(realDir)) return 'absent';
      return readdirSync(realDir).sort().map((f: string) => {
        const full = join(realDir, f);
        try {
          if (statSync(full).isDirectory()) return `${f}:dir`;
          return `${f}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
        } catch { return `${f}:unreadable`; }
      }).join('|');
    };

    const before = snapshot();
    const home = isolatedHome();
    const p = join(home, 'proj');
    mkdirSync(p, { recursive: true });
    runCli(['add', p], home);
    writeFileSync(configOf(home), '');
    runCli(['check'], home);

    expect(snapshot()).toBe(before);
    // And the isolated dir is where the work actually landed.
    expect(existsSync(join(home, '.trimwares', 'projects.json'))).toBe(true);
  });
});
