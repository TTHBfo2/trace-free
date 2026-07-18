# Trimwares Trace

**See exactly where your AI money goes — and cut it.**

Local-first LLM cost observability. Token attribution by category, a live 7-day dashboard, and built-in optimizations that reduce spend before requests leave your app. No prompts leave your machine. No account required. Works in 30 seconds.

→ **[trace.trimwares.com](https://trace.trimwares.com)**

```
  ⚡ Trimwares Trace — Cost Report
  ────────────────────────────────────────────────────────────
  Total Spend       $0.0312
  Total Tokens      5.4K  (4.6K in / 0.8K out)
  Requests          21  (5 cache hits · 23.8% hit rate)
  Native Caching    38.1% of requests had provider cache applied

  Where your tokens went

  System prompts    ████████████████░░░░░░░░  71%  ⚠ cacheable
  Tool schemas      ████░░░░░░░░░░░░░░░░░░░░  15%  ⚠ cacheable
  Conv. history     ██░░░░░░░░░░░░░░░░░░░░░░   9%
  User queries      █░░░░░░░░░░░░░░░░░░░░░░░   5%
  Output tokens     ░░░░░░░░░░░░░░░░░░░░░░░░   0%

  ────────────────────────────────────────────────────────────
  Developer: unlimited history + spend alerts + export — trace.trimwares.com
```

---

## Install

```bash
npm install @trimwares/trace
```

> After install, your terminal will print a quick-start guide automatically.

---

## 30-second setup

Wrap your existing LLM client. Your app code doesn't change.

**OpenAI**
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

**Anthropic**
```ts
import { trimwares } from '@trimwares/trace';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = trimwares.anthropic(new Anthropic());
```

**Groq**
```ts
import OpenAI from 'openai';

const groq = trimwares.groq(
  new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' })
);
```

**Gemini**
```ts
import { GoogleGenerativeAI } from '@google/generative-ai';

const gemini = trimwares.gemini(new GoogleGenerativeAI(process.env.GEMINI_API_KEY));
const model  = gemini.getGenerativeModel({ model: 'gemini-1.5-flash' });
```

**Ollama**
```ts
import OpenAI from 'openai';

const ollama = trimwares.ollama(
  new OpenAI({ baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' })
);
```

Run your app normally. Trimwares writes a local metadata log — token counts, costs, attribution, latency — to `.trimwares/session.jsonl`. Never the prompt text.

Then:

```bash
npx trimwares add .       # register this project
npx trimwares serve       # open your dashboard → http://localhost:7778
```

→ **[trace.trimwares.com](https://trace.trimwares.com)** — full docs and more examples

---

## CLI

| Command | What it does |
|---|---|
| `npx trimwares add .` | Register the current directory as a tracked project |
| `npx trimwares analyze` | Terminal cost report — attribution breakdown + savings opportunities |
| `npx trimwares serve` | Open the local dashboard at `localhost:7778` — live-polling, 7-day history |
| `npx trimwares clear` | Clear the current session log |
| `npx trimwares login --key KEY` | Activate a Developer license key |
| `npx trimwares check` | CI gate — fails if spend/cache/tool-overhead exceed configured thresholds *(Developer)* |

---

## What you get — free, forever

No account. No expiry. No data leaving your machine.

| Feature | Free |
|---|---|
| SDK wrappers — OpenAI, Anthropic, Groq, Gemini, Ollama | ✓ |
| All built-in optimizations (response cache, native prompt caching, model router, tool filter, context pruner) | ✓ |
| `npx trimwares analyze` — full terminal cost report | ✓ |
| Token attribution by category (system prompt, tools, RAG, history, query, output) | ✓ |
| Optimization recommendations with projected savings | ✓ |
| 7-day local dashboard (`npx trimwares serve`) | ✓ |
| Session log — local metadata only, never prompt text | ✓ |
| Streaming support | ✓ |
| Multi-project dashboard with file browser | ✓ |
| Works offline, air-gapped, and in CI | ✓ |
| Apache 2.0 license | ✓ |

→ **[See everything it can do at trace.trimwares.com](https://trace.trimwares.com)**

---

## Developer tier — coming soon

The Developer tier is in active development. Here's what's coming:

| Feature | Developer |
|---|---|
| Everything in Free | ✓ |
| Unlimited local history — no 7-day window | Soon |
| Spend alerts + anomaly detection | Soon |
| Export your data — JSON and CSV | Soon |
| CI gate (`npx trimwares check`) | Soon |
| Advanced dashboard views | Soon |
| More features being added — stay tuned | ✓ |

**Want early access or have a specific feature in mind?**

[Email us at hello@trimwares.com](mailto:hello@trimwares.com?subject=Developer%20tier%20interest) — we read every message and are actively shaping the roadmap based on what developers actually need.

→ **[Follow progress and get notified at trace.trimwares.com](https://trace.trimwares.com)**

---

## What it tracks

Every LLM call is broken down into six attribution categories:

| Category | What it is | Why it matters |
|---|---|---|
| **System prompt** | Your static instructions sent on every call | Highly repetitive — ideal for provider-native prefix caching |
| **Tool schemas** | JSON tool definitions sent with each step | Often 15–40% of agent spend, sent even when unused |
| **RAG chunks** | Retrieved context injected per call | Can be deduplicated with prefix caching |
| **Conversation history** | Prior turns sent for context | Grows unbounded — rolling window fixes most of the cost |
| **User query** | The actual user message | Typically 5% of total — the smallest slice |
| **Output tokens** | The model's response | Irreducible — genuine work |

The terminal report and dashboard show exactly how your spend breaks down across these categories, session by session.

---

## What it optimizes

| Optimization | How it works | Typical saving |
|---|---|---|
| **Response cache** | Identical requests served from local memory at $0 | Exactly = your repeat-request % |
| **Native prompt caching** | Injects Anthropic `cache_control` on stable system prompt + tool prefixes | 90% on those token prefixes (≥ 1,024 tokens; ≥ 4,096 for Claude Haiku 4.5) |
| **Tool schema filter** | Only sends tools relevant to the current agent step | 5–15% per step (activates with ≥ 3 tools) |
| **Model router** | Routes simple requests to the cheapest capable model in the same provider | Up to 94% per routed call (opt-in) |
| **Context pruner** | Trims low-relevance history turns from long conversations | Configurable (opt-in) |

**On the numbers:** The 94% model-routing saving is mathematically derived — 13 BPE tokens at GPT-4o pricing ($2.50/MTok) vs GPT-4o-mini ($0.15/MTok). Response cache savings equal your exact repeat-traffic percentage. Benefits are largest for apps with structurally similar requests: support bots, FAQ systems, RAG pipelines. Open-ended or unique queries see little benefit from caching.

**Streaming:** Fully supported. On a cache miss the stream passes through normally while Trimwares collects chunks in the background. On a cache hit the cached response replays as a stream — your code path stays identical.

→ **[trace.trimwares.com](https://trace.trimwares.com)** — benchmarks and methodology

---

## Supported providers

| Provider | Status |
|---|---|
| OpenAI (GPT-4o, GPT-4o-mini, GPT-4-turbo, o1, o3) | ✓ Implemented · **live-tested** |
| Anthropic (Claude Haiku 4.5, Sonnet 4.6, Opus 4.8) | ✓ Implemented · **live-tested** |
| Groq (LLaMA 3.3 70B, LLaMA 3.1 8B, Mixtral) | ✓ Implemented · **live-tested** |
| Google Gemini (1.5 Pro, 1.5 Flash, 2.0 Flash) | ✓ Implemented |
| Ollama (any local model) | ✓ Implemented |
| Azure OpenAI | ✓ Via OpenAI client + `baseURL` |
| OpenRouter | ✓ Via OpenAI client + `baseURL` |

```ts
// Azure OpenAI
const azure = trimwares.azure(
  new OpenAI({ baseURL: 'https://<resource>.openai.azure.com', apiKey: '...' })
);

// OpenRouter
const openrouter = trimwares.openrouter(
  new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: '...' })
);
```

---

## Privacy and local-first

Most LLM observability tools proxy your traffic through their servers. That means your prompts leave your infrastructure before they reach OpenAI or Anthropic.

Trimwares Trace runs **entirely inside your application process**:

```
Your App → trimwares → OpenAI / Anthropic   ← no proxy, no third party
                ↓
         .trimwares/session.jsonl  (local metadata only — never prompt text)
```

The session log records only:

```json
{
  "timestamp": "2026-07-17T09:14:22.000Z",
  "provider": "openai",
  "model": "gpt-4o",
  "attribution": {
    "systemPrompt":        { "tokens": 312, "estimatedCost": 0.00078 },
    "toolSchemas":         { "tokens": 89,  "estimatedCost": 0.00022 },
    "ragChunks":           { "tokens": 0,   "estimatedCost": 0 },
    "conversationHistory": { "tokens": 45,  "estimatedCost": 0.000113 },
    "userQuery":           { "tokens": 22,  "estimatedCost": 0.000055 },
    "outputTokens":        { "tokens": 118, "estimatedCost": 0.000472 }
  },
  "latencyMs": 843,
  "cached": false
}
```

Never the text. Cache keys are SHA-256 hashes — the original content is not recoverable. Safe for healthcare, finance, legal, and air-gapped deployments with no configuration required.

---

## Why not alternatives

| | Portkey / Helicone | GPTCache | Trimwares Trace |
|---|---|---|---|
| Prompts leave your infrastructure | Yes — cloud proxy | No | **No** |
| Works without internet | No | Yes | **Yes** |
| Cross-provider unified view | No | No | **Yes** |
| Token attribution by category | No | No | **Yes** |
| Pre-call optimization | No | No | **Yes** |
| Streaming support | Yes | No | **Yes** |
| One-line setup | Yes | No | **Yes** |
| Model routing | Paid | No | **Yes (opt-in)** |
| Local dashboard | No | No | **Yes** |
| Free tier with real features | No | Yes | **Yes** |

→ **[trace.trimwares.com](https://trace.trimwares.com)** — full comparison

---

## Configuration

Zero-config by default. All optimizations run with conservative settings out of the box.

```ts
const openai = trimwares.openai(new OpenAI(), {
  labels: { project: 'my-app', environment: 'production' },  // group requests in dashboard
  cache: {
    response: { ttlMs: 5 * 60 * 1000 },  // response cache TTL (default: 5 min)
    semantic:  { enabled: false, similarityThreshold: 0.97 }, // off by default — enable for FAQ/support bots
    plan:      { enabled: false },         // agent plan cache
  },
  optimization: {
    routeToCheapestModel: false,  // opt-in — you chose your model for a reason
    filterToolSchemas:    true,   // on by default — only activates with ≥ 3 tools
    pruneContext:         false,  // opt-in — for long-running conversations
  },
});
```

**Semantic cache note:** Uses `all-MiniLM-L6-v2` local embeddings via `@xenova/transformers` (~23 MB, downloaded once). Disabled by default because stress testing showed false positives on structurally similar but semantically different queries (e.g. "capital of France?" matching "capital of Germany?"). Enable only for workloads with near-identical repeated queries.

---

## Dashboard

```bash
npx trimwares serve
```

Opens at `http://localhost:7778`. Auto-registers your current project. Add additional projects from the dashboard at any time using the built-in file browser — no CLI needed.

The dashboard polls every 2.5 seconds, so it stays live while your app runs. Shows the last 7 days of data for free users.

→ **[trace.trimwares.com](https://trace.trimwares.com)** — screenshots and roadmap

---

## License

Apache 2.0 — free to use, modify, and distribute.

Questions, feedback, or want early access to the Developer tier?
**[hello@trimwares.com](mailto:hello@trimwares.com)** · **[trace.trimwares.com](https://trace.trimwares.com)**
