import { LLMMessage, LLMTool } from '../types/index.js';
import { TokenCounter } from '../core/TokenCounter.js';

// Minimum tools before filtering kicks in — no point filtering if there are only 1-2
const MIN_TOOLS_TO_FILTER = 3;

// If fewer than this many tools match the current step, include everything (conservative fallback)
const MIN_MATCH_THRESHOLD = 2;

export interface FilterResult {
  tools: LLMTool[];
  originalCount: number;
  filteredCount: number;
  tokensSaved: number;
  reasoning: string;
}

/**
 * Filters tool schemas to only include tools relevant to the current agent step.
 *
 * In a multi-step agent, every message carries ALL tool definitions — even when
 * the agent is clearly doing "summarize this text" and only needs the summarize
 * tool, not the web_search, file_read, and database_query tools.
 *
 * This is deterministic, zero extra AI calls — pure keyword/intent matching.
 * Conservative by design: when in doubt, include everything.
 */
export class ToolSchemaFilter {
  private counter: TokenCounter;

  constructor() {
    this.counter = new TokenCounter();
  }

  filter(tools: LLMTool[], messages: LLMMessage[]): FilterResult {
    const originalCount  = tools.length;
    const originalTokens = this.counter.countText(JSON.stringify(tools));

    if (tools.length < MIN_TOOLS_TO_FILTER) {
      return { tools, originalCount, filteredCount: originalCount, tokensSaved: 0, reasoning: 'Too few tools to filter' };
    }

    const recentlyUsed  = this.extractRecentlyUsedTools(messages);
    const intentKeywords = this.extractIntentKeywords(messages);
    const scores         = this.scoreTools(tools, intentKeywords, recentlyUsed);

    // Keep tools scoring above threshold, always keep recently-used tools
    const relevant = tools.filter(t => {
      const score = scores.get(t.name) ?? 0;
      return score > 0 || recentlyUsed.has(t.name);
    });

    // Conservative fallback: if too few matched, include everything
    if (relevant.length < MIN_MATCH_THRESHOLD) {
      return { tools, originalCount, filteredCount: originalCount, tokensSaved: 0, reasoning: `Only ${relevant.length} tools matched — including all to stay safe` };
    }

    const filteredTokens = this.counter.countText(JSON.stringify(relevant));
    const tokensSaved    = Math.max(0, originalTokens - filteredTokens);

    return {
      tools:         relevant,
      originalCount,
      filteredCount: relevant.length,
      tokensSaved,
      reasoning:     `Filtered ${originalCount - relevant.length} irrelevant tool(s), saving ${tokensSaved} tokens`,
    };
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private extractRecentlyUsedTools(messages: LLMMessage[]): Set<string> {
    // Look at the last 3 assistant messages for tool call names
    const recentAssistant = messages
      .filter(m => m.role === 'assistant')
      .slice(-3)
      .map(m => m.content);

    const used = new Set<string>();
    for (const content of recentAssistant) {
      // Common tool call patterns in stringified tool results
      const matches = content.matchAll(/"(?:tool_name|name|function)"\s*:\s*"([^"]+)"/g);
      for (const match of matches) used.add(match[1]);
    }
    return used;
  }

  private extractIntentKeywords(messages: LLMMessage[]): string[] {
    // Focus on the last 2 messages (current step context)
    const recent = messages.slice(-2).map(m => m.content).join(' ');
    return recent
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .filter(w => !STOP_WORDS.has(w));
  }

  private scoreTools(tools: LLMTool[], keywords: string[], recentlyUsed: Set<string>): Map<string, number> {
    const scores = new Map<string, number>();

    for (const tool of tools) {
      const toolText = `${tool.name} ${tool.description}`.toLowerCase().replace(/_/g, ' ');
      let score = 0;

      // Score by keyword overlap with tool name and description
      for (const kw of keywords) {
        if (toolText.includes(kw)) score += 1;
      }

      // Bonus for recently used tools
      if (recentlyUsed.has(tool.name)) score += 3;

      scores.set(tool.name, score);
    }

    return scores;
  }
}

const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'will', 'what', 'when', 'where',
  'which', 'they', 'them', 'then', 'than', 'been', 'were', 'does', 'want',
  'need', 'make', 'like', 'just', 'know', 'time', 'some', 'your', 'into',
  'more', 'also', 'about', 'over', 'after', 'could', 'other', 'their',
]);
