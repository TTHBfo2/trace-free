import { LLMRequest, LLMMessage, AnthropicSystemBlock } from '../types/index.js';
import { BaseProvider, RawProviderResponse } from './BaseProvider.js';

export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic' as const;
  readonly defaultModel = 'claude-haiku-4-5';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(client: any) {
    super();
    this.client = client;
  }

  async send(
    request: LLMRequest,
    // Pre-built cache_control system blocks from PromptCacheOptimizer (optional)
    systemBlocks?: AnthropicSystemBlock[]
  ): Promise<RawProviderResponse> {
    const model = request.model ?? this.defaultModel;

    // Build system: use pre-optimized blocks if supplied, else plain string
    const systemMsg = request.messages.find((m: LLMMessage) => m.role === 'system');
    const system: string | AnthropicSystemBlock[] | undefined =
      systemBlocks && systemBlocks.length > 0
        ? systemBlocks
        : systemMsg?.content;

    const messages = request.messages
      .filter((m: LLMMessage) => m.role !== 'system')
      .map((m: LLMMessage) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // Build tools — add cache_control to the last definition if flagged by optimizer
    const tools = request.tools?.map((t, i) => {
      const raw = t as LLMTool & { _cache?: boolean };
      const isLast = i === (request.tools!.length - 1);
      const entry: Record<string, unknown> = {
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      };
      if (raw._cache && isLast) {
        entry['cache_control'] = { type: 'ephemeral' };
      }
      return entry;
    });

    const response = await this.client.messages.create({
      model,
      max_tokens: request.maxTokens ?? 1024,
      system,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    const textBlock = response.content.find(
      (b: { type: string }) => b.type === 'text'
    ) as { type: 'text'; text: string } | undefined;

    const toolUseBlocks = response.content.filter(
      (b: { type: string }) => b.type === 'tool_use'
    ) as Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>;

    const toolCalls = toolUseBlocks.map(b => ({
      id: b.id,
      name: b.name,
      arguments: b.input,
    }));

    // Anthropic returns cache token counts when caching is active
    const cacheReadTokens  = (response.usage as { cache_read_input_tokens?: number })?.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = (response.usage as { cache_creation_input_tokens?: number })?.cache_creation_input_tokens ?? 0;

    return {
      content: textBlock?.text ?? '',
      model: response.model,
      inputTokens: (response.usage?.input_tokens ?? 0) + cacheWriteTokens,
      outputTokens: response.usage?.output_tokens ?? 0,
      cachedTokens: cacheReadTokens,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      rawResponse: response,
    };
  }
}

// Local import to avoid circular — LLMTool type for the tools mapping
interface LLMTool { name: string; description: string; parameters: Record<string, unknown> }
