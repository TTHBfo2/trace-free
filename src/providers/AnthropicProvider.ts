import { LLMRequest, LLMMessage } from '../types/index.js';
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

  async send(request: LLMRequest): Promise<RawProviderResponse> {
    const model = request.model ?? this.defaultModel;

    // Anthropic separates system prompt from messages
    const systemMsg = request.messages.find((m: LLMMessage) => m.role === 'system');
    const messages = request.messages
      .filter((m: LLMMessage) => m.role !== 'system')
      .map((m: LLMMessage) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const response = await this.client.messages.create({
      model,
      max_tokens: request.maxTokens ?? 1024,
      system: systemMsg?.content,
      messages,
      tools: request.tools?.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    });

    const textBlock = response.content.find((b: { type: string }) => b.type === 'text') as { type: 'text'; text: string } | undefined;
    const toolUseBlocks = response.content.filter((b: { type: string }) => b.type === 'tool_use') as Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>;

    const toolCalls = toolUseBlocks.map(b => ({
      id: b.id,
      name: b.name,
      arguments: b.input,
    }));

    return {
      content: textBlock?.text ?? '',
      model: response.model,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      rawResponse: response,
    };
  }
}
