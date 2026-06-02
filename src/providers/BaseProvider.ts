import { LLMRequest, LLMResponse, ProviderName } from '../types/index.js';

export interface RawProviderResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;           // provider-native cache read tokens (Anthropic)
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  rawResponse?: unknown;
}

export abstract class BaseProvider {
  abstract readonly name: ProviderName;
  abstract readonly defaultModel: string;

  abstract send(request: LLMRequest): Promise<RawProviderResponse>;

  buildResponse(
    raw: RawProviderResponse,
    requestId: string,
    latencyMs: number,
    cost: number,
    savings: number,
    cached: boolean,
    cacheType: LLMResponse['cacheType']
  ): LLMResponse {
    return {
      content: raw.content,
      model: raw.model,
      provider: this.name,
      usage: {
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        cachedTokens: 0,
        totalTokens: raw.inputTokens + raw.outputTokens,
      },
      cost,
      savings,
      cached,
      cacheType,
      requestId,
      latencyMs,
      ...(raw.toolCalls ? { toolCalls: raw.toolCalls } : {}),
    };
  }
}
