# Changelog

## [1.5.4] — 2026-09-16

### Added
- **Founder contact line** in the postinstall banner, the `npx trimwares analyze` empty state, and the free dashboard's Developer card: "Built by one person — tell me what Trace got wrong: hello@trimwares.com".
- **Free dashboard source now lives in this repo** (`trimwares-dashboard/`, built by `npm run build:ui`). It previously lived in an untracked sibling folder; its only durable record was the built `ui/`.
- **Committed browser test suite** (`e2e/`, `npm run test:e2e`, Playwright) — 10 tests that run the real CLI server against the built dashboard. Every one is a regression check for a bug listed below.
- **Release gate** (`scripts/release-gate.mjs`) — packs the tarball, installs it into an empty folder, seeds a project, runs `trimwares serve` from the *installed* package, and asserts 21 things. `prepublishOnly` is now lint → test → build → build:ui → test:e2e → release:gate.

### Fixed — free dashboard (all shipped broken in 1.5.3)
- **Every green/blue/yellow/red accent was invisible.** `tailwind.config.ts` redeclared those names as flat strings, which replaces Tailwind's numbered palettes, so ~73 classes like `text-green-400` generated no CSS. The "Saved" segment of the spend bar, cache-hit figures, the sidebar's Developer link — all rendered white or not at all. The overrides were Tailwind's own 500 shades; removed.
- **Muted text was unreadable** — the brightest muted tone in use was 3.1:1 on the near-black ground, footnotes were 2:1. Remapped to one four-tier scale; all real text now ≥ ~4.5:1.
- **The Developer card said "Coming soon / Get notified"** for a tier that has been live and purchasable for weeks. Now "Get Developer — $79 once →" straight to checkout, on Overview, Recommendations and Models. Links to the pricing page say "View Developer pricing".
- **Locked sidebar items were 404s** — real links to `/alerts`, `/history`, `/projects`, routes that don't exist in the free build. Now open the Developer pricing page.
- **Settings → "Clear session" was a false success.** It POSTed to `/api/clear`, which didn't exist; the request fell through to the dashboard's HTML with a 200 and the button said "Cleared" without clearing anything. The route exists now (archives to `.trimwares/.sessions/`, identical to `npx trimwares clear`), the UI checks the response and shows an error if it fails, and unknown `/api/*` paths return a JSON 404 instead of the dashboard.
- **The dashboard summed every project you'd ever served from.** `serve` registers each directory it runs in, and the default view aggregated the whole registry under one project's name. Default is now the directory `serve` was started in.
- **Every sidebar click was a full page reload** — RSC payloads were served with the wrong MIME type, so Next rejected them. Now `text/x-component`; navigation is client-side.
- **Blank dashboard after upgrading.** The server sent no cache headers and answered any unknown path — including a stale JS chunk from the previous build — with `index.html` and a 200, so a browser holding the old page loaded HTML as JavaScript and never hydrated. HTML is now `no-cache`, content-hashed assets `immutable`, and missing files 404.
- **"Openai"** in provider badges → "OpenAI" (and Gemini's colour key was misspelled, so it always fell to gray). Four inconsistent money formatters → one.
- **Fonts loaded from Google on every page view** — a third-party request from a local-first tool, and a broken layout offline. Now bundled at build time; the dashboard makes no request to any host but its own server (asserted by the e2e suite).
- Dashboard toolchain: Next 14.2.3 → 16.3.5 (React stays 18), ESLint's Next plugin actually loads now, deterministic build ID so identical source produces byte-identical `ui/`.

### Fixed — release process
- `rollup -c` intermittently finished writing both bundles and then never exited (an exit race around the two `@rollup/plugin-typescript` instances). `npm run build` now runs the same config through rollup's JS API and exits explicitly. Output byte-identical.

### Fixed
- **The optional embeddings package is no longer a hard dependency, and is now the actively-maintained one.** `@xenova/transformers` was listed under `dependencies`, so every `npm install @trimwares/trace` pulled in its full transitive tree (`onnxruntime` → `protobufjs`, `sharp`) — 82 packages and, at last check, 6 vulnerabilities including one critical (`protobufjs`, arbitrary code execution), even though the semantic cache it powers is disabled by default and the code already loads it via a dynamic `import()` wrapped in try/catch with a trigram-similarity fallback. A fresh `npm install @trimwares/trace` now adds 2 packages (itself + `tiktoken`) with 0 vulnerabilities, confirmed via a real `npm pack` + clean-directory install, not just a config read.
  - Moved it to `devDependencies` (so this repo's own `tsc` build still type-checks the dynamic import) and declared it as an optional peer dependency instead — the same pattern already used for `openai`/`@anthropic-ai/sdk`.
  - Also migrated the package itself from `@xenova/transformers` (abandoned at `2.17.2`, no longer updated) to `@huggingface/transformers` (the actively-maintained successor — same original author, moved to the HF npm scope). This resolves a *current* `protobufjs` via a newer `onnxruntime-web`, eliminating the critical CVE at the root rather than just making it opt-in. The `pipeline()` call's `quantized: true` option was renamed `dtype: 'q8'` in the new package (same 8-bit quantization behavior, new option name) — updated in `SemanticCache.ts`.
  - Residual, for anyone who does explicitly opt in (`npm install @huggingface/transformers`): 0 critical, 0 moderate, 5 high-severity advisories remain — `sharp` (libvips/libheif CVEs, no fix available yet at the version range `@huggingface/transformers` pins) and `onnxruntime-node`/`adm-zip` (a zip-bomb-style DoS advisory in a build-time extraction step, not user-facing). None of this reaches the default install. This repo's own dev environment (where the embeddings package is a `devDependency`, for `tsc` + testing) currently shows 14 advisories total (13 high, 1 moderate) — about 10 are pre-existing dev tooling (`@typescript-eslint/*`, `browserslist`, `js-yaml`, `minimatch`, `brace-expansion`) unrelated to this change, the rest are the same embeddings-tree ones above.
  - Precise framing for any external-facing copy: **"The default Trace install has no production audit findings. Semantic embeddings are an optional extra dependency."** Not "0 dependencies of concern" and not "audited" as a standalone marketing claim — both overstate what's actually true once someone opts into the optional feature.
  - See the Semantic cache note under Configuration in the README.
  - Added `scripts/verify-embeddings.mjs` (`npm run verify:embeddings`) — a standalone check run in a plain Node process, deliberately outside Jest. `tests/cache/SemanticCache.test.ts` runs under `--experimental-vm-modules`, which breaks the ONNX runtime's `Float32Array` identity check and makes every embedding call in that suite silently fall through to the trigram fallback — so that suite was only ever proving the fallback path, not real embedding inference (this is pre-existing: the original code's own comment already anticipated "Float32Array VM-context mismatch in test runners" before this migration). The new script asserts real `Float32Array` output, 384-dim vectors, and a material similarity gap between related/unrelated text (not fixed benchmark numbers — the exact scores are sentence-pair-dependent) — and, just as importantly, that the process exits on its own with no forced `process.exit()`, since Jest's own `--detectOpenHandles` warning on this suite needed to be checked against a real runtime rather than assumed benign. Confirmed clean exit, ~0.5s, no hang. Not yet wired into any CI — this repo has no `.github/workflows` at all.

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
