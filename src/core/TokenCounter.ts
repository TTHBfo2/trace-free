import { LLMMessage } from '../types/index.js';

// Approximation: ~4 chars per token for English prose (GPT-style BPE)
const CHARS_PER_TOKEN = 4;

// Per-provider message overhead in tokens (role + formatting)
const MESSAGE_OVERHEAD: Record<string, number> = {
  openai: 4,
  anthropic: 3,
  gemini: 2,
  groq: 4,
  ollama: 3,
  custom: 3,
};

export class TokenCounter {
  private provider: string;

  constructor(provider = 'openai') {
    this.provider = provider;
  }

  countText(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  countMessages(messages: LLMMessage[]): number {
    const overhead = MESSAGE_OVERHEAD[this.provider] ?? 3;
    let total = 3; // baseline reply priming
    for (const msg of messages) {
      total += overhead;
      total += this.countText(msg.content);
      if (msg.name) total += 1;
    }
    return total;
  }

  countTokens(input: string | LLMMessage[]): number {
    if (typeof input === 'string') return this.countText(input);
    return this.countMessages(input);
  }

  estimateCost(
    inputTokens: number,
    outputTokens: number,
    inputPerMillion: number,
    outputPerMillion: number
  ): number {
    return (
      (inputTokens / 1_000_000) * inputPerMillion +
      (outputTokens / 1_000_000) * outputPerMillion
    );
  }
}
