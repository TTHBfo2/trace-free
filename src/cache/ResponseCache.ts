import { createHash } from 'crypto';
import { LLMRequest, LLMResponse, CacheStats } from '../types/index.js';

interface CacheEntry {
  response: LLMResponse;
  createdAt: number;
  ttlMs: number;
  hitCount: number;
  lastHitAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;   // 5 minutes
const DEFAULT_MAX_ENTRIES = 2_000;

export class ResponseCache {
  private store = new Map<string, CacheEntry>();
  private hitCount = 0;
  private missCount = 0;
  private ttlMs: number;
  private maxEntries: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.cleanupTimer = setInterval(() => this.evictExpired(), 60_000);
  }

  get(request: LLMRequest): LLMResponse | null {
    const key = this.cacheKey(request);
    const entry = this.store.get(key);

    if (!entry) { this.missCount++; return null; }
    if (Date.now() - entry.createdAt > entry.ttlMs) {
      this.store.delete(key);
      this.missCount++;
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
      createdAt: Date.now(),
      ttlMs: this.ttlMs,
      hitCount: 0,
      lastHitAt: Date.now(),
    });
  }

  invalidate(request: LLMRequest): void {
    this.store.delete(this.cacheKey(request));
  }

  clear(): void {
    this.store.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }

  stats(): CacheStats {
    const total = this.hitCount + this.missCount;
    return {
      totalEntries: this.store.size,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: total > 0 ? parseFloat(((this.hitCount / total) * 100).toFixed(1)) : 0,
      sizeBytes: this.estimateSizeBytes(),
    };
  }

  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.clear();
  }

  private cacheKey(request: LLMRequest): string {
    const payload = JSON.stringify({
      messages: request.messages,
      model: request.model ?? '',
      temperature: request.temperature ?? 1,
      tools: request.tools ?? [],
    });
    return createHash('sha256').update(payload).digest('hex');
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
