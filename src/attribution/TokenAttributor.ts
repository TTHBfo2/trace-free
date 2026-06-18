import { LLMRequest, LLMTool, AttributionBreakdown, TokenCategory, ModelPricing } from '../types/index.js';
import { TokenCounter } from '../core/TokenCounter.js';

// RAG content patterns — common markers used by LangChain, LlamaIndex, raw RAG systems
const RAG_TAG_PATTERNS = [
  /<document[\s>]/i, /<context[\s>]/i, /<retrieved[\s>]/i,
  /<chunk[\s>]/i, /<passage[\s>]/i, /<source[\s>]/i,
  /\[Document \d+\]/i, /\[Source \d+\]/i, /\[Chunk \d+\]/i,
  /---+\n.*\n---+/,   // horizontal-rule-wrapped blocks (common in RAG)
];

// Minimum tokens for a block to be classified as a RAG chunk vs inline content
const RAG_MIN_TOKENS = 150;

export class TokenAttributor {
  private counter: TokenCounter;

  constructor(provider = 'openai') {
    this.counter = new TokenCounter(provider);
  }

  /**
   * Break down a request into attribution categories.
   *
   * @param realInputTokens - When provided (from provider usage response), all input
   *   categories are rescaled proportionally so they sum to this exact total. This
   *   eliminates the ±10% tokenizer approximation error at the total level while
   *   preserving accurate relative proportions across categories.
   */
  attribute(
    request: LLMRequest,
    outputTokens: number,
    pricing: ModelPricing,
    realInputTokens?: number,
  ): AttributionBreakdown {
    const systemMessages    = request.messages.filter(m => m.role === 'system');
    const nonSystemMessages = request.messages.filter(m => m.role !== 'system');
    const lastUserMsg       = [...nonSystemMessages].reverse().find(m => m.role === 'user');
    const historyMessages   = nonSystemMessages.filter(m => m !== lastUserMsg);

    // Raw token counts per category (using BPE if tiktoken available, 4-char/token otherwise)
    const systemRaw = systemMessages.reduce((s, m) => s + m.content, '');
    const { systemTokens: rawSystem, ragTokensFromSystem } = this.splitSystemAndRag(systemRaw);

    const rawTool = this.countToolTokens(request.tools ?? []);

    const ragFromMessages = historyMessages.reduce((sum, m) => {
      return sum + (this.isRagContent(m.content) ? this.counter.countText(m.content) : 0);
    }, 0);
    const rawRag     = ragTokensFromSystem + ragFromMessages;
    const rawHistory = historyMessages.reduce((sum, m) => {
      const t = this.counter.countText(m.content);
      return sum + (this.isRagContent(m.content) ? 0 : t);
    }, 0);
    const rawUser = lastUserMsg ? this.counter.countText(lastUserMsg.content) : 0;

    const estimatedTotal = rawSystem + rawTool + rawRag + rawHistory + rawUser;

    // Rescale categories to match provider-reported total when available.
    // This makes the sum exact at the total level while preserving proportions.
    let systemT = rawSystem, toolT = rawTool, ragT = rawRag, historyT = rawHistory, userT = rawUser;
    if (realInputTokens !== undefined && realInputTokens > 0 && estimatedTotal > 0) {
      const scale = realInputTokens / estimatedTotal;
      systemT  = Math.round(rawSystem  * scale);
      toolT    = Math.round(rawTool    * scale);
      ragT     = Math.round(rawRag     * scale);
      historyT = Math.round(rawHistory * scale);
      // Last category absorbs rounding remainder so sum = realInputTokens exactly
      userT    = realInputTokens - systemT - toolT - ragT - historyT;
      if (userT < 0) {
        // Edge case: rounding pushed us over; trim the largest category
        systemT = Math.max(0, systemT + userT);
        userT   = 0;
      }
    }

    const totalInput = realInputTokens ?? estimatedTotal;
    const totalCost  = (totalInput / 1_000_000) * pricing.inputPerMillion
                     + (outputTokens / 1_000_000) * pricing.outputPerMillion;

    const makeCategory = (tokens: number, isOutput = false): TokenCategory => {
      const cost = isOutput
        ? (tokens / 1_000_000) * pricing.outputPerMillion
        : (tokens / 1_000_000) * pricing.inputPerMillion;
      const base = totalInput + outputTokens;
      return {
        tokens,
        estimatedCost: cost,
        percentOfTotal: base > 0 ? parseFloat(((tokens / base) * 100).toFixed(1)) : 0,
      };
    };

    return {
      systemPrompt:        makeCategory(systemT),
      toolSchemas:         makeCategory(toolT),
      ragChunks:           makeCategory(ragT),
      conversationHistory: makeCategory(historyT),
      userQuery:           makeCategory(userT),
      outputTokens:        makeCategory(outputTokens, true),
      totalInputTokens:    totalInput,
      totalOutputTokens:   outputTokens,
      totalCost,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private splitSystemAndRag(systemText: string): { systemTokens: number; ragTokensFromSystem: number } {
    if (!systemText) return { systemTokens: 0, ragTokensFromSystem: 0 };

    const blocks = systemText.split(/\n{2,}/);
    let systemTokens = 0;
    let ragTokensFromSystem = 0;

    for (const block of blocks) {
      const t = this.counter.countText(block);
      if (t >= RAG_MIN_TOKENS && this.isRagContent(block)) {
        ragTokensFromSystem += t;
      } else {
        systemTokens += t;
      }
    }
    return { systemTokens, ragTokensFromSystem };
  }

  private isRagContent(text: string): boolean {
    if (!text) return false;
    return RAG_TAG_PATTERNS.some(p => p.test(text));
  }

  private countToolTokens(tools: LLMTool[]): number {
    if (tools.length === 0) return 0;
    return this.counter.countText(JSON.stringify(tools));
  }
}
