# @tthbfo2/llm-cost-trimmer

**The thing you install before your AI costs spiral.**

Zero-config LLM cost optimization. Drop it in front of any provider, get immediate savings.
No extra AI calls. No login wall. No lock-in.

```ts
const trimmer = new LLMCostTrimmer(new OpenAIProvider(openai));
const response = await trimmer.chat({ messages });
console.log(trimmer.getCostReport()); // see exactly what you spent
```

---

## What it does

| Layer | What it catches |
|---|---|
| **Response Cache** | Exact duplicate requests — served for $0 |
| **Semantic Cache** | Near-identical prompts — local similarity matching, zero extra AI calls |
| **Agent Plan Cache** | Multi-step agent workflows — caches the *execution plan*, not just the output |
| **Prompt Compressor** | Whitespace, filler phrases, HTML comments — algorithmic, deterministic |
| **Context Pruner** | Stale conversation history — keeps only what's relevant to the current turn |
| **Model Router** | Premium model on a simple task — routes to cheapest capable model automatically |

Plus full observability via `getCostReport()` and `getWasteReport()`.

---

## Install

```bash
npm install @tthbfo2/llm-cost-trimmer
```

---

## Quick Start

### OpenAI

```ts
import OpenAI from 'openai';
import { LLMCostTrimmer, OpenAIProvider } from '@tthbfo2/llm-cost-trimmer';

const trimmer = new LLMCostTrimmer(new OpenAIProvider(new OpenAI()));

const response = await trimmer.chat({
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
  model: 'gpt-4o-mini',
});

console.log(response.content);   // Paris
console.log(response.cost);      // $0.000012
console.log(response.cached);    // false (first call)

// Same request again — served from cache
const cached = await trimmer.chat({
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
  model: 'gpt-4o-mini',
});

console.log(cached.cached);      // true
console.log(cached.cacheType);   // 'response'
console.log(cached.cost);        // 0
```

### Anthropic

```ts
import Anthropic from '@anthropic-ai/sdk';
import { LLMCostTrimmer, AnthropicProvider } from '@tthbfo2/llm-cost-trimmer';

const trimmer = new LLMCostTrimmer(new AnthropicProvider(new Anthropic()));
```

### Ollama (local, free)

```ts
import { LLMCostTrimmer, OllamaProvider } from '@tthbfo2/llm-cost-trimmer';

const trimmer = new LLMCostTrimmer(new OllamaProvider({ model: 'llama3' }));
```

---

## Cost Report

```ts
const report = trimmer.getCostReport();

// {
//   totalCost: 0.0024,
//   totalSavings: 0.0051,
//   savingsPercent: 68.0,
//   totalRequests: 12,
//   cachedRequests: 8,
//   cacheHitRate: 66.7,
//   byProvider: { openai: { ... } },
//   byModel: { 'gpt-4o-mini': { ... } },
//   dashboardHint: 'Track spend over time at trimwares.com/dashboard'
// }
```

## Waste Report

```ts
const waste = trimmer.getWasteReport();

// {
//   totalWaste: 0.0008,
//   wastePercent: 33.3,
//   byType: {
//     premium_for_simple: { count: 2, estimatedCost: 0.0005, examples: [...] },
//     oversized_context:  { count: 1, estimatedCost: 0.0003, examples: [...] }
//   },
//   recommendations: [
//     '[Expensive model used for a short, simple request] → Enable ModelRouter...',
//     '[Context exceeded 8,000 tokens] → Use ContextPruner...'
//   ]
// }
```

---

## Agentic Plan Caching

The novel layer. Instead of caching outputs, cache the *execution plan* — the sequence of tool calls an agent derives for a task. Similar future tasks skip the planning phase entirely.

```ts
// After your agent runs its first tool-calling workflow:
trimmer.recordPlan({
  taskDescription: 'Search for AI news and summarize',
  steps: [
    { stepIndex: 0, toolName: 'web_search', toolArgs: { query: 'AI news today' } },
    { stepIndex: 1, toolName: 'summarize',  toolArgs: { maxWords: 100 } },
  ],
  inputTokensUsed: 500,
  outputTokensUsed: 200,
});

// Next time a similar task arrives:
const plan = trimmer.getPlan('Find today\'s AI headlines and give a brief summary');
if (plan) {
  // Skip the planning call entirely — execute the cached plan directly
  console.log('Using cached plan:', plan.steps);
}
```

---

## Configuration

All defaults are zero-config. Override only what you need:

```ts
const trimmer = new LLMCostTrimmer(provider, {
  defaultModel: 'gpt-4o-mini',
  cache: {
    response: { ttlMs: 10 * 60 * 1000 },          // 10 min TTL
    semantic:  { similarityThreshold: 0.88 },       // more aggressive matching
    plan:      { enabled: false },                  // disable plan cache
  },
  optimization: {
    compressPrompts:      true,   // default on
    pruneContext:         true,   // default off — enable for long conversations
    routeToCheapestModel: true,   // default off — enable for mixed-complexity workloads
  },
});
```

---

## Providers

| Provider | Class | Notes |
|---|---|---|
| OpenAI | `OpenAIProvider` | Pass your `new OpenAI()` instance |
| Anthropic | `AnthropicProvider` | Pass your `new Anthropic()` instance |
| Gemini | `GeminiProvider` | Pass your `@google/generative-ai` client |
| Groq | `GroqProvider` | OpenAI-compatible SDK |
| Ollama | `OllamaProvider` | Local models, zero cost |

---

## Why not just use a prompt optimizer that calls another AI?

Most "smart" compressors use another LLM to compress your prompts. That means:
- You pay for the compression call
- You add latency
- You introduce a privacy risk (your data goes through another model)

Every optimization in this library is **deterministic and algorithmic** — no inference calls, ever.

---

## License

Apache 2.0
