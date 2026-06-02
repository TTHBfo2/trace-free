import { CostEntry, WasteEntry, WasteFlag, LLMRequest } from '../types/index.js';

const OVERSIZED_THRESHOLD = 8_000;
const REDUNDANCY_WINDOW_MS = 60_000;
const PREMIUM_INPUT_TOKEN_LIMIT = 500;

export class WasteDetector {
  private recentHashes = new Map<string, number>();

  detectFlags(request: LLMRequest, entry: Omit<CostEntry, 'wasteFlags'>, cheapestCostPerToken: number): WasteFlag[] {
    const flags: WasteFlag[] = [];
    const { inputTokens, outputTokens, cost, cached } = entry;
    const promptHash = this.hashRequest(request);
    const now = Date.now();

    const lastSeen = this.recentHashes.get(promptHash);
    if (lastSeen && now - lastSeen < REDUNDANCY_WINDOW_MS) flags.push('redundant_request');
    this.recentHashes.set(promptHash, now);
    this.pruneOldHashes(now);

    if (inputTokens > OVERSIZED_THRESHOLD) flags.push('oversized_context');

    if (inputTokens > 2_000 && outputTokens < inputTokens * 0.05) flags.push('stale_context');

    const costPerInputToken = cost / Math.max(inputTokens, 1);
    if (cheapestCostPerToken > 0 && costPerInputToken > cheapestCostPerToken * 10 && inputTokens < PREMIUM_INPUT_TOKEN_LIMIT) {
      flags.push('premium_for_simple');
    }

    if (!cached && inputTokens < 200 && outputTokens < 100) flags.push('missed_cache_hit');

    return flags;
  }

  buildWasteEntry(entry: CostEntry): WasteEntry {
    return {
      requestId:      entry.requestId,
      timestamp:      entry.timestamp,
      flags:          entry.wasteFlags,
      estimatedWaste: entry.cost * 0.7,
      model:          entry.model,
      provider:       entry.provider,
    };
  }

  private hashRequest(request: LLMRequest): string {
    const normalized = request.messages.map(m => `${m.role}:${m.content.trim().toLowerCase()}`).join('|');
    return simpleHash(normalized);
  }

  private pruneOldHashes(now: number): void {
    for (const [hash, ts] of this.recentHashes) {
      if (now - ts > REDUNDANCY_WINDOW_MS * 2) this.recentHashes.delete(hash);
    }
  }
}

function simpleHash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h = ((h ^ str.charCodeAt(i)) * 0x01000193) >>> 0;
  }
  return h.toString(16);
}
