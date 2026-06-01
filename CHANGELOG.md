# Changelog

## [0.1.0] — Unreleased

### Added
- Initial package structure
- `LLMCostTrimmer` main class — zero-config wrapper around any LLM provider
- `ResponseCache` — exact match caching with LRU eviction and TTL
- `SemanticCache` — local trigram TF-IDF cosine similarity cache (no extra AI calls)
- `AgentPlanCache` — novel: caches agent execution plans, not just outputs
- `CostEngine` — per-provider/model cost tracking with pricing table for OpenAI, Anthropic, Gemini, Groq
- `TokenCounter` — deterministic token approximation, zero dependencies
- `WasteDetector` — 5 waste flag types: redundant_request, stale_context, oversized_context, premium_for_simple, missed_cache_hit
- `WasteReporter` — `getWasteReport()` with actionable recommendations
- `PromptCompressor` — rule-based prompt compression (whitespace, filler, HTML comments)
- `ContextPruner` — keyword-relevance-based context pruning
- `ModelRouter` — routes requests to cheapest capable model
- Provider adapters: OpenAI, Anthropic, Gemini, Groq, Ollama
- Full TypeScript types exported as public API
- Test suite: CostEngine, TokenCounter, ResponseCache, SemanticCache, AgentPlanCache, PromptCompressor
- Examples: basic-usage, anthropic-integration, agent-plan-caching
