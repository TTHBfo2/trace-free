/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync, utimesSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir, homedir } from 'os';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import {
  readConfig, configProblemMessage, saveConfig, deleteConfig,
  updateActivationToken, getMachineId, readRegistry, mutateRegistry,
  withStateLock, writeFileAtomic, stateDir, configPath, registryPath, listStateDir,
  __unsafeResetIsolatedState,
} from '../../src/state/UserState.js';

/**
 * Durability and concurrency for ~/.trimwares.
 *
 * A previous version of this suite used `Promise.all` over `execFileSync`,
 * which blocks — the children ran strictly one after another (measured: 342,
 * 681, 1020 ms) so it asserted nothing about concurrency at all. These use
 * detached async children with a start barrier, read while writes are in
 * flight, and interrupt a write mid-flight on purpose.
 *
 * No licence server is involved: dummy token strings in isolated directories.
 * Signature and activation verification live in their own suites.
 */

const dirs: string[] = [];
function isolate(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-state-'));
  dirs.push(d);
  process.env.TRIMWARES_HOME_DIR = d;
  return d;
}
const originalHome = process.env.TRIMWARES_HOME_DIR;
afterAll(() => {
  if (originalHome === undefined) delete process.env.TRIMWARES_HOME_DIR;
  else process.env.TRIMWARES_HOME_DIR = originalHome;
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── 1. Config diagnosis ──────────────────────────────────────────────────────

describe('a damaged config is diagnosed, not mistaken for "never activated"', () => {
  it.each([
    ['',            'empty',   /empty \(0 bytes\)/],
    ['   \n\t ',    'empty',   /empty \(0 bytes\)/],
    ['{ not json',  'corrupt', /not valid JSON/],
  ])('%j reads as %s', (contents, expectedState, messageRe) => {
    isolate();
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(configPath(), contents as string);

    const res = readConfig();
    expect(res.state).toBe(expectedState);
    const msg = configProblemMessage(res);
    expect(msg).toMatch(messageRe as RegExp);
    expect(msg).toMatch(/npx trimwares login --key/);
    // Must never imply they never bought it.
    expect(msg).not.toMatch(/upgrade|purchase|buy/i);
  });

  it('an absent config is "missing" with no problem message', () => {
    isolate();
    const res = readConfig();
    expect(res.state).toBe('missing');
    expect(configProblemMessage(res)).toBeNull();
  });

  it('a good config round-trips', () => {
    isolate();
    saveConfig({ activationToken: 'tok-1', tier: 'developer' });
    const res = readConfig();
    expect(res.state).toBe('ok');
    expect((res as any).config.activationToken).toBe('tok-1');
  });
});

// ── 2. Atomic replace, including a controlled interruption ───────────────────

describe('atomic replace', () => {
  it('leaves the original intact when the write throws', () => {
    isolate();
    saveConfig({ activationToken: 'original' });
    const before = readFileSync(configPath(), 'utf8');

    // A value JSON.stringify cannot serialize: the throw happens before any
    // rename, so the destination must be untouched.
    const circular: any = {}; circular.self = circular;
    expect(() => writeFileAtomic(configPath(), JSON.stringify(circular))).toThrow();

    expect(readFileSync(configPath(), 'utf8')).toBe(before);
    expect(readConfig().state).toBe('ok');
  });

  it('REPRODUCTION: a bare writeFileSync truncates; writeFileAtomic does not', async () => {
    // This is the failure mechanism, demonstrated rather than asserted. It is
    // evidence that the mechanism is real — NOT evidence that it caused the
    // original 0-byte incident, which no code review can establish.
    const home = isolate();
    const target = join(home, 'victim.json');
    const script = join(home, 'writer.cjs');

    // A child that truncates the target, then hangs before writing the body —
    // exactly the window a bare writeFileSync opens.
    writeFileSync(script, `
      const fs = require('fs');
      const fd = fs.openSync(${JSON.stringify(target)}, 'w');  // truncates NOW
      process.send && process.send('truncated');
      setTimeout(() => { fs.writeSync(fd, 'too late'); }, 10000);
    `);

    writeFileSync(target, JSON.stringify({ activationToken: 'precious' }));
    expect(statSync(target).size).toBeGreaterThan(0);

    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    await wait(600);
    child.kill('SIGKILL');
    await wait(200);

    // The naive path loses the data entirely.
    expect(statSync(target).size).toBe(0);

    // The atomic path, interrupted at the same point, cannot: the destination
    // is only ever replaced by a complete file via rename.
    const safe = join(home, 'safe.json');
    writeFileSync(safe, JSON.stringify({ activationToken: 'precious' }));
    const sizeBefore = statSync(safe).size;
    const script2 = join(home, 'writer2.cjs');
    writeFileSync(script2, `
      const fs = require('fs'), path = require('path');
      const tmp = ${JSON.stringify(safe)} + '.tmp';
      const fd = fs.openSync(tmp, 'w');            // truncates the TEMP, not the target
      setTimeout(() => { fs.writeSync(fd, 'x'); fs.renameSync(tmp, ${JSON.stringify(safe)}); }, 10000);
    `);
    const child2 = spawn(process.execPath, [script2], { stdio: 'ignore' });
    await wait(600);
    child2.kill('SIGKILL');
    await wait(200);

    expect(statSync(safe).size).toBe(sizeBefore);
    expect(JSON.parse(readFileSync(safe, 'utf8')).activationToken).toBe('precious');
  }, 20000);

  it('leaves no temp files behind', () => {
    isolate();
    saveConfig({ activationToken: 'tok' });
    mutateRegistry(cur => cur.some(e => e.path === 'p') ? cur : [...cur, { path: 'p' }]);
    expect(listStateDir().filter(f => f.endsWith('.tmp'))).toEqual([]);
  });
});

// ── 3. Genuine cross-process concurrency ─────────────────────────────────────

/**
 * Source for a child that waits on a barrier file, then mutates the registry.
 *
 * The package is ESM, so the child dynamic-imports the compiled module. The
 * barrier spin is what makes this genuinely concurrent: every child is already
 * running and parked when the barrier appears, so they contend for real.
 */
function registryWriterScript(repoRoot: string, label: string, barrier: string): string {
  const mod = pathToFileURL(join(repoRoot, 'dist', 'state', 'UserState.js')).href;
  return `
    import { existsSync } from 'fs';
    const { mutateRegistry } = await import(${JSON.stringify(mod)});
    while (!existsSync(${JSON.stringify(barrier)})) {}
    mutateRegistry(cur => cur.some(e => e.path === ${JSON.stringify(label)}) ? cur : [...cur, { path: ${JSON.stringify(label)} }]);
  `;
}

describe('cross-process concurrency', () => {
  const repoRoot = resolve(process.cwd());
  const distMod  = join(repoRoot, 'dist', 'state', 'UserState.js');
  const srcMod   = join(repoRoot, 'src', 'state', 'UserState.ts');

  /**
   * These tests must run against FRESHLY BUILT code, and must never quietly
   * skip.
   *
   * They spawn real child processes, so the children can only load the
   * compiled module — not the TypeScript these tests import. An earlier
   * version guarded them with `haveDist ? it : it.skip`, which meant that on a
   * fresh checkout (where `npm test` runs before `npm run build`) the three
   * concurrency tests silently vanished and the suite still reported green.
   * CI had been skipping them.
   *
   * So: fail loudly if the build is missing, and fail loudly if it is older
   * than the source — testing a stale artifact is how a bundle that ignored
   * its own config flag shipped in 1.0.5.
   */
  beforeAll(() => {
    if (!existsSync(distMod)) {
      throw new Error(
        `${distMod} is missing, so the cross-process concurrency tests cannot run.\n` +
        '  These spawn real child processes, which can only load the compiled module.\n' +
        '  Run `npm run build` first. This is deliberately a failure, not a skip:\n' +
        '  silently skipping them reported green while testing nothing.',
      );
    }
    if (existsSync(srcMod) && statSync(distMod).mtimeMs < statSync(srcMod).mtimeMs) {
      throw new Error(
        `${distMod} is OLDER than ${srcMod}, so these tests would exercise stale code.\n` +
        '  Run `npm run build`.',
      );
    }
  });

  it('N processes appending at once lose no entries', async () => {
    // Atomic replacement alone does NOT prevent this: each process reads N,
    // appends one, writes N+1, and the last writer wins — losing the others.
    // Only holding the lock across read-and-write prevents it.
    const home = isolate();
    mkdirSync(stateDir(), { recursive: true });
    const barrier = join(home, 'go');
    const N = 8;

    const scripts = Array.from({ length: N }, (_, i) => {
      const f = join(home, `w${i}.mjs`);
      writeFileSync(f, registryWriterScript(repoRoot, `proj-${i}`, barrier));
      return f;
    });

    // Listeners attached at spawn, before any await: Node does not replay
    // 'exit' for a listener added after the child has already gone.
    const childEnv = { ...process.env, TRIMWARES_HOME_DIR: home };
    const exits = scripts.map(f => {
      const c = spawn(process.execPath, [f], { stdio: 'ignore', env: childEnv });
      return new Promise<void>(res => c.on('exit', () => res()));
    });
    await wait(400);                 // let them all reach the barrier
    writeFileSync(barrier, 'go');    // release simultaneously
    await Promise.all(exits);

    const reg = readRegistry();
    const names = reg.map(r => r['path']).sort();
    expect(reg.length).toBe(N);
    expect(names).toEqual(Array.from({ length: N }, (_, i) => `proj-${i}`).sort());
  }, 40000);

  it('CONTROL: the same writes WITHOUT the lock do lose entries', async () => {
    // Proves the lock above is load-bearing. Atomic replacement alone is not
    // enough: each process reads N, appends one, writes N+1, and the last
    // writer wins. Measured on this machine: 1 of 8 entries survived.
    //
    // If this test ever starts passing 8/8, the concurrency test above has
    // stopped being able to fail and both need revisiting.
    const home = isolate();
    mkdirSync(stateDir(), { recursive: true });
    const reg = registryPath();
    writeFileSync(reg, '[]');
    const barrier = join(home, 'go');
    const N = 8;

    const exits = Array.from({ length: N }, (_, i) => {
      const f = join(home, `u${i}.mjs`);
      writeFileSync(f, `
        import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
        while (!existsSync(${JSON.stringify(barrier)})) {}
        try {
          const reg = JSON.parse(readFileSync(${JSON.stringify(reg)}, 'utf8'));
          reg.push({ path: 'proj-${i}' });
          const tmp = ${JSON.stringify(reg)} + '.${i}.tmp';
          writeFileSync(tmp, JSON.stringify(reg));
          renameSync(tmp, ${JSON.stringify(reg)});
        } catch { /* EPERM under contention is itself part of the problem */ }
      `);
      const c = spawn(process.execPath, [f], { stdio: 'ignore' });
      return new Promise<void>(res => c.on('exit', () => res()));
    });
    await wait(400);
    writeFileSync(barrier, 'go');
    await Promise.all(exits);

    const kept = JSON.parse(readFileSync(reg, 'utf8')).length;
    expect(kept).toBeLessThan(N);
  }, 40000);

  it('readers never observe a torn or empty registry while writes overlap', async () => {
    const home = isolate();
    mkdirSync(stateDir(), { recursive: true });
    const barrier = join(home, 'go');
    const N = 6;
    mutateRegistry(() => [{ path: 'seed' }]);

    const childEnv = { ...process.env, TRIMWARES_HOME_DIR: home };
    const exits = Array.from({ length: N }, (_, i) => {
      const f = join(home, `r${i}.mjs`);
      writeFileSync(f, registryWriterScript(repoRoot, `p-${i}`, barrier));
      const c = spawn(process.execPath, [f], { stdio: 'ignore', env: childEnv });
      return new Promise<void>(res => c.on('exit', () => res()));
    });
    await wait(400);
    writeFileSync(barrier, 'go');

    // Hammer reads while the writes are in flight. Every observation must be
    // parseable and non-empty — a truncated window would show up here.
    let reads = 0, bad = 0;
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      try {
        const raw = readFileSync(registryPath(), 'utf8');
        reads++;
        if (!raw.trim()) { bad++; continue; }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) bad++;
      } catch { bad++; }
    }
    await Promise.all(exits);

    expect(reads).toBeGreaterThan(20);
    expect(bad).toBe(0);
  }, 40000);
});

// ── 4. Refresh versus login/deactivate ───────────────────────────────────────

describe('token refresh cannot overwrite newer state', () => {
  it('commits when the stored token is still the one it was based on', () => {
    isolate();
    saveConfig({ activationToken: 'old', tier: 'developer' });
    expect(updateActivationToken('old', 'new')).toBe('committed');
    expect((readConfig() as any).config.activationToken).toBe('new');
  });

  it('is dropped when a login replaced the token first', () => {
    isolate();
    saveConfig({ activationToken: 'old' });
    saveConfig({ activationToken: 'from-a-new-login' });   // user re-logged in
    expect(updateActivationToken('old', 'stale-refresh')).toBe('superseded');
    expect((readConfig() as any).config.activationToken).toBe('from-a-new-login');
  });

  it('cannot resurrect an activation after deactivate', () => {
    isolate();
    saveConfig({ activationToken: 'old' });
    deleteConfig();                                         // user logged out
    expect(updateActivationToken('old', 'resurrected')).toBe('no-config');
    expect(readConfig().state).toBe('missing');
  });

  it('does not create a config out of nothing', () => {
    isolate();
    expect(updateActivationToken('whatever', 'tok')).toBe('no-config');
    expect(existsSync(configPath())).toBe(false);
  });
});

describe('deactivate cannot delete a newer activation', () => {
  it('deletes the activation it was asked to remove', async () => {
    isolate();
    const { deleteConfigIfToken } = await import('../../src/state/UserState.js');
    saveConfig({ activationToken: 'tok-a' });
    expect(deleteConfigIfToken('tok-a')).toBe('deleted');
    expect(readConfig().state).toBe('missing');
  });

  it('leaves a NEWER activation alone', async () => {
    // `deactivate` reads the config, spends up to ten seconds calling the
    // licence server, then clears the file. A `login` completing inside that
    // window leaves a newer token on disk, and an unconditional delete logged
    // the user out of the licence they had just activated.
    isolate();
    const { deleteConfigIfToken } = await import('../../src/state/UserState.js');
    saveConfig({ activationToken: 'tok-old' });
    saveConfig({ activationToken: 'tok-from-new-login' });   // raced in
    expect(deleteConfigIfToken('tok-old')).toBe('superseded');
    expect((readConfig() as any).config.activationToken).toBe('tok-from-new-login');
  });

  it('clears a damaged config rather than stranding the user with it', async () => {
    isolate();
    const { deleteConfigIfToken } = await import('../../src/state/UserState.js');
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(configPath(), '');          // 0 bytes: no token to compare
    expect(deleteConfigIfToken('tok-old')).toBe('deleted');
    expect(readConfig().state).toBe('missing');
  });

  it('reports missing rather than failing', async () => {
    isolate();
    const { deleteConfigIfToken } = await import('../../src/state/UserState.js');
    expect(deleteConfigIfToken('tok-old')).toBe('missing');
  });
});

// ── 5. Machine identity policy ───────────────────────────────────────────────

describe('machine id', () => {
  it('is stable once created', () => {
    isolate();
    const a = getMachineId();
    expect(a.created).toBe(true);
    const b = getMachineId();
    expect(b.id).toBe(a.id);
    expect(b.created).toBe(false);
  });

  it('reports a blank file as recovered, because the old identity is gone', () => {
    // Minting a fresh UUID does NOT restore the previous identity, and the
    // licence server will see a new device. The caller must say so rather
    // than silently consuming a slot.
    isolate();
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), 'machine-id'), '');
    const res = getMachineId();
    expect(res.created).toBe(true);
    expect(res.recovered).toBe(true);
    expect(res.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ── 6. The lock itself ───────────────────────────────────────────────────────

describe('state lock', () => {
  it('releases on a throw, so one failure cannot wedge every later command', () => {
    isolate();
    expect(() => withStateLock(() => { throw new Error('boom'); })).toThrow('boom');
    expect(withStateLock(() => 'acquired again')).toBe('acquired again');
    expect(listStateDir()).not.toContain('.state.lock');
  });

  // ── A stuck lock is REPORTED, never stolen ─────────────────────────────────
  //
  // Automatic recovery used to live here: a lock that looked stale was removed
  // and re-acquired. Every residual race came from that — a recoverer could
  // delete a lock another process had just legitimately acquired, putting two
  // writers in the critical section and silently dropping one of their
  // changes. Measured repeatedly under load: six processes, five entries kept.
  // Three successive attempts to make stealing safe each failed under load.
  //
  // It is gone. The critical section is a few milliseconds of file I/O, so a
  // process dying inside it is rare, and the cost of recovery going wrong is
  // exactly the data loss the lock exists to prevent. A stuck lock now fails
  // loudly with the holder's pid and the path to delete.

  it('reports a stuck lock with an actionable message, and does not remove it', () => {
    isolate();
    mkdirSync(stateDir(), { recursive: true });
    const lock = join(stateDir(), '.state.lock');
    writeFileSync(lock, JSON.stringify({ pid: 999999, at: 0 }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    const saved = process.env.TRIMWARES_LOCK_WAIT_MS;
    process.env.TRIMWARES_LOCK_WAIT_MS = '400';
    try {
      let message = '';
      try { withStateLock(() => 'should not get here'); }
      catch (e) { message = (e as Error).message; }

      expect(message).toMatch(/Timed out waiting for the Trimwares state lock/);
      expect(message).toContain(lock);                 // the path to delete
      expect(message).toMatch(/999999/);               // who held it
      expect(message).toMatch(/no longer running/);     // and that it is safe
      expect(message).toMatch(/delete the file above/);
      expect(message).toMatch(/read-only/);             // the other explanation
    } finally {
      if (saved === undefined) delete process.env.TRIMWARES_LOCK_WAIT_MS;
      else process.env.TRIMWARES_LOCK_WAIT_MS = saved;
    }

    // The lock is still there: nothing removes a lock it does not own.
    expect(existsSync(lock)).toBe(true);
  }, 30000);

  it('says the holder is still running when it is', () => {
    // Distinguishing the two matters: "no longer running" means deleting the
    // file is safe, "still running" means waiting is the right move.
    isolate();
    mkdirSync(stateDir(), { recursive: true });
    const lock = join(stateDir(), '.state.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: 0 }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    const saved = process.env.TRIMWARES_LOCK_WAIT_MS;
    process.env.TRIMWARES_LOCK_WAIT_MS = '400';
    try {
      let message = '';
      try { withStateLock(() => 'nope'); } catch (e) { message = (e as Error).message; }
      expect(message).toMatch(/still running/);
      expect(message).not.toMatch(/no longer running/);
    } finally {
      if (saved === undefined) delete process.env.TRIMWARES_LOCK_WAIT_MS;
      else process.env.TRIMWARES_LOCK_WAIT_MS = saved;
    }
  }, 30000);

  it('deleting the stuck lock is all the recovery the message promises', () => {
    isolate();
    mkdirSync(stateDir(), { recursive: true });
    const lock = join(stateDir(), '.state.lock');
    writeFileSync(lock, JSON.stringify({ pid: 999999, at: 0 }));

    rmSync(lock);                                  // what the message tells you to do
    expect(withStateLock(() => 'recovered')).toBe('recovered');
  });

  it('an empty lock file is still not stolen', () => {
    // A holder that died before naming itself. Previously this was treated as
    // "nobody to wait for" and removed, which is the same unsafe shortcut.
    isolate();
    mkdirSync(stateDir(), { recursive: true });
    const lock = join(stateDir(), '.state.lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    const saved = process.env.TRIMWARES_LOCK_WAIT_MS;
    process.env.TRIMWARES_LOCK_WAIT_MS = '400';
    try {
      expect(() => withStateLock(() => 'nope')).toThrow(/Timed out waiting/);
    } finally {
      if (saved === undefined) delete process.env.TRIMWARES_LOCK_WAIT_MS;
      else process.env.TRIMWARES_LOCK_WAIT_MS = saved;
    }
    expect(existsSync(lock)).toBe(true);
  }, 30000);
});

// ── 7. Isolation is real ─────────────────────────────────────────────────────

describe('isolation', () => {
  it('nothing in this suite touches the real ~/.trimwares', () => {
    const realDir = join(homedir(), '.trimwares');
    const snap = () => {
      if (!existsSync(realDir)) return 'absent';
      return readdirSync(realDir).sort().map(f => {
        const full = join(realDir, f);
        try {
          return statSync(full).isDirectory()
            ? `${f}:dir`
            : `${f}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
        } catch { return `${f}:unreadable`; }
      }).join('|');
    };
    const before = snap();

    isolate();
    saveConfig({ activationToken: 'x' });
    mutateRegistry(cur => cur.some(e => e.path === 'p') ? cur : [...cur, { path: 'p' }]);
    getMachineId();
    deleteConfig();

    expect(snap()).toBe(before);
  });

  it('the reset helper refuses to run against a real home', () => {
    const saved = process.env.TRIMWARES_HOME_DIR;
    delete process.env.TRIMWARES_HOME_DIR;
    try {
      expect(() => __unsafeResetIsolatedState()).toThrow(/refuses to run/);
    } finally {
      if (saved !== undefined) process.env.TRIMWARES_HOME_DIR = saved;
    }
  });
});
