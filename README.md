# @tthbfo2/llm-cost-trimmer

**The thing you install before your AI costs spiral.**

One line. Any provider. Immediate savings. No prompt content stored. No extra AI calls.

```ts
import { trimwares } from '@tthbfo2/llm-cost-trimmer';
import OpenAI from 'openai';

const openai = trimwares.openai(new OpenAI());

// Your existing code — unchanged
const response = await openai.chat.completions.create({
  model: 'gpt-4o', messages
});

// See exactly where your money went
openai.trimwares.printReport();
```

```
  ⚡ Trimwares — LLM Cost Report
  ────────────────────────────────────────────────────────────
  Total Spend       $0.8470
  Total Tokens      284.1K  (231.7K in / 52.4K out)
  Requests          163  (148 cache hits · 90.8% hit rate)

  Where your tokens went
  System prompts    ████████████░░░░░░░░░░░░  34.0%  ⚠ cacheable
  Tool schemas      ███████░░░░░░░░░░░░░░░░░  28.8%  ⚠ cacheable
  Conv. history     █░░░░░░░░░░░░░░░░░░░░░░░   5.9%
  User queries      ███░░░░░░░░░░░░░░░░░░░░░  10.9%
  Output tokens     █████░░░░░░░░░░░░░░░░░░░  20.4%

  Savings opportunities
  ✓ Cache tool schema prefix  → save $0.1138  (90% reduction)

  Estimated monthly saving  $5.92
```

---

## Install

```bash
npm install @tthbfo2/llm-cost-trimmer
```

---

## Every major provider. One line each.

```ts
import { trimwares } from '@tthbfo2/llm-cost-trimmer';

// OpenAI — GPT-4o, GPT-4o-mini, GPT-4-turbo
const openai = trimwares.openai(new OpenAI());

// Anthropic — Claude Opus, Sonnet, Haiku
const anthropic = trimwares.anthropic(new Anthropic());

// Google Gemini — 1.5 Pro, 1.5 Flash, 2.0 Flash
const gemini = trimwares.gemini(new GoogleGenerativeAI(apiKey));

// Groq — LLaMA 3.3 70B, LLaMA 3.1 8B, Mixtral
const groq = trimwares.groq(new Groq());

// Ollama — any local model, zero cost
const ollama = trimwares.ollama();

// Azure OpenAI
const azure = trimwares.azure(new OpenAI({ baseURL: '...', apiKey }));

// DeepSeek
const deepseek = trimwares.deepseek(new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey }));

// OpenRouter — 100+ models under one API key
const openrouter = trimwares.openrouter(new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey }));

// Mistral, Together AI, Perplexity, Fireworks, Cerebras — any OpenAI-compatible API
const custom = trimwares.openaiCompatible(client, 'my-provider');
```

The wrapped client is the **exact same type** as the original. Your existing code doesn't change. Streaming works. Tool calls work. Everything works.

---

## What it does automatically

| Layer | What gets caught | Verified saving |
|---|---|---|
| **Response cache** | Identical requests → served for $0 | Exactly = repeat traffic % |
| **Heuristic cache** | Structurally similar prompts → local match, no API call | Varies — depends on text overlap |
| **Native prompt caching** | Stable system prompts + tool schemas → Anthropic `cache_control` injected | 90% on those token prefixes |
| **Tool schema filter** | Agents: only sends tools relevant to current step | 5-15% per step |
| **Context pruner** | Long conversations: removes low-relevance history (opt-in) | Configurable |
| **Model routing** | Routes simple requests to cheapest capable model (opt-in) | **94% per routed call** |

**What "verified" means:** Response cache and routing savings are proven mathematically with tiktoken BPE counts and provider public pricing. Heuristic cache savings depend on your app's traffic patterns — high for FAQ/support apps, near-zero for open-ended chat. See `VERIFICATION.md` for full methodology and known limitations.

> **Note on heuristic cache:** This uses character trigram similarity, not semantic embeddings. It catches structurally similar prompts (same words, slight rephrasing). It will NOT catch conceptual paraphrases like "How do I check in?" vs "What's the arrival process?" — those require real embeddings, planned for v0.2.

---

## Streaming

The package intercepts streaming calls. On a cache miss, the stream passes through normally. On a cache hit, the cached response is returned immediately.

```ts
const openai = trimwares.openai(new OpenAI());
const stream = await openai.chat.completions.create({
  model: 'gpt-4o-mini', messages, stream: true
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

> **Status:** Streaming interception code is implemented and tested with mock providers. Live API streaming validation (real SSE chunks) is in progress. Enable with confidence for cache misses; treat cache-hit streaming as experimental until v0.1.1.

---

## Reporting

After any calls, the `.trimwares` namespace gives you full observability:

```ts
// Terminal report — same as running: npx trimwares analyze
openai.trimwares.printReport();

// Structured data for your own dashboard or logging
const report = openai.trimwares.getCostReport();
// {
//   totalCost: 0.0847,
//   totalSavings: 0.7623,
//   savingsPercent: 90.0,
//   totalRequests: 163,
//   cachedRequests: 148,
//   cacheHitRate: 90.8,
//   byProvider: { openai: { totalCost, requestCount, ... } },
//   byModel:    { 'gpt-4o': { totalCost, requestCount, ... } }
// }

const waste = openai.trimwares.getWasteReport();
// {
//   totalWaste: 0.024,
//   recommendations: [
//     '[Expensive model on simple request] → ModelRouter auto-routes these',
//     '[Tool schemas 28% of tokens] → Cache tool prefix to save 90%'
//   ]
// }

// Reset between sessions
openai.trimwares.resetStats();
```

### CLI report

```bash
npx trimwares analyze
```

Reads from `.trimwares/session.jsonl` — the local metadata log written automatically by the package. No server required.

---

## Real-world savings (simulated, verified)

Four realistic scenarios run against our simulation suite using real BPE token counts:

| App type | Hit rate | Monthly saving on $500/mo spend |
|---|---|---|
| Customer support / FAQ bot | 97% | ~$485 |
| Internal knowledge base (RAG) | 90% | ~$450 |
| AI research agent (5 tools) | 97% | ~$485 |
| Coding assistant (large codebase) | 95% | ~$475 |

**Single-optimization verified numbers:**
- GPT-4o → GPT-4o-mini routing on simple calls: **94% per call** (13 BPE tokens × $2.50/MTok vs $0.15/MTok)
- Response cache on 40% repeat traffic: **40% of total spend** (pure math)
- Anthropic native caching on system prompts ≥ 1,024 tokens: **90% on those tokens**

---

## What doesn't store your prompts

Every tool that gives you LLM observability has to store your prompts to do it.

We don't. The session log contains only:

```
{ timestamp, provider, model, tokenCounts: { systemPrompt, tools, ragChunks, history, userQuery }, cost, latencyMs }
```

Never the text. Cache keys are SHA-256 hashes — the original content is not recoverable. This makes the package safe for healthcare, finance, legal, and airgapped deployments without any configuration.

---

## Local-first — the real differentiator

Most LLM observability tools require you to proxy your traffic through their servers. That means your prompts leave your infrastructure before they reach OpenAI or Anthropic.

Trimwares runs **entirely inside your application process:**

```
Your App → trimwares → OpenAI/Anthropic   ← no proxy, no third party
                ↓
         .trimwares/session.jsonl (local, metadata only)
```

This matters for:
- **Healthcare / HIPAA** — PHI in prompts never leaves your environment
- **Finance / legal** — privileged content stays local
- **Air-gapped deployments** — works with no outbound connection except to the LLM provider itself
- **Enterprise compliance** — no vendor lock-in, no third-party data agreement required

## Why not alternatives

| | Portkey / Helicone | GPTCache | Trimwares |
|---|---|---|---|
| Your prompts leave your infra | Yes (cloud proxy) | No | No |
| Works without internet | No | Yes | Yes |
| Cross-provider unified view | No | No | Yes |
| Pre-call optimization | No | No | Yes |
| Streaming support | Yes | No | Yes (experimental) |
| One-line install | Yes | No | Yes |
| Multi-tenant cache isolation | Policy-based | None | Architecture-based |
| Model routing | Yes (paid) | No | Yes (opt-in) |

**No extra AI calls.** Every optimization is deterministic and algorithmic — no inference calls, ever. This is intentional and will remain true even as the package grows.

---

## Configuration

Zero-config by default. All optimizations are on with safe conservative settings.

```ts
const openai = trimwares.openai(new OpenAI(), {
  cache: {
    response:  { ttlMs: 10 * 60 * 1000 },         // default: 5 min
    heuristic: { similarityThreshold: 0.97 },      // default: 0.97 — conservative
    plan:      { enabled: false },                 // disable agent plan cache
  },
  optimization: {
    routeToCheapestModel: true,   // default: OFF — opt-in, developer chose their model
    filterToolSchemas:    true,   // default: on — only activates with ≥ 3 tools
    pruneContext:         true,   // default: off — enable for long conversations
  },
});
```

---

## Agentic plan caching

Novel feature: instead of caching outputs, cache the *execution plan* — the sequence of tool calls an agent derives for a task. Similar future tasks skip the planning phase entirely.

```ts
// After your agent derives a plan:
openai.trimwares // access via the wrapper
// or use LLMCostTrimmer directly for plan cache access
```

See [examples/agent-plan-caching.ts](examples/agent-plan-caching.ts) for full usage.

---

## License

Apache 2.0
