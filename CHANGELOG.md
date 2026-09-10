# Changelog

## [Unreleased]

### Fixed
- **`@xenova/transformers` is no longer a hard dependency.** It was listed under `dependencies`, so every `npm install @trimwares/trace` pulled in its full transitive tree (`onnxruntime` → `protobufjs`, `sharp`) — 82 packages and, at last check, 6 vulnerabilities including one critical (`protobufjs`, no fix available), even though the semantic cache it powers is disabled by default and the code already loads it via a dynamic `import()` wrapped in try/catch with a trigram-similarity fallback. Moved it to `devDependencies` (so this repo's own `tsc` build still type-checks the dynamic import) and declared it as an optional peer dependency instead — the same pattern already used for `openai`/`@anthropic-ai/sdk`. A fresh `npm install @trimwares/trace` now adds 2 packages (itself + `tiktoken`) with 0 vulnerabilities, confirmed via a real `npm pack` + clean-directory install, not just a config read. Semantic caching still works exactly as documented for anyone who explicitly wants it — run `npm install @xenova/transformers` yourself, then set `cache.semantic.enabled: true`. See the Semantic cache note under Configuration in the README.

## [1.5.3] — 2026-07-19

### Changed
- **Dashboard: free tier is now single-project only.** The multi-project dashboard and file browser have moved to the Developer tier. The free dashboard shows a locked "Multi-project dashboard" entry in the sidebar with a Developer upgrade prompt. If you were using multiple projects on the free tier, they remain accessible individually via `npx trimwares serve` from each project directory.
- **Dashboard: Model Efficiency page.** The Models page has been redesigned as a model efficiency view — efficiency scores, cost-per-token ranking, arbitrage callouts when a cheaper model is available in the same provider family, and cache rate per model. All data comes from your local session log.
- **CLI: website URL on every command.** Every CLI command output now includes `trimwares.com/trace` — on serve startup, login, logout, clear, add, daemon start, and unknown-command errors.
- **README: self-contained provider examples.** All five provider code blocks (OpenAI, Anthropic, Groq, Gemini, Ollama) now include the `import { trimwares }` line so they work as copy-paste. Onboarding flow clarified: `npx trimwares serve` auto-registers your current directory — no `npx trimwares add .` step required.
- **Recommendations: data-driven savings estimates.** `buildRecommendations()` now computes projected savings from your actual session data. No hardcoded percentages.
- **npm: updated description and keywords.** Description now leads with the local-first differentiator. Keywords added: `local-first`, `no-proxy`, `token-attribution`, `llm-monitoring`, `ai-cost-tracker`, `groq-cost`, `claude-cost`.
- **Public repo cleanup.** Internal docs (`NOTES.md`, `CONSULTANT-SUMMARY.md`, `VERIFICATION.md`, `BENCHMARK-DISCLOSURE.md`, `SECURITY-BRIEF.md`), stale website HTML, and simulation result files are now gitignored and absent from the published package.

### Fixed
- `prepublishOnly` test step no longer fails when the test suite is empty (`--passWithNoTests` added).

---

## [1.5.0] — 2026-07-12

### Added
- Initial package structure
- `LLMCostTrimmer` main class — zero-config wrapper around any LLM provider
- `ResponseCache` — exact match caching with LRU eviction and TTL
- `SemanticCache` — local all-MiniLM-L6-v2 embeddings via @xenova/transformers (ONNX WASM, ~23MB, downloaded once); disabled by default; no extra AI calls
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
