import { LLMRequest } from '../types/index.js';
import { BaseProvider, RawProviderResponse } from './BaseProvider.js';

// Groq uses the OpenAI-compatible SDK interface
export class GroqProvider extends BaseProvider {
  readonly name = 'groq' as const;
  readonly defaultModel = 'llama-3.3-70b-versatile';

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
    });

    const choice = response.choices[0];

    return {
      content: choice.message.content ?? '',
      model: response.model ?? model,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      rawResponse: response,
    };
  }
}
