import { LLMMessage } from '../types/index.js';

// Deterministic prompt compression — zero extra AI calls.
// Applies rule-based transformations to reduce token count without changing meaning.

export interface CompressionResult {
  messages: LLMMessage[];
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  reductionPercent: number;
}

const CHARS_PER_TOKEN = 4;

export class PromptCompressor {
  compress(messages: LLMMessage[]): CompressionResult {
    const originalChars = messages.reduce((s, m) => s + m.content.length, 0);

    const compressed = messages.map(m => ({
      ...m,
      content: this.compressContent(m.content),
    }));

    const compressedChars = compressed.reduce((s, m) => s + m.content.length, 0);
    const originalTokens = Math.ceil(originalChars / CHARS_PER_TOKEN);
    const compressedTokens = Math.ceil(compressedChars / CHARS_PER_TOKEN);
    const reductionPercent = originalTokens > 0
      ? parseFloat((((originalTokens - compressedTokens) / originalTokens) * 100).toFixed(1))
      : 0;

    return { messages: compressed, originalTokenEstimate: originalTokens, compressedTokenEstimate: compressedTokens, reductionPercent };
  }

  private compressContent(text: string): string {
    let result = text;
    result = collapseBlankLines(result);
    result = trimLineTrailingSpace(result);
    result = collapseInlineSpaces(result);
    result = stripHtmlComments(result);
    result = collapseFiller(result);
    return result.trim();
  }
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

function trimLineTrailingSpace(text: string): string {
  return text.replace(/[ \t]+$/gm, '');
}

function collapseInlineSpaces(text: string): string {
  return text.replace(/[ \t]{2,}/g, ' ');
}

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

// Removes unambiguous filler phrases that add tokens without meaning.
function collapseFiller(text: string): string {
  return text
    .replace(/^as an ai(?: language model)?[,.]?\s*/im, '')
    .replace(/^(certainly|of course|sure|absolutely|great|fantastic)[!.]?\s+/im, '')
    .replace(/\bplease note that\b\s*/gi, '')
    .replace(/\bit(?:'s| is) worth noting that\b\s*/gi, '');
}
