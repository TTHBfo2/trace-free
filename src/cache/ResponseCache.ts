import { createHash } from 'crypto';
import { LLMRequest, LLMResponse, CacheStats } from '../types/index.js';

interface CacheEntry {
  response:             LLMResponse;
  createdAt:            number;
  ttlMs:                number;
  hitCount:             number;
  lastHitAt:            number;
  systemPromptHash:     string;   // hash of the system prompt at cache-write time
}

// Default TTL: 24 hours for exact matches.
// The previous 5-minute default caused near-zero hit rates on real traffic where
// the same question is asked by different users hours apart.
// Safe because: exact match is always correct, and we invalidate when the
// system prompt changes (content changes → hash changes → cache miss → fresh call).
const DEFAULT_TTL_MS   = 24 * 60 * 60 * 1000;  // 24 hours
const DEFAULT_MAX_ENTRIES = 2_000;

export class ResponseCache {
  private store      = new Map<string, CacheEntry>();
  private hitCount   = 0;
  private missCount  = 0;
  private invalidations = 0;
  private ttlMs:     number;
  private maxEntries: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs      = options.ttlMs      ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.cleanupTimer = setInterval(() => this.evictExpired(), 5 * 60_000);
  }

  get(request: LLMRequest): LLMResponse | null {
    const key              = this.cacheKey(request);
    const currentSysHash   = this.systemPromptHash(request);
    const entry            = this.store.get(key);

    if (!entry) { this.missCount++; return null; }

    // TTL check
    if (Date.now() - entry.createdAt > entry.ttlMs) {
      this.store.delete(key);
      this.missCount++;
      return null;
    }

    // System-prompt change detection: if the system prompt has changed since
    // this response was cached, the cached answer may be stale (e.g. pricing
    // was updated). Invalidate and force a fresh live call.
    if (entry.systemPromptHash !== currentSysHash) {
      this.store.delete(key);
      this.missCount++;
      this.invalidations++;
      return null;
    }

    entry.hitCount++;
    entry.lastHitAt = Date.now();
    this.hitCount++;
    return entry.response;
  }

  set(request: LLMRequest, response: LLMResponse): void {
    if (this.store.size >= this.maxEntries) this.evictLRU();

    this.store.set(this.cacheKey(request), {
      response,
      createdAt:        Date.now(),
      ttlMs:            this.ttlMs,
      hitCount:         0,
      lastHitAt:        Date.now(),
      systemPromptHash: this.systemPromptHash(request),
    });
  }

  /** Force-invalidate all entries whose system prompt hash no longer matches. */
  invalidateOnSystemPromptChange(newRequest: LLMRequest): number {
    const newHash = this.systemPromptHash(newRequest);
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.systemPromptHash !== newHash) {
        this.store.delete(key);
        removed++;
      }
    }
    this.invalidations += removed;
    return removed;
  }

  invalidate(request: LLMRequest): void {
    this.store.delete(this.cacheKey(request));
  }

  clear(): void {
    this.store.clear();
    this.hitCount  = 0;
    this.missCount = 0;
    this.invalidations = 0;
  }

  stats(): CacheStats & { invalidations: number } {
    const total = this.hitCount + this.missCount;
    return {
      totalEntries: this.store.size,
      hitCount:     this.hitCount,
      missCount:    this.missCount,
      hitRate:      total > 0 ? parseFloat(((this.hitCount / total) * 100).toFixed(1)) : 0,
      sizeBytes:    this.estimateSizeBytes(),
      invalidations: this.invalidations,
    };
  }

  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.clear();
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private cacheKey(request: LLMRequest): string {
    // Key = hash of full message content + model + temperature + tools
    // Does NOT change with system prompt changes — that's handled by systemPromptHash
    const payload = JSON.stringify({
      messages:    request.messages,
      model:       request.model       ?? '',
      temperature: request.temperature ?? 1,
      tools:       request.tools       ?? [],
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  private systemPromptHash(request: LLMRequest): string {
    // Hash of all system messages only — changes when instructions are updated
    const systemContent = request.messages
      .filter(m => m.role === 'system')
      .map(m => m.content)
      .join('\n');
    return createHash('sha256').update(systemContent).digest('hex').slice(0, 16);
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now - entry.createdAt > entry.ttlMs) this.store.delete(key);
    }
  }

  private evictLRU(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.store) {
      if (entry.lastHitAt < oldestTime) { oldestTime = entry.lastHitAt; oldest = key; }
    }
    if (oldest) this.store.delete(oldest);
  }

  private estimateSizeBytes(): number {
    let size = 0;
    for (const entry of this.store.values()) {
      size += JSON.stringify(entry.response).length * 2;
    }
    return size;
  }
}
