import { LLMRequest } from '../types/index.js';
import { BaseProvider, RawProviderResponse } from './BaseProvider.js';
import { TokenCounter } from '../core/TokenCounter.js';

export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini' as const;
  readonly defaultModel = 'gemini-1.5-flash';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private counter = new TokenCounter('gemini');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(client: any) {
    super();
    this.client = client;
  }

  async send(request: LLMRequest): Promise<RawProviderResponse> {
    const modelName = request.model ?? this.defaultModel;
    const model = this.client.getGenerativeModel({ model: modelName });

    const history = request.messages
      .filter(m => m.role !== 'system')
      .slice(0, -1)
      .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    const lastMessage = request.messages.filter(m => m.role !== 'system').at(-1);
    const systemInstruction = request.messages.find(m => m.role === 'system')?.content;

    const chat = model.startChat({
      history,
      systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
    });

    const result = await chat.sendMessage(lastMessage?.content ?? '');
    const responseText = result.response.text();

    // Gemini SDK doesn't always return token counts; estimate them
    const inputTokens = this.counter.countMessages(request.messages);
    const outputTokens = this.counter.countText(responseText);

    return {
      content: responseText,
      model: modelName,
      inputTokens,
      outputTokens,
      rawResponse: result,
    };
  }
}
