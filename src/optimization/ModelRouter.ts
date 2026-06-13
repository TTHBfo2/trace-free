import { LLMRequest, ModelPricing, ProviderName } from '../types/index.js';
import { TokenCounter } from '../core/TokenCounter.js';

export interface RoutingDecision {
  model: string;
  provider: ProviderName;
  originalModel: string;
  originalProvider: ProviderName;
  reasoning: string;
  complexity: RequestComplexity;
  estimatedSavingsPercent: number;
  wasRouted: boolean;
}

export type RequestComplexity = 'simple' | 'standard' | 'complex';

interface ModelSpec {
  model: string;
  provider: ProviderName;
  pricing: ModelPricing;
  maxContextTokens: number;
  supportsTools: boolean;
  quality: 'budget' | 'standard' | 'premium';
}

const MODEL_REGISTRY: ModelSpec[] = [
  // Budget
  { model: 'gpt-4o-mini',              provider: 'openai',    pricing: { inputPerMillion: 0.15,  outputPerMillion: 0.60  }, maxContextTokens: 128_000, supportsTools: true,  quality: 'budget'   },
  { model: 'claude-haiku-4-5',         provider: 'anthropic', pricing: { inputPerMillion: 1.00,  outputPerMillion: 5.00  }, maxContextTokens: 200_000, supportsTools: true,  quality: 'budget'   },
  { model: 'gemini-1.5-flash',         provider: 'gemini',    pricing: { inputPerMillion: 0.075, outputPerMillion: 0.30  }, maxContextTokens: 1_000_000, supportsTools: true, quality: 'budget'  },
  { model: 'llama-3.1-8b-instant',     provider: 'groq',      pricing: { inputPerMillion: 0.05,  outputPerMillion: 0.08  }, maxContextTokens: 128_000, supportsTools: false, quality: 'budget'   },
  // Standard
  { model: 'gpt-4o',                   provider: 'openai',    pricing: { inputPerMillion: 2.50,  outputPerMillion: 10.00 }, maxContextTokens: 128_000, supportsTools: true,  quality: 'standard' },
  { model: 'claude-sonnet-4-6',        provider: 'anthropic', pricing: { inputPerMillion: 3.00,  outputPerMillion: 15.00 }, maxContextTokens: 200_000, supportsTools: true,  quality: 'standard' },
  { model: 'gemini-1.5-pro',           provider: 'gemini',    pricing: { inputPerMillion: 1.25,  outputPerMillion: 5.00  }, maxContextTokens: 1_000_000, supportsTools: true, quality: 'standard'},
  { model: 'llama-3.3-70b-versatile',  provider: 'groq',      pricing: { inputPerMillion: 0.59,  outputPerMillion: 0.79  }, maxContextTokens: 128_000, supportsTools: false, quality: 'standard' },
  // Premium
  { model: 'claude-opus-4-7',          provider: 'anthropic', pricing: { inputPerMillion: 5.00,  outputPerMillion: 25.00 }, maxContextTokens: 200_000, supportsTools: true,  quality: 'premium'  },
];

// Keywords that signal a request needs deep reasoning — don't downgrade these
const COMPLEX_KEYWORDS = [
  'analyze', 'analyse', 'reason', 'explain why', 'compare', 'contrast',
  'evaluate', 'critique', 'debate', 'argue', 'prove', 'disprove',
  'write code', 'implement', 'architect', 'design system', 'refactor',
  'debug', 'fix this', 'what\'s wrong', 'error',
];

export class ModelRouter {
  private counter: TokenCounter;

  constructor() {
    this.counter = new TokenCounter();
  }

  classify(request: LLMRequest): RequestComplexity {
    const inputTokens  = this.counter.countMessages(request.messages);
    const hasTools     = (request.tools?.length ?? 0) > 0;
    const historyDepth = request.messages.filter(m => m.role !== 'system').length;
    const lastUser     = [...request.messages].reverse().find(m => m.role === 'user');
    const userText     = (lastUser?.content ?? '').toLowerCase();

    const hasComplexKeyword = COMPLEX_KEYWORDS.some(kw => userText.includes(kw));

    // Complex: large context, tool use, deep history, or explicit reasoning
    if (inputTokens > 2_000 || hasTools || historyDepth > 6 || hasComplexKeyword) {
      return 'complex';
    }

    // Simple: short, single-turn, no tools, no complex language
    if (inputTokens < 400 && historyDepth <= 2 && !hasComplexKeyword) {
      return 'simple';
    }

    return 'standard';
  }

  route(request: LLMRequest, currentModel: string, currentProvider: ProviderName): RoutingDecision {
    const complexity = this.classify(request);
    const inputTokens = this.counter.countMessages(request.messages);
    const needsTools  = (request.tools?.length ?? 0) > 0;

    const normalized  = currentModel.toLowerCase();
    // For the CURRENT spec lookup, only match if the input contains the key (not the reverse).
    // 'gpt-4o' should match spec 'gpt-4o' but NOT 'gpt-4o-mini'.
    // Sort longest keys first so 'gpt-4o-mini' wins over 'gpt-4o' when input is 'gpt-4o-mini'.
    const sorted      = [...MODEL_REGISTRY].sort((a, b) => b.model.length - a.model.length);
    const currentSpec = sorted.find(m => normalized === m.model || normalized.includes(m.model));

    // Don't route complex requests or if we can't identify the current model
    if (complexity === 'complex' || !currentSpec) {
      return this.noRoute(currentModel, currentProvider, complexity, 'Request too complex to downgrade safely');
    }

    // Don't route if already on budget tier
    if (currentSpec.quality === 'budget') {
      return this.noRoute(currentModel, currentProvider, complexity, 'Already on budget model');
    }

    // Find cheapest eligible model from the SAME provider (same provider = no auth changes needed)
    const sameProviderBudget = MODEL_REGISTRY
      .filter(m =>
        m.provider === currentProvider &&
        m.quality === 'budget' &&
        m.maxContextTokens >= inputTokens * 1.2 &&
        (!needsTools || m.supportsTools)
      )
      .sort((a, b) => a.pricing.inputPerMillion - b.pricing.inputPerMillion)[0];

    if (!sameProviderBudget) {
      return this.noRoute(currentModel, currentProvider, complexity, 'No budget model available for this provider + requirements');
    }

    const savingsPercent = Math.round(
      ((currentSpec.pricing.inputPerMillion - sameProviderBudget.pricing.inputPerMillion) /
       currentSpec.pricing.inputPerMillion) * 100
    );

    return {
      model:                  sameProviderBudget.model,
      provider:               sameProviderBudget.provider,
      originalModel:          currentModel,
      originalProvider:       currentProvider,
      reasoning:              `${complexity} request: routing from ${currentModel} → ${sameProviderBudget.model} (${savingsPercent}% cheaper, same provider)`,
      complexity,
      estimatedSavingsPercent: savingsPercent,
      wasRouted:              true,
    };
  }

  private noRoute(model: string, provider: ProviderName, complexity: RequestComplexity, reason: string): RoutingDecision {
    return {
      model, provider, originalModel: model, originalProvider: provider,
      reasoning: reason, complexity, estimatedSavingsPercent: 0, wasRouted: false,
    };
  }
}
