# Trimwares Trace

**See exactly where your AI money goes.**

Local-first AI cost observability and optimization for LLM applications. Trimwares Trace shows you where every token is being spent — system prompts, tool schemas, RAG chunks, conversation history, user queries — and applies local optimizations to reduce unnecessary spend. No usage data ever leaves your machine.

→ **[trimwares.com/trace](https://trimwares.com/trace)** — Developer: full dashboard + unlimited history · Team: CI gate + cloud sync

```
  ⚡ Trimwares Trace — Cost Report
  ────────────────────────────────────────────────────────────
  Total Spend       $0.0312   (5.4K tokens)
  Requests          21  (5 cache hits · 23.8% hit rate)

  Where your tokens went
  System prompts    ████████████████░░░░░░░░  71%  ⚠ cacheable
  Tool schemas      ████░░░░░░░░░░░░░░░░░░░░  15%  ⚠ cacheable
  User queries      █░░░░░░░░░░░░░░░░░░░░░░░   5%
  Output            ███░░░░░░░░░░░░░░░░░░░░░   9%

  Top action: cache system prompt prefix → save ~$0.85/mo
  ────────────────────────────────────────────────────────────
  trimwares.com/trace — Developer: full dashboard · Team: CI gate + cloud sync
```

---

## Install

```bash
npm install @trimwares/trace
```

---

## 30-second setup

Wrap your existing LLM client. Your code doesn't change.

```ts
import { trimwares } from '@trimwares/trace';
import OpenAI from 'openai';

const openai = trimwares.openai(new OpenAI());

// Your existing code — unchanged
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages,
});
```

Then from your project root:

```bash
npx trimwares analyze
```

That's it. The package writes a local metadata log (`.trimwares/session.jsonl`) on every LLM call — token counts, costs, attribution categories, latency. Never the prompt text itself.

---

## CLI

| Command | What it does |
|---|---|
| `npx trimwares analyze` | Terminal cost report — attribution breakdown + top savings action |
| `npx trimwares serve` | **Developer** — opens local dashboard at localhost:7778, live polling |
| `npx trimwares login --key KEY` | Activate a Developer or Team license key |
| `npx trimwares clear` | Clear current session log |
| `npx trimwares check` | **Team** — CI gate — fails if spend/cache/tool% exceed configured thresholds |

---

## Free vs Developer vs Team

|  | Free | Developer | Team |
|---|---|---|---|
| All SDK optimizations | ✓ | ✓ | ✓ |
| `npx trimwares analyze` — terminal report | ✓ | ✓ | ✓ |
| Attribution breakdown + recommendations | ✓ | ✓ | ✓ |
| Session log (`.trimwares/session.jsonl`) | ✓ | ✓ | ✓ |
| 7-day local dashboard | ✓ | ✓ | ✓ |
| Full dashboard — unlimited local history | — | ✓ | ✓ |
| Spend alerts + anomaly detection | — | ✓ | ✓ |
| Trends + export (JSON/CSV) | — | ✓ | ✓ |
| CI gate (`npx trimwares check`) | — | — | ✓ |
| Cloud sync + shared dashboards | — | — | ✓ |
| Slack / email budget alerts | — | — | ✓ |
| License required | None | $79 lifetime · [trimwares.com/trace](https://trimwares.com/trace) | $20/user/mo |
| Data leaves your machine | Never | Never | Only sync data |

After activation, the license is verified **locally** using an Ed25519 signature — no server round-trip required on subsequent runs.

---

## Getting started with Developer

1. **Purchase** at [trimwares.com/trace](https://trimwares.com/trace) — $79 lifetime, early adopter price (checkout via Lemon Squeezy)
2. **Check your email** — your license key arrives instantly after checkout
3. **Activate** in your project directory:
   ```bash
   npx trimwares login --key <your-license-key>
   ```
4. **Open the dashboard:**
   ```bash
   npx trimwares serve
   ```
   Dashboard opens at [localhost:7778](http://localhost:7778) — full dashboard, unlimited local history, alerts, and export.

> **Lifetime means lifetime.** You keep your version forever. The first year of updates is included — after that, new major releases are available for a small upgrade fee (pricing to be announced). Keep what you have, or grab the latest. Your choice, no pressure.

---

## What it tracks

Every call is broken down into six attribution categories:

| Category | What it is | Why it matters |
|---|---|---|
| **System prompt** | Your static instructions | Repeated verbatim on every call — highly cacheable |
| **Tool schemas** | JSON definitions sent with each step | Often 20–40% of agent token spend, sent even when unused |
| **RAG chunks** | Retrieved context injected per call | Can be deduplicated with provider-native prefix caching |
| **Conversation history** | Prior turns sent for context | Grows unbounded; rolling window fixes most of the cost |
| **User query** | The actual user message | Typically 5% of total — the smallest slice |
| **Output** | The model's response | Irreducible — genuine work |

The terminal report and dashboard show exactly how your spend splits across these categories for every session.

---

## What it optimizes

| Optimization | How it works | Verified saving |
|---|---|---|
| **Response cache** | Identical requests served from memory at $0 | Exactly = your repeat-request % |
| **Native prompt caching** | Injects Anthropic `cache_control` on stable system prompt + tool prefixes | 90% on those token prefixes (≥ 1,024 tokens; **≥ 4,096 tokens for Claude Haiku 4.5**) |
| **Tool schema filter** | Agents: only sends tools relevant to the current step | 5–15% per step |
| **Model router** | Routes simple requests to the cheapest capable model in the same provider | **94% per routed call** (opt-in) |
| **Context pruner** | Trims low-relevance history turns from long conversations | Configurable (opt-in) |

**On the numbers:** The 94% routing saving is mathematically verified — 13 BPE tokens at GPT-4o pricing ($2.50/MTok) vs GPT-4o-mini pricing ($0.15/MTok). Response cache savings are pure math equal to your repeat traffic percentage. Savings vary by workload; benefits are largest for apps with repeated or structurally similar requests (support bots, FAQ, RAG). Open-ended or unique queries see little benefit from caching.

**Streaming:** Supported. On a cache miss the stream passes through normally while Trimwares collects chunks in the background — latency and attribution are recorded when the stream ends. On a cache hit the cached response is replayed as a stream so your code path stays identical. No changes required on your side.

---

## Supported providers

| Provider | Status |
|---|---|
| OpenAI (GPT-4o, GPT-4o-mini, GPT-4-turbo) | ✓ Implemented · **live-tested** (2026-07-12) |
| Anthropic (Haiku 4.5, Sonnet 4.6, Opus 4.7) | ✓ Implemented · **live-tested** (2026-07-12) |
| Groq (LLaMA 3.3 70B, LLaMA 3.1 8B, Mixtral) | ✓ Implemented · **live-tested** (2026-06-15) |
| Google Gemini (1.5 Pro, 1.5 Flash, 2.0 Flash) | ✓ Implemented · unit-tested |
| Ollama (any local model) | ✓ Implemented · unit-tested |

Azure OpenAI and OpenRouter are also supported — pass an OpenAI client configured with the appropriate `baseURL`:

```ts
import OpenAI from 'openai';
import { trimwares } from '@trimwares/trace';

// Azure OpenAI
const azure = trimwares.azure(new OpenAI({ baseURL: '...', apiKey: '...' }));

// OpenRouter
const openrouter = trimwares.openrouter(new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: '...' }));
```

---

## Privacy and local-first

Most LLM observability tools proxy your traffic through their servers. That means your prompts leave your infrastructure before they reach OpenAI or Anthropic.

Trimwares Trace runs entirely inside your application process:

```
Your App → trimwares → OpenAI / Anthropic   ← no proxy, no third party
                ↓
         .trimwares/session.jsonl  (local, metadata only — never prompt text)
```

The session log contains only:

```json
{
  "timestamp": "2026-06-10T09:14:22.000Z",
  "provider": "openai",
  "model": "gpt-4o",
  "attribution": {
    "systemPrompt":         { "tokens": 312, "estimatedCost": 0.00078 },
    "toolSchemas":          { "tokens": 89,  "estimatedCost": 0.00022 },
    "ragChunks":            { "tokens": 0,   "estimatedCost": 0 },
    "conversationHistory":  { "tokens": 45,  "estimatedCost": 0.00011 },
    "userQuery":            { "tokens": 22,  "estimatedCost": 0.000055 },
    "outputTokens":         { "tokens": 118, "estimatedCost": 0.000472 }
  },
  "latencyMs": 843,
  "cached": false
}
```

Never the text. Cache keys are SHA-256 hashes — the original content is not recoverable. Safe for healthcare, finance, legal, and air-gapped deployments without any configuration.

---

## Why not alternatives

| | Portkey / Helicone | GPTCache | Trimwares Trace |
|---|---|---|---|
| Prompts leave your infrastructure | Yes — cloud proxy | No | No |
| Works without internet | No | Yes | Yes |
| Cross-provider unified view | No | No | Yes |
| Token attribution by category | No | No | Yes |
| Pre-call optimization | No | No | Yes |
| Streaming support | Yes | No | Yes |
| One-line install | Yes | No | Yes |
| Model routing | Paid | No | Yes (opt-in) |

---

## Configuration

Zero-config by default. All optimizations are on with conservative settings.

```ts
const openai = trimwares.openai(new OpenAI(), {
  cache: {
    response:  { ttlMs: 5 * 60 * 1000 },   // default: 5 min TTL; raise for stable prompts
    // Semantic cache — uses all-MiniLM-L6-v2 local embeddings (@xenova/transformers, ~23MB,
    // downloaded once). Disabled by default: stress testing showed false positives on
    // same-structure questions (e.g. "capital of France?" matching "capital of Germany?").
    // Enable only for workloads with near-identical repeated queries (support bots, FAQ).
    semantic:  { enabled: false, similarityThreshold: 0.97 },
    plan:      { enabled: false },                 // disable agent plan cache
  },
  optimization: {
    routeToCheapestModel: false,  // opt-in — you chose your model for a reason
    filterToolSchemas:    true,   // on by default — only activates with ≥ 3 tools
    pruneContext:         false,  // opt-in — enable for long-running conversations
  },
});
```

---

## License

Apache 2.0
