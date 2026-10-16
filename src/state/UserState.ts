/**
 * User-level state in ~/.trimwares: config.json (the activation), machine-id,
 * projects.json (the registry).
 *
 * Extracted out of bin/trimwares.js so it can be tested directly, with dummy
 * token strings in isolated directories, without a licence server. Signature
 * and activation verification stay in the CLI; this module only owns durability
 * and concurrency.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * A real config.json was found at zero bytes, and the activation it held was
 * gone. The CLI wrote it with a bare `writeFileSync`, which opens with 'w' and
 * so TRUNCATES the destination before writing a byte. Any process death in
 * that window — Ctrl+C, a crash, a test harness calling server.kill() — leaves
 * an empty file.
 *
 * That is a demonstrated failure MECHANISM, reproduced in this module's tests.
 * It is not proven to be the cause of that particular incident: the timestamp
 * identified a window, not a responsible process. Both statements are kept
 * deliberately separate.
 *
 * Three distinct problems, which need three distinct fixes:
 *
 *   1. Partial writes      → atomic replace (temp + fsync + rename).
 *   2. Lost updates        → read-modify-write under a cross-process lock.
 *   3. Stale overwrites    → compare the expected value INSIDE the lock.
 *
 * Atomic replacement alone fixes only (1). A compare-then-write outside a lock
 * still loses to another process that commits between the compare and the
 * write, which is why `updateActivationToken` holds the lock across both.
 */

import { randomBytes, randomUUID } from 'crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';

/**
 * TRIMWARES_HOME_DIR overrides the home directory, for test isolation only —
 * the same escape hatch core/PricingCache.ts already uses. It exists so a
 * release gate runs against a disposable identity instead of the developer's
 * real activation, which is what a gate run is capable of destroying.
 */
export function stateDir(): string {
  return join(process.env.TRIMWARES_HOME_DIR ?? homedir(), '.trimwares');
}

export const configPath   = (): string => join(stateDir(), 'config.json');
export const registryPath = (): string => join(stateDir(), 'projects.json');
export const machineIdPath = (): string => join(stateDir(), 'machine-id');

// ─── Atomic replace ───────────────────────────────────────────────────────────

/**
 * Replaces `file` with `contents`, or leaves it exactly as it was.
 *
 * The temp name carries a pid and random suffix: a single shared `.tmp` would
 * relocate the race rather than remove it, since two processes would then
 * fight over the temp file instead of the target.
 */
export function writeFileAtomic(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, contents, 'utf8');
    // Flush before the rename, so a power loss cannot leave a renamed file
    // whose contents never left the page cache.
    const fd = openSync(tmp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameWithRetry(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* may not exist */ }
    throw err;
  }
}

/**
 * `renameSync` over an existing file is atomic but not always *permitted* on
 * Windows: if anything else holds a handle to the destination — a concurrent
 * writer, an antivirus scanner, the search indexer — NTFS returns EPERM or
 * EBUSY rather than blocking. Measured here: eight processes renaming over one
 * file concurrently, and six failed EPERM.
 *
 * Callers inside withStateLock are already serialised against each other, so
 * this retry is for the rest of the world: a scanner that opened the file a
 * millisecond ago. A handful of short retries clears it; giving up still
 * leaves the destination whole, because the rename either happened or didn't.
 */
function renameWithRetry(from: string, to: string, attempts = 12): void {
  for (let i = 0; ; i++) {
    try { renameSync(from, to); return; }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      sleepSync(15 + i * 10);
    }
  }
}

// ─── Cross-process lock ───────────────────────────────────────────────────────

/**
 * How long to wait for a held lock before giving up. 30s in normal use: long
 * enough to outlast any legitimate holder, short enough that a genuinely
 * wedged lock surfaces instead of hanging forever.
 *
 * Read per call rather than at module load, so the "does not steal from a
 * living holder" test can shorten it without needing a fresh module instance.
 */
function lockWaitMs(): number {
  const override = Number(process.env.TRIMWARES_LOCK_WAIT_MS);
  return Number.isFinite(override) && override > 0 ? override : 30_000;
}

/**
 * Sleeps without burning CPU, from synchronous code.
 *
 * The first version of this lock spun in a `while (Date.now() < until)` loop.
 * That works with two processes and collapses with ten: every waiter pegs a
 * core, so the holder gets less CPU and holds the lock longer, and waiters
 * time out. Observed exactly that — eight concurrent CLI runs passed alone and
 * lost an entry when another suite ran in parallel.
 *
 * Atomics.wait blocks the thread properly. It requires a SharedArrayBuffer
 * view, and refuses to run on the main thread in some environments, so the
 * spin remains as a fallback.
 */
const sleepLock = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  try { Atomics.wait(sleepLock, 0, 0, ms); }
  catch { const until = Date.now() + ms; while (Date.now() < until) { /* fallback */ } }
}

const lockPath = (): string => join(stateDir(), '.state.lock');

/** True when `pid` is definitely not running. Unknown counts as alive. */
function pidIsDead(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering it.
    process.kill(pid, 0);
    return false;                       // alive
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return false; // exists, owned by someone else
    return code === 'ESRCH';            // no such process
  }
}


/**
 * A message for a lock that never freed.
 *
 * Trimwares used to try to RECOVER automatically: if a lock looked stale it was
 * removed and re-acquired. That is where every residual race lived — a
 * recoverer could delete a lock another process had just legitimately acquired,
 * putting two writers in the critical section and silently losing one of their
 * changes. Measured repeatedly under load: six processes, five entries kept.
 *
 * The trade was never worth it. The critical section is a few milliseconds of
 * file I/O, so dying inside it is rare, and the cost of automatic recovery
 * going wrong is exactly the data loss this lock exists to prevent. So nothing
 * removes a lock it does not own; a genuinely stuck one is reported with the
 * holder's pid and the path to delete.
 */
function describeStuckLock(p: string, lastCode: string | undefined): string {
  let holder = 'unknown';
  let ageSeconds = '?';
  try {
    const raw = readFileSync(p, 'utf8');
    ageSeconds = Math.round((Date.now() - statSync(p).mtimeMs) / 1000) + 's';
    const parsed = JSON.parse(raw);
    holder = typeof parsed.pid === 'number'
      ? parsed.pid + (pidIsDead(parsed.pid) ? ' (no longer running)' : ' (still running)')
      : 'unreadable';
  } catch { /* vanished or unparseable while we looked */ }

  return [
    'Timed out waiting for the Trimwares state lock.',
    '  Lock file: ' + p,
    '  Held by pid: ' + holder + ', age ' + ageSeconds + ', last error ' + lastCode + '.',
    '',
    'If no trimwares command is running, that lock was left behind by a crash —',
    'delete the file above and retry. If the directory is read-only, fix its',
    'permissions instead: nothing here removes a lock it does not own.',
  ].join('\n');
}

/**
 * Runs `fn` with exclusive access to the state directory, across processes.
 *
 * `openSync(..., 'wx')` is an atomic create-if-absent on both NTFS and POSIX,
 * which is what makes this a real mutex rather than a check-then-act.
 *
 * Deliberately synchronous and short-lived: callers must do network I/O
 * BEFORE acquiring, and only commit inside. A lock held across a fetch would
 * stall every other Trace process for the duration of a timeout.
 *
 * **`fn` MUST be idempotent.** If the lock is lost mid-section — a recoverer
 * acting on a stale-lock decision can remove it — the section is discarded and
 * re-run against whatever is now on disk. A `fn` that appends unconditionally
 * will append twice: observed as a duplicate registry entry. Every caller here
 * either writes an absolute value or guards its append on a key, which is why
 * re-running converges instead of accumulating.
 */
export function withStateLock<T>(fn: () => T): T {
  mkdirSync(stateDir(), { recursive: true });
  const p = lockPath();
  const deadline = Date.now() + lockWaitMs();

  for (;;) {
    // Every acquisition gets a unique token, so the holder can prove the lock
    // at `p` is still *theirs* and not a replacement someone else installed.
    const token = `${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`;
    let fd: number | undefined;

    try {
      fd = openSync(p, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;

      // EEXIST is the normal "someone holds it" answer. On Windows, a
      // concurrent create-or-delete of the same path also surfaces as EPERM,
      // EACCES or EBUSY — NTFS refuses the open rather than reporting the
      // file's existence. Treating those as fatal is what made contention look
      // like data loss: the child simply CRASHED, leaving its entry missing,
      // indistinguishable from a lost update. Same family of errno already
      // handled for renameSync; missing here.
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err;

      if (Date.now() > deadline) {
        // Proceeding unlocked is worse than failing: it is how state is lost.
        // The errno is included because a read-only or permission-denied state
        // directory also lands here, and "timed out" alone would send someone
        // hunting a stuck process that does not exist.
        throw new Error(`${describeStuckLock(p, code)}`);
      }
      // Randomised backoff: a fixed interval makes every waiter retry in
      // lockstep, so the same process tends to win repeatedly.
      sleepSync(5 + Math.floor(Math.random() * 20));
      continue;
    }

    // Acquired. Stamp our token, then CONFIRM it before touching anything.
    let owned = false;
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
      try { closeSync(fd); fd = undefined; } catch { /* already closed */ }

      // A recoverer that decided `p` was stale a moment ago can still remove
      // it after we created it. If the file is gone or no longer carries our
      // token, we are NOT the holder and must not proceed — two writers in the
      // critical section is exactly the corruption this prevents. Observed:
      // six processes recovering one stale lock, two lost their entries.
      owned = lockHasToken(p, token);
      if (!owned) {
        sleepSync(5 + Math.floor(Math.random() * 20));
        continue;
      }

      const result = fn();

      // Re-check ownership AFTER the critical section. Nothing removes a live
      // lock any more, so this should be unreachable — it stays as a tripwire
      // because the failure it guards against is silent data loss, and it
      // costs one stat per call. Losing the lock means the work may have been
      // clobbered, so discard it and run the section again. Safe because `fn`
      // is required to be idempotent (see above).
      if (!lockHasToken(p, token)) {
        owned = false;
        sleepSync(5 + Math.floor(Math.random() * 20));
        continue;
      }
      return result;
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
      // Only release a lock we still own: deleting unconditionally would
      // remove whatever replaced ours and hand the critical section to a third
      // process while its real owner is still inside.
      if (owned && lockHasToken(p, token)) {
        try { unlinkSync(p); } catch { /* already removed */ }
      }
    }
  }
}

/** True when the lock at `p` exists and carries exactly this token. */
function lockHasToken(p: string, token: string): boolean {
  try { return JSON.parse(readFileSync(p, 'utf8')).token === token; }
  catch { return false; }   // missing, empty, or half-written
}



// ─── Config ───────────────────────────────────────────────────────────────────

export type ConfigRead =
  | { state: 'ok';         path: string; config: Record<string, unknown> }
  | { state: 'missing';    path: string }
  | { state: 'empty';      path: string }
  | { state: 'corrupt';    path: string; error?: unknown }
  | { state: 'unreadable'; path: string; error?: NodeJS.ErrnoException };

/**
 * Reads the config and says WHY it has nothing, rather than collapsing every
 * case to null. The old behaviour made a destroyed activation indistinguishable
 * from a machine that had never been activated — so a paying customer whose
 * config had just been truncated was told to go and buy a licence.
 */
export function readConfig(): ConfigRead {
  const path = configPath();
  if (!existsSync(path)) return { state: 'missing', path };
  let raw: string;
  try {
    if (statSync(path).size === 0) return { state: 'empty', path };
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return { state: 'unreadable', path, error: error as NodeJS.ErrnoException };
  }
  if (!raw.trim()) return { state: 'empty', path };
  try { return { state: 'ok', path, config: JSON.parse(raw) as Record<string, unknown> }; }
  catch (error) { return { state: 'corrupt', path, error }; }
}

/** One actionable line for every non-ok state, or null when the config is fine. */
export function configProblemMessage(res: ConfigRead): string | null {
  if (res.state === 'empty')      return `Your license config at ${res.path} is empty (0 bytes), so this device's activation was lost — most likely a write interrupted by a crash or Ctrl+C. Your license itself is unaffected. Re-activate with:  npx trimwares login --key <your-key>`;
  if (res.state === 'corrupt')    return `Your license config at ${res.path} is not valid JSON, so it cannot be read. Re-activate with:  npx trimwares login --key <your-key>`;
  if (res.state === 'unreadable') return `Your license config at ${res.path} could not be read (${res.error?.code ?? 'I/O error'}). Check file permissions, then re-activate if needed.`;
  return null;
}

/** Writes the whole config under the lock, so it cannot interleave. */
export function saveConfig(data: Record<string, unknown>): void {
  withStateLock(() => writeFileAtomic(configPath(), JSON.stringify(data, null, 2)));
}

/** Removes the activation. Under the lock, so a refresh cannot resurrect it. */
export function deleteConfig(): void {
  withStateLock(() => { try { unlinkSync(configPath()); } catch { /* already gone */ } });
}

/**
 * Compare-and-delete, for `deactivate`.
 *
 * `deactivate` reads the config, calls the licence server to free the device
 * slot, then clears the local file. That network call takes time, and a
 * `login` can complete inside it — so an unconditional delete afterwards wipes
 * an activation that is NEWER than the one being deactivated, leaving the user
 * logged out of a licence they just activated.
 *
 * Deleting only when the stored token is still the one we deactivated closes
 * that. `superseded` means someone re-activated meanwhile and their config was
 * deliberately left alone.
 */
export function deleteConfigIfToken(expectedToken: string | undefined): 'deleted' | 'superseded' | 'missing' {
  return withStateLock(() => {
    const res = readConfig();
    if (res.state === 'missing') return 'missing';
    // A damaged config has no recoverable token to compare, and leaving it in
    // place would strand the user with a file that cannot be used. Clear it.
    if (res.state !== 'ok') {
      try { unlinkSync(configPath()); } catch { /* already gone */ }
      return 'deleted';
    }
    if (res.config['activationToken'] !== expectedToken) return 'superseded';
    try { unlinkSync(configPath()); } catch { /* already gone */ }
    return 'deleted';
  });
}

/**
 * Atomic compare-and-swap for the background token refresh.
 *
 * The comparison happens INSIDE the lock. A previous version read, compared,
 * then wrote without holding anything, so a `login` or `deactivate` that
 * committed between the compare and the write was silently overwritten — the
 * refresh could resurrect a token the user had just logged out of.
 *
 * Call this only AFTER the network round-trip; never hold the lock across one.
 *
 * Returns why it did or did not commit, so callers can log honestly.
 */
export function updateActivationToken(
  expectedToken: string,
  newToken: string,
): 'committed' | 'superseded' | 'no-config' {
  return withStateLock(() => {
    const res = readConfig();
    if (res.state !== 'ok') return 'no-config';
    if (res.config['activationToken'] !== expectedToken) return 'superseded';
    writeFileAtomic(configPath(), JSON.stringify({ ...res.config, activationToken: newToken }, null, 2));
    return 'committed';
  });
}

// ─── Machine identity ─────────────────────────────────────────────────────────

export type MachineIdResult = { id: string; created: boolean; recovered: boolean };

/**
 * This device's identity, creating one on first use.
 *
 * Explicit policy on a zero-byte or blank machine-id, because the obvious
 * handling is wrong: silently minting a fresh UUID does NOT recover the old
 * identity, and the licence server will treat the new one as another device,
 * consuming a slot. There is no way to recover the original from a truncated
 * file — so this reports `recovered: true` and the caller is expected to tell
 * the user that re-activation may consume a device slot, rather than doing it
 * silently.
 *
 * Creation happens under the lock: two first-run processes racing here would
 * otherwise generate two UUIDs and bind the install twice.
 */
export function getMachineId(): MachineIdResult {
  const p = machineIdPath();
  if (existsSync(p)) {
    try {
      const existing = readFileSync(p, 'utf8').trim();
      if (existing) return { id: existing, created: false, recovered: false };
    } catch { /* fall through to the locked path below */ }
  }
  return withStateLock(() => {
    // Re-check inside the lock: another process may have just created it.
    if (existsSync(p)) {
      try {
        const existing = readFileSync(p, 'utf8').trim();
        if (existing) return { id: existing, created: false, recovered: false };
      } catch { /* treat as blank */ }
    }
    const blankBefore = existsSync(p);
    const id = randomUUID();
    writeFileAtomic(p, id);
    return { id, created: true, recovered: blankBefore };
  });
}

// ─── Project registry ─────────────────────────────────────────────────────────

export function readRegistry(): Array<Record<string, unknown>> {
  const p = registryPath();
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * Read-modify-write the registry under the lock.
 *
 * Atomic replacement stops a torn file but not a LOST UPDATE: two `serve`
 * processes starting together both read N entries, each appends its own, and
 * whichever writes second drops the other's. Holding the lock across the read
 * and the write is the only thing that prevents it.
 */
export function mutateRegistry(
  fn: (current: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return withStateLock(() => {
    const next = fn(readRegistry());
    writeFileAtomic(registryPath(), JSON.stringify(next, null, 2));
    return next;
  });
}

/** Test helper: wipes an isolated state dir. Refuses to run outside one. */
export function __unsafeResetIsolatedState(): void {
  if (!process.env.TRIMWARES_HOME_DIR) {
    throw new Error('__unsafeResetIsolatedState refuses to run without TRIMWARES_HOME_DIR set — it would delete real user state.');
  }
  try { rmSync(stateDir(), { recursive: true, force: true }); } catch { /* nothing to remove */ }
}

/** Test helper: lists the state dir, for leftover-temp assertions. */
export function listStateDir(): string[] {
  try { return readdirSync(stateDir()).sort(); } catch { return []; }
}
