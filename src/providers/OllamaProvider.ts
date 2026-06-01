import { LLMRequest } from '../types/index.js';
import { BaseProvider, RawProviderResponse } from './BaseProvider.js';
import { TokenCounter } from '../core/TokenCounter.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';

export class OllamaProvider extends BaseProvider {
  readonly name = 'ollama' as const;
  readonly defaultModel = 'llama3';

  private baseUrl: string;
  private counter = new TokenCounter('ollama');

  constructor(options: { baseUrl?: string; model?: string } = {}) {
    super();
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    if (options.model) this.defaultModel = options.model;
  }

  // TypeScript won't let us reassign readonly, so we use an override
  private _model?: string;
  get model(): string { return this._model ?? this.defaultModel; }

  async send(request: LLMRequest): Promise<RawProviderResponse> {
    const model = request.model ?? this.defaultModel;

    const body = {
      model,
      messages: request.messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
      options: {
        num_predict: request.maxTokens,
        temperature: request.temperature,
      },
    };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const content = data.message?.content ?? '';
    const inputTokens = data.prompt_eval_count ?? this.counter.countMessages(request.messages);
    const outputTokens = data.eval_count ?? this.counter.countText(content);

    return { content, model, inputTokens, outputTokens };
  }
}
