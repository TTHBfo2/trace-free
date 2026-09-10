import { LLMRequest, LLMResponse, CacheStats } from '../types/index.js';

// Semantic similarity cache.
// Uses all-MiniLM-L6-v2 sentence embeddings via @huggingface/transformers when available
// (q8 quantized ONNX, ~23MB, downloaded once and cached on disk — no API call, no internet
// after first download). Falls back to character trigram TF-IDF when not installed.
//
// @huggingface/transformers is the actively-maintained successor to @xenova/transformers
// (same original author, moved to the Hugging Face npm scope) — used here specifically
// because it resolves a current, non-vulnerable protobufjs via its onnxruntime-web
// dependency, where @xenova/transformers (abandoned at 2.17.2) is pinned to an old
// onnxruntime-web that drags in a protobufjs version with a critical CVE.
//
// Disabled by default — enable with: cache: { semantic: { enabled: true } }
// Install embeddings support: npm install @huggingface/transformers

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
const DEFAULT_TTL_MS    = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

// ─── Embedder singleton ───────────────────────────────────────────────────────
// Shared across all SemanticCache instances — model loads once per process.

type EmbedderFn = (text: string) => Promise<Float32Array>;
let embedderPromise: Promise<EmbedderFn | null> | null = null;

async function loadEmbedder(): Promise<EmbedderFn | null> {
  try {
    // Dynamic import keeps the package loadable even when @huggingface/transformers is absent.
    const { pipeline } = await import('@huggingface/transformers');
    // dtype: 'q8' → 8-bit quantized ONNX, ~23MB vs ~90MB for fp32; minimal quality loss for
    // similarity. Replaces the old `quantized: true` boolean — @huggingface/transformers'
    // pipeline() dropped that option in favor of an explicit dtype string (same behavior,
    // renamed API; this is not a downgrade in quantization, just the new option name).
    const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
    return async (text: string): Promise<Float32Array> => {
      const output = await (pipe as (t: string, opts: Record<string, unknown>) => Promise<{ data: ArrayLike<number> }>)(
        text, { pooling: 'mean', normalize: true },
      );
      return new Float32Array(output.data);
    };
  } catch {
    // @huggingface/transformers not installed or WASM failed — trigram fallback is used silently
    return null;
  }
}

// ─── Cache class ─────────────────────────────────────────────────────────────

export class SemanticCache {
  private store: SemanticEntry[] = [];
  private threshold: number;
  private ttlMs: number;
  private maxEntries: number;
  private hitCount = 0;
  private missCount = 0;

  constructor(options: { similarityThreshold?: number; ttlMs?: number; maxEntries?: number } = {}) {
    this.threshold  = options.similarityThreshold ?? DEFAULT_THRESHOLD;
    this.ttlMs      = options.ttlMs      ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async get(request: LLMRequest): Promise<LLMResponse | null> {
    const queryText = this.extractQueryText(request);
    const queryVec  = await this.vectorize(queryText);
    const now       = Date.now();

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

  async set(request: LLMRequest, response: LLMResponse): Promise<void> {
    if (this.store.length >= this.maxEntries) this.evictLRU();
    this.evictExpired();

    const queryText = this.extractQueryText(request);
    this.store.push({
      response,
      vector:    await this.vectorize(queryText),
      queryText,
      createdAt: Date.now(),
      ttlMs:     this.ttlMs,
      hitCount:  0,
      lastHitAt: Date.now(),
    });
  }

  clear(): void {
    this.store     = [];
    this.hitCount  = 0;
    this.missCount = 0;
  }

  stats(): CacheStats {
    const total = this.hitCount + this.missCount;
    return {
      totalEntries: this.store.length,
      hitCount:     this.hitCount,
      missCount:    this.missCount,
      hitRate:      total > 0 ? parseFloat(((this.hitCount / total) * 100).toFixed(1)) : 0,
      sizeBytes:    this.store.length * 512,
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async vectorize(text: string): Promise<Float32Array> {
    if (!embedderPromise) embedderPromise = loadEmbedder();
    const embedder = await embedderPromise;
    if (embedder) {
      try {
        return await embedder(text);
      } catch {
        // Inference failed (e.g. Float32Array VM-context mismatch in test runners) — fall through
      }
    }
    return trigramTfIdf(text);
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

  private evictExpired(): void {
    const now = Date.now();
    this.store = this.store.filter(e => now - e.createdAt <= e.ttlMs);
  }

  private evictLRU(): void {
    if (this.store.length === 0) return;
    let minTime = Infinity;
    let minIdx  = 0;
    for (let i = 0; i < this.store.length; i++) {
      if (this.store[i].lastHitAt < minTime) { minTime = this.store[i].lastHitAt; minIdx = i; }
    }
    this.store.splice(minIdx, 1);
  }
}

// ─── Trigram fallback (character TF-IDF) ─────────────────────────────────────

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
  const a = str.charCodeAt(i)     & 0xff;
  const b = str.charCodeAt(i + 1) & 0xff;
  const c = str.charCodeAt(i + 2) & 0xff;
  let h = ((a ^ 0x811c9dc5) * 0x01000193) >>> 0;
  h     = ((h ^ b)          * 0x01000193) >>> 0;
  h     = ((h ^ c)          * 0x01000193) >>> 0;
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
  return Math.max(0, Math.min(1, dot));
}
