import { LLMRequest, ProviderName } from '../../src/types/index.js';
import { BaseProvider, RawProviderResponse } from '../../src/providers/BaseProvider.js';
import { AnthropicSystemBlock } from '../../src/types/index.js';

export interface MockProviderOptions {
  name?: ProviderName;
  model?: string;
  responses?: string[];
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Deterministic fake provider — no API calls, no network, no keys.
 * Captures every request so tests can inspect exactly what was sent.
 */
export class MockProvider extends BaseProvider {
  readonly name: ProviderName;
  readonly defaultModel: string;

  protected readonly fixedInputTokens: number;
  protected readonly fixedOutputTokens: number;
  private responses: string[];
  private _callCount = 0;

  public capturedRequests: LLMRequest[] = [];
  public capturedSystemBlocks: (AnthropicSystemBlock[] | undefined)[] = [];

  constructor(options: MockProviderOptions = {}) {
    super();
    this.name              = options.name          ?? 'openai';
    this.defaultModel      = options.model         ?? 'gpt-4o-mini';
    this.responses         = options.responses     ?? ['Mock response.'];
    this.fixedInputTokens  = options.inputTokens   ?? 100;
    this.fixedOutputTokens = options.outputTokens  ?? 20;
  }

  async send(request: LLMRequest, systemBlocks?: AnthropicSystemBlock[]): Promise<RawProviderResponse> {
    this.capturedRequests.push(structuredClone(request));
    this.capturedSystemBlocks.push(systemBlocks);
    const content = this.responses[this._callCount % this.responses.length];
    this._callCount++;
    return { content, model: this.defaultModel, inputTokens: this.fixedInputTokens, outputTokens: this.fixedOutputTokens, cachedTokens: 0 };
  }

  get callCount() { return this._callCount; }
  reset()         { this._callCount = 0; this.capturedRequests = []; this.capturedSystemBlocks = []; }
}

/**
 * Simulates Anthropic native cache — returns cache_read_input_tokens on repeated calls
 * with the same stable prefix.
 */
export class MockAnthropicProvider extends MockProvider {
  private seenHashes = new Set<string>();

  constructor(options: MockProviderOptions = {}) {
    super({ ...options, name: 'anthropic', model: options.model ?? 'claude-haiku-4-5' });
  }

  async send(request: LLMRequest, systemBlocks?: AnthropicSystemBlock[]): Promise<RawProviderResponse> {
    const raw      = await super.send(request, systemBlocks);
    const hash     = request.messages.map(m => m.content).join('|');
    const isCached = this.seenHashes.has(hash);
    this.seenHashes.add(hash);

    if (isCached && systemBlocks?.some(b => b.cache_control)) {
      return { ...raw, cachedTokens: this.fixedInputTokens, inputTokens: 0 };
    }
    return raw;
  }
}

// ─── Inspection helpers ───────────────────────────────────────────────────────

export function hasAnthropicCacheControl(provider: MockProvider): boolean {
  return provider.capturedSystemBlocks.some(
    blocks => blocks?.some(b => b.cache_control?.type === 'ephemeral')
  );
}
