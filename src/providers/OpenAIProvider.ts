import { LLMRequest } from '../types/index.js';
import { BaseProvider, RawProviderResponse } from './BaseProvider.js';

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai' as const;
  readonly defaultModel = 'gpt-4o-mini';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(client: any) {
    super();
    this.client = client;
  }

  async send(request: LLMRequest): Promise<RawProviderResponse> {
    const model = request.model ?? this.defaultModel;

    const response = await this.client.chat.completions.create({
      model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      tools: request.tools?.map(t => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    });

    const choice = response.choices[0];
    const toolCalls = choice.message.tool_calls?.map((tc: { id: string; function: { name: string; arguments: string } }) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments ?? '{}') as Record<string, unknown>,
    }));

    // OpenAI's automatic prompt cache. `prompt_tokens` is the TOTAL prompt and
    // `cached_tokens` a SUBSET of it — the opposite of Anthropic, whose
    // input_tokens excludes cache reads. CostEngine adds inputTokens and
    // cachedTokens together, so the cached part is subtracted here to match the
    // convention AnthropicProvider already follows. Previously this field was
    // never read at all, so cached tokens were billed at the full input rate.
    const promptTokens = response.usage?.prompt_tokens ?? 0;
    const cachedTokens = Math.min(
      (response.usage as { prompt_tokens_details?: { cached_tokens?: number } })?.prompt_tokens_details?.cached_tokens ?? 0,
      promptTokens,
    );

    return {
      content: choice.message.content ?? '',
      model: response.model,
      inputTokens: promptTokens - cachedTokens,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cachedTokens,
      toolCalls,
      rawResponse: response,
    };
  }
}
