import { LLMRequest, LLMResponse, CacheStats } from '../types/index.js';

// Local-first semantic similarity cache — zero extra AI calls.
// Uses character trigram TF-IDF vectors + cosine similarity.
// No external dependencies, no inference calls, runs entirely in-process.

interface SemanticEntry {
  response: LLMResponse;
  vector: Float32Array;
  queryText: string;
  createdAt: number;
  ttlMs: number;
  hitCount: number;
  lastHitAt: number;
}

const DEFAULT_THRESHOLD = 0.92;
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_ENTRIES = 500;

export class SemanticCache {
  private store: SemanticEntry[] = [];
  private threshold: number;
  private ttlMs: number;
  private maxEntries: number;
  private hitCount = 0;
  private missCount = 0;

  constructor(options: { similarityThreshold?: number; ttlMs?: number; maxEntries?: number } = {}) {
    this.threshold = options.similarityThreshold ?? DEFAULT_THRESHOLD;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  get(request: LLMRequest): LLMResponse | null {
    const queryText = this.extractQueryText(request);
    const queryVec = this.vectorize(queryText);
    const now = Date.now();

    let bestSimilarity = 0;
    let bestEntry: SemanticEntry | null = null;

    for (const entry of this.store) {
      if (now - entry.createdAt > entry.ttlMs) continue;
      const sim = cosineSimilarity(queryVec, entry.vector);
      if (sim > bestSimilarity) { bestSimilarity = sim; bestEntry = entry; }
    }

    if (bestEntry && bestSimilarity >= this.threshold) {
      bestEntry.hitCount++;
      bestEntry.lastHitAt = now;
      this.hitCount++;
      return bestEntry.response;
    }

    this.missCount++;
    return null;
  }

  set(request: LLMRequest, response: LLMResponse): void {
    if (this.store.length >= this.maxEntries) this.evictLRU();
    this.evictExpired();

    const queryText = this.extractQueryText(request);
    this.store.push({
      response,
      vector: this.vectorize(queryText),
      queryText,
      createdAt: Date.now(),
      ttlMs: this.ttlMs,
      hitCount: 0,
      lastHitAt: Date.now(),
    });
  }

  clear(): void {
    this.store = [];
    this.hitCount = 0;
    this.missCount = 0;
  }

  stats(): CacheStats {
    const total = this.hitCount + this.missCount;
    return {
      totalEntries: this.store.length,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: total > 0 ? parseFloat(((this.hitCount / total) * 100).toFixed(1)) : 0,
      sizeBytes: this.store.length * 512, // rough estimate
    };
  }

  private extractQueryText(request: LLMRequest): string {
    return request.messages
      .filter(m => m.role === 'user' || m.role === 'system')
      .map(m => m.content)
      .join(' ')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  private vectorize(text: string): Float32Array {
    return trigramTfIdf(text);
  }

  private evictExpired(): void {
    const now = Date.now();
    this.store = this.store.filter(e => now - e.createdAt <= e.ttlMs);
  }

  private evictLRU(): void {
    if (this.store.length === 0) return;
    let minTime = Infinity;
    let minIdx = 0;
    for (let i = 0; i < this.store.length; i++) {
      if (this.store[i].lastHitAt < minTime) { minTime = this.store[i].lastHitAt; minIdx = i; }
    }
    this.store.splice(minIdx, 1);
  }
}

// ─── Local trigram vectorizer ─────────────────────────────────────────────────

const VECTOR_SIZE = 1024;

function trigramTfIdf(text: string): Float32Array {
  const vec = new Float32Array(VECTOR_SIZE);
  if (!text) return vec;

  const padded = `  ${text}  `;
  const counts = new Map<number, number>();

  for (let i = 0; i < padded.length - 2; i++) {
    const bucket = trigramBucket(padded, i);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  const totalTrigrams = padded.length - 2;
  for (const [bucket, count] of counts) {
    vec[bucket] = count / totalTrigrams;
  }

  return normalize(vec);
}

function trigramBucket(str: string, i: number): number {
  const a = str.charCodeAt(i) & 0xff;
  const b = str.charCodeAt(i + 1) & 0xff;
  const c = str.charCodeAt(i + 2) & 0xff;
  // FNV-1a mix into [0, VECTOR_SIZE)
  let h = ((a ^ 0x811c9dc5) * 0x01000193) >>> 0;
  h = ((h ^ b) * 0x01000193) >>> 0;
  h = ((h ^ c) * 0x01000193) >>> 0;
  return h % VECTOR_SIZE;
}

function normalize(vec: Float32Array): Float32Array {
  let mag = 0;
  for (const v of vec) mag += v * v;
  mag = Math.sqrt(mag);
  if (mag === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] /= mag;
  return vec;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // Both vectors are already normalized
  return Math.max(0, Math.min(1, dot));
}
