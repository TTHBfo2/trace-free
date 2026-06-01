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

    return {
      content: choice.message.content ?? '',
      model: response.model,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      toolCalls,
      rawResponse: response,
    };
  }
}
