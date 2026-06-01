import { LLMMessage } from '../types/index.js';
import { TokenCounter } from '../core/TokenCounter.js';

// Prunes stale or low-value messages from conversation context.
// Keeps system prompt + recent turns + messages that contain keywords
// referenced in the latest user message.

export interface PruneResult {
  messages: LLMMessage[];
  removedCount: number;
  tokensSaved: number;
}

const DEFAULT_MAX_TOKENS = 6_000;
const DEFAULT_KEEP_RECENT = 6; // always keep the last N non-system messages

export class ContextPruner {
  private counter: TokenCounter;
  private maxTokens: number;
  private keepRecent: number;

  constructor(options: { maxTokens?: number; keepRecent?: number; provider?: string } = {}) {
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
    this.counter = new TokenCounter(options.provider ?? 'openai');
  }

  prune(messages: LLMMessage[]): PruneResult {
    const originalCount = messages.length;
    const originalTokens = this.counter.countMessages(messages);

    if (originalTokens <= this.maxTokens) {
      return { messages, removedCount: 0, tokensSaved: 0 };
    }

    const system = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    // Always keep the most recent N messages
    const tail = nonSystem.slice(-this.keepRecent);
    const head = nonSystem.slice(0, -this.keepRecent);

    // Extract keywords from the latest user message for relevance scoring
    const latestUser = [...nonSystem].reverse().find(m => m.role === 'user');
    const keywords = latestUser ? extractKeywords(latestUser.content) : [];

    // Score older messages by relevance; drop lowest-scoring ones until under budget
    const scored = head.map(m => ({
      message: m,
      score: scoreRelevance(m.content, keywords),
    }));

    scored.sort((a, b) => b.score - a.score);

    const pruned: LLMMessage[] = [...system];
    let tokenBudget = this.maxTokens - this.counter.countMessages([...system, ...tail]);

    for (const { message } of scored) {
      const cost = this.counter.countTokens(message.content);
      if (tokenBudget - cost >= 0) {
        pruned.push(message);
        tokenBudget -= cost;
      }
      // Drop messages that don't fit
    }

    pruned.push(...tail);

    const newTokens = this.counter.countMessages(pruned);
    return {
      messages: pruned,
      removedCount: originalCount - pruned.length,
      tokensSaved: Math.max(0, originalTokens - newTokens),
    };
  }
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);
}

function scoreRelevance(content: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const lower = content.toLowerCase();
  const matches = keywords.filter(kw => lower.includes(kw)).length;
  return matches / keywords.length;
}
