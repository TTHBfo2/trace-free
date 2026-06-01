import { CostEntry, WasteEntry, WasteFlag, LLMRequest } from '../types/index.js';
import { TokenCounter } from './TokenCounter.js';

// Tokens above this in a single request are flagged as oversized
const OVERSIZED_THRESHOLD = 8_000;

// If the same normalized prompt hash appeared within this window, it's redundant
const REDUNDANCY_WINDOW_MS = 60_000;

// If a model costs >10x the cheapest available and the request is short, flag it
const PREMIUM_INPUT_TOKEN_LIMIT = 500;

export class WasteDetector {
  private counter: TokenCounter;
  private recentHashes = new Map<string, number>(); // hash → timestamp

  constructor(provider = 'openai') {
    this.counter = new TokenCounter(provider);
  }

  detectFlags(request: LLMRequest, entry: Omit<CostEntry, 'wasteFlags'>, cheapestCostPerToken: number): WasteFlag[] {
    const flags: WasteFlag[] = [];

    const inputTokens = entry.inputTokens;
    const promptHash = this.hashRequest(request);
    const now = Date.now();

    // Redundant request: same prompt seen within the window
    const lastSeen = this.recentHashes.get(promptHash);
    if (lastSeen && now - lastSeen < REDUNDANCY_WINDOW_MS) {
      flags.push('redundant_request');
    }
    this.recentHashes.set(promptHash, now);
    this.pruneOldHashes(now);

    // Oversized context
    if (inputTokens > OVERSIZED_THRESHOLD) {
      flags.push('oversized_context');
    }

    // Stale context: lots of tokens but very short expected output (< 5% of input)
    const outputTokens = entry.outputTokens;
    if (inputTokens > 2_000 && outputTokens < inputTokens * 0.05) {
      flags.push('stale_context');
    }

    // Premium model for a simple request
    const costPerInputToken = entry.cost / Math.max(inputTokens, 1);
    if (
      cheapestCostPerToken > 0 &&
      costPerInputToken > cheapestCostPerToken * 10 &&
      inputTokens < PREMIUM_INPUT_TOKEN_LIMIT
    ) {
      flags.push('premium_for_simple');
    }

    // Missed cache hit: not cached but is a very short unique prompt (low information density)
    if (!entry.cached && inputTokens < 200 && outputTokens < 100) {
      flags.push('missed_cache_hit');
    }

    return flags;
  }

  buildWasteEntry(entry: CostEntry): WasteEntry {
    const wastePerFlag = entry.cost / Math.max(entry.wasteFlags.length, 1);
    return {
      requestId: entry.requestId,
      timestamp: entry.timestamp,
      flags: entry.wasteFlags,
      estimatedWaste: entry.cost * 0.7, // conservative: 70% of flagged cost is recoverable
      model: entry.model,
      provider: entry.provider,
    };
  }

  private hashRequest(request: LLMRequest): string {
    const normalized = request.messages
      .map(m => `${m.role}:${m.content.trim().toLowerCase()}`)
      .join('|');
    return simpleHash(normalized);
  }

  private pruneOldHashes(now: number): void {
    for (const [hash, ts] of this.recentHashes) {
      if (now - ts > REDUNDANCY_WINDOW_MS * 2) {
        this.recentHashes.delete(hash);
      }
    }
  }
}

function simpleHash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}
