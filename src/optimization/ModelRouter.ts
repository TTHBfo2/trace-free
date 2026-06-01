import { LLMRequest, ModelPricing, ProviderName } from '../types/index.js';
import { TokenCounter } from '../core/TokenCounter.js';

// Routes requests to the cheapest model capable of handling the task.
// Decision is fully deterministic — no inference calls.

export interface RoutingDecision {
  model: string;
  provider: ProviderName;
  reasoning: string;
  estimatedSavings?: number;
}

interface ModelSpec {
  model: string;
  provider: ProviderName;
  pricing: ModelPricing;
  maxContextTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  quality: 'budget' | 'standard' | 'premium';
}

const MODEL_REGISTRY: ModelSpec[] = [
  // Budget tier
  { model: 'gpt-4o-mini',           provider: 'openai',    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.60 },  maxContextTokens: 128_000, supportsTools: true,  supportsVision: true,  quality: 'budget' },
  { model: 'claude-haiku-4-5',      provider: 'anthropic', pricing: { inputPerMillion: 0.80, outputPerMillion: 4.00 },  maxContextTokens: 200_000, supportsTools: true,  supportsVision: false, quality: 'budget' },
  { model: 'gemini-1.5-flash',      provider: 'gemini',    pricing: { inputPerMillion: 0.075, outputPerMillion: 0.30 }, maxContextTokens: 1_000_000, supportsTools: true, supportsVision: true, quality: 'budget' },
  { model: 'llama-3.1-8b-instant',  provider: 'groq',      pricing: { inputPerMillion: 0.05, outputPerMillion: 0.08 },  maxContextTokens: 128_000, supportsTools: false, supportsVision: false, quality: 'budget' },
  // Standard tier
  { model: 'gpt-4o',                provider: 'openai',    pricing: { inputPerMillion: 2.50, outputPerMillion: 10.00 }, maxContextTokens: 128_000, supportsTools: true,  supportsVision: true,  quality: 'standard' },
  { model: 'claude-sonnet-4-6',     provider: 'anthropic', pricing: { inputPerMillion: 3.00, outputPerMillion: 15.00 }, maxContextTokens: 200_000, supportsTools: true,  supportsVision: false, quality: 'standard' },
  { model: 'gemini-1.5-pro',        provider: 'gemini',    pricing: { inputPerMillion: 1.25, outputPerMillion: 5.00 },  maxContextTokens: 1_000_000, supportsTools: true, supportsVision: true, quality: 'standard' },
  { model: 'llama-3.3-70b-versatile', provider: 'groq',   pricing: { inputPerMillion: 0.59, outputPerMillion: 0.79 },  maxContextTokens: 128_000, supportsTools: false, supportsVision: false, quality: 'standard' },
  // Premium tier
  { model: 'claude-opus-4-7',       provider: 'anthropic', pricing: { inputPerMillion: 15.00, outputPerMillion: 75.00 }, maxContextTokens: 200_000, supportsTools: true, supportsVision: false, quality: 'premium' },
];

export class ModelRouter {
  private counter: TokenCounter;

  constructor() {
    this.counter = new TokenCounter();
  }

  route(request: LLMRequest, currentModel: string, currentProvider: ProviderName): RoutingDecision {
    const inputTokens = this.counter.countMessages(request.messages);
    const needsTools = (request.tools?.length ?? 0) > 0;
    const isLongContext = inputTokens > 32_000;
    const isSimpleTask = inputTokens < 300 && !needsTools;

    // Find the cheapest model that meets all constraints
    const eligible = MODEL_REGISTRY
      .filter(m => {
        if (needsTools && !m.supportsTools) return false;
        if (m.maxContextTokens < inputTokens * 1.2) return false; // leave 20% headroom
        return true;
      })
      .sort((a, b) => {
        const costA = a.pricing.inputPerMillion;
        const costB = b.pricing.inputPerMillion;
        return costA - costB;
      });

    if (eligible.length === 0) {
      return { model: currentModel, provider: currentProvider, reasoning: 'No eligible alternative found' };
    }

    // For simple tasks, use budget tier; for complex ones, stay at standard minimum
    const targetQuality: ModelSpec['quality'] = isSimpleTask ? 'budget' : (isLongContext ? 'standard' : 'budget');
    const best = eligible.find(m => m.quality === targetQuality || m.quality === 'budget') ?? eligible[0];

    if (best.model === currentModel) {
      return { model: currentModel, provider: currentProvider, reasoning: 'Already on optimal model' };
    }

    const currentSpec = MODEL_REGISTRY.find(m => m.model === currentModel);
    const reasoning = currentSpec
      ? `Routing from ${currentModel} ($${currentSpec.pricing.inputPerMillion}/1M) to ${best.model} ($${best.pricing.inputPerMillion}/1M) — ${inputTokens} input tokens`
      : `Routing to ${best.model}`;

    return { model: best.model, provider: best.provider, reasoning };
  }
}
