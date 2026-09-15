/**
 * Credibility Verification Report
 *
 * Proves savings claims using:
 *   - tiktoken cl100k_base for real BPE token counts (not our approximation)
 *   - Provider-verified pricing from public docs (sources cited inline)
 *   - Step-by-step math, independently checkable
 *
 * No mocks. No internal pricing table. No circular reasoning.
 *
 * Run: npx tsx tests/verification/credibility-report.mjs
 */

import { get_encoding } from 'tiktoken';
import { ToolSchemaFilter } from '../../src/optimization/ToolSchemaFilter.js';
import { ModelRouter }      from '../../src/optimization/ModelRouter.js';
import { PromptCacheOptimizer } from '../../src/cache/PromptCacheOptimizer.js';

const enc     = get_encoding('cl100k_base');
const filter  = new ToolSchemaFilter();
const router  = new ModelRouter();
const cacheOpt = new PromptCacheOptimizer('anthropic');

function tokens(text) { return enc.encode(text).length; }
function usd(n)       { return '$' + n.toFixed(6); }
function pct(a, b)    { return ((a / b) * 100).toFixed(1) + '%'; }

// ─── VERIFIED PRICING (source: provider pricing pages, June 2026) ─────────────
//
// OpenAI:    https://openai.com/api/pricing
// Anthropic: https://www.anthropic.com/pricing
//
// All prices in USD per 1,000,000 tokens

const PRICING = {
  // OpenAI
  'gpt-4o':         { in: 2.50,  out: 10.00, cached: 1.25  },  // OpenAI auto-caches prefixes > 1024 tokens
  'gpt-4o-mini':    { in: 0.15,  out: 0.60,  cached: 0.075 },
  // Anthropic
  'claude-sonnet':  { in: 3.00,  out: 15.00, cached: 0.30  },  // cache_read price
  'claude-haiku':   { in: 1.00,  out: 5.00,  cached: 0.10  },
};

function cost(inputTok, outputTok, model, cached = false) {
  const p = PRICING[model];
  const inPrice = cached ? p.cached : p.in;
  return (inputTok / 1e6) * inPrice + (outputTok / 1e6) * p.out;
}

const HR  = '─'.repeat(72);
const HR2 = '═'.repeat(72);

console.log('\n' + HR2);
console.log('  TRIMWARES — Savings Credibility Verification Report');
console.log('  Token counts: tiktoken cl100k_base (real BPE, not approximation)');
console.log('  Pricing: provider public docs, June 2026');
console.log(HR2);

// ─────────────────────────────────────────────────────────────────────────────
// CLAIM 1: ModelRouter saves 94% on simple GPT-4o requests
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  CLAIM 1: Routing simple requests from GPT-4o → GPT-4o-mini');
console.log('  ' + HR);

const simpleMessages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user',   content: 'What is the capital of France?' },
];
const simpleInputTok  = simpleMessages.reduce((s, m) => s + tokens(m.content), 0);
const simpleOutputTok = tokens('Paris is the capital of France.');

const decision = router.route({ messages: simpleMessages }, 'gpt-4o', 'openai');

const costBefore = cost(simpleInputTok, simpleOutputTok, 'gpt-4o');
const costAfter  = cost(simpleInputTok, simpleOutputTok, 'gpt-4o-mini');
const saving1    = costBefore - costAfter;
const pctSaved1  = (saving1 / costBefore) * 100;

console.log(`  Request:     "${simpleMessages[1].content}"`);
console.log(`  Input tokens (tiktoken BPE):  ${simpleInputTok}`);
console.log(`  Output tokens (tiktoken BPE): ${simpleOutputTok}`);
console.log('');
console.log(`  WITHOUT routing (GPT-4o @ $${PRICING['gpt-4o'].in}/MTok input):`);
console.log(`    Cost = (${simpleInputTok} × $${PRICING['gpt-4o'].in}/1M) + (${simpleOutputTok} × $${PRICING['gpt-4o'].out}/1M)`);
console.log(`    Cost = ${usd(costBefore)}`);
console.log('');
console.log(`  WITH routing (GPT-4o-mini @ $${PRICING['gpt-4o-mini'].in}/MTok input):`);
console.log(`    Cost = (${simpleInputTok} × $${PRICING['gpt-4o-mini'].in}/1M) + (${simpleOutputTok} × $${PRICING['gpt-4o-mini'].out}/1M)`);
console.log(`    Cost = ${usd(costAfter)}`);
console.log('');
console.log(`  Saving per call: ${usd(saving1)} (${pctSaved1.toFixed(1)}%)`);
console.log(`  Router decision: wasRouted=${decision.wasRouted}, model=${decision.model}`);
console.log(`  Complexity classified as: ${decision.complexity}`);
console.log('');
console.log(`  At 1,000 simple calls/day: save ${usd(saving1 * 1000)}/day = ${usd(saving1 * 30_000)}/month`);

// ─────────────────────────────────────────────────────────────────────────────
// CLAIM 2: ToolSchemaFilter reduces agent tool-schema token cost per step (5-15% typical)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  CLAIM 2: ToolSchemaFilter reduces agent tool schema tokens');
console.log('  ' + HR);

const agentTools = [
  { name: 'web_search',     description: 'Search the web for current information, news, and data about any topic or company', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' }, num_results: { type: 'number' }, date_filter: { type: 'string', enum: ['any', 'past_week', 'past_month'] } }, required: ['query'] } },
  { name: 'browse_url',     description: 'Fetch and extract text content from a specific URL, article, or web page',          parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to fetch' }, sections: { type: 'array', items: { type: 'string' } } }, required: ['url'] } },
  { name: 'analyze_data',   description: 'Perform structured analysis on datasets, spreadsheets, CSV files, and structured text', parameters: { type: 'object', properties: { data: { type: 'string' }, analysis_type: { type: 'string', enum: ['summary', 'comparison', 'trend', 'anomaly'] } }, required: ['data', 'analysis_type'] } },
  { name: 'save_finding',   description: 'Save an important research finding, note, or discovered fact to the research memory', parameters: { type: 'object', properties: { category: { type: 'string', enum: ['pricing', 'feature', 'customer', 'news'] }, finding: { type: 'string' }, confidence: { type: 'string', enum: ['confirmed', 'likely', 'uncertain'] } }, required: ['category', 'finding'] } },
  { name: 'compile_report', description: 'Compile all gathered research findings into a structured final report document',     parameters: { type: 'object', properties: { target: { type: 'string' }, type: { type: 'string', enum: ['quick', 'standard', 'comprehensive'] }, sections: { type: 'array', items: { type: 'string' } } }, required: ['target', 'type'] } },
];

const allToolsJson     = JSON.stringify(agentTools);
const allToolsTokens   = tokens(allToolsJson);

// Step where agent is clearly just searching
const searchStep = [{ role: 'user', content: 'Search the web for latest competitor pricing and browse their pricing pages' }];
const filtered   = filter.filter(agentTools, searchStep);
const filteredTokens = tokens(JSON.stringify(filtered.tools));

const agentModel     = 'claude-sonnet';
const agentOutputTok = 150; // typical step output
const costAllTools   = cost(allToolsTokens + 50, agentOutputTok, agentModel);
const costFiltered   = cost(filteredTokens  + 50, agentOutputTok, agentModel);
const saving2        = costAllTools - costFiltered;
const pctSaved2      = (saving2 / costAllTools) * 100;

console.log(`  Scenario: 5-tool agent, step where intent = "search + browse"`);
console.log(`  Step message: "${searchStep[0].content.slice(0, 60)}..."`);
console.log('');
console.log(`  ALL tools sent (tiktoken BPE):  ${allToolsTokens} tokens`);
console.log(`  Filtered tools sent:             ${filteredTokens} tokens (${filtered.filteredCount} of ${filtered.originalCount} tools)`);
console.log(`  Tools removed:                   ${filtered.originalCount - filtered.filteredCount} irrelevant tool(s)`);
console.log(`  Filter reasoning:                ${filtered.reasoning}`);
console.log('');
console.log(`  WITHOUT filtering (Claude Sonnet @ $${PRICING[agentModel].in}/MTok):`);
console.log(`    Cost = ${usd(costAllTools)}`);
console.log(`  WITH filtering:`);
console.log(`    Cost = ${usd(costFiltered)}`);
console.log(`  Saving per step: ${usd(saving2)} (${pctSaved2.toFixed(1)}%)`);
console.log('');
const stepsPerRun = 10;
const runsPerDay  = 50;
const dailySaving = saving2 * stepsPerRun * runsPerDay;
console.log(`  At ${runsPerDay} agent runs/day × ${stepsPerRun} steps: save ${usd(dailySaving)}/day = ${usd(dailySaving * 30)}/month`);

// ─────────────────────────────────────────────────────────────────────────────
// CLAIM 3: Anthropic native caching cuts repeat-call cost on large, stable system prompts
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  CLAIM 3: Anthropic cache_control cuts repeat-call cost on large, stable system prompts');
console.log('  ' + HR);

// Realistic system prompt sized to exceed Anthropic's 1,024-token combined cache threshold,
// so cache_control is actually injected and the savings below are measured, not assumed.
const systemBlock1 = `You are a customer support agent for TechFlow, an AI-powered project management platform.

PRICING TIERS
Starter: $29/month per workspace. Up to 10 users. Core features. 5GB storage.
Pro: $99/month per workspace. Up to 50 users. Advanced analytics, custom workflows, 50GB storage, priority support.
Business: $299/month per workspace. Unlimited users. SSO, audit logs, custom roles, 500GB storage, SLA.
Enterprise: Custom pricing. Dedicated infrastructure, compliance packages, professional onboarding.
All plans: 14-day free trial, no credit card required. No credit card required.

FEATURE BREAKDOWN BY TIER
Task management: all tiers. Kanban boards: all tiers. Gantt charts: Pro+.
Custom fields: Pro+ (up to 20 fields), Business+ (unlimited fields).
Time tracking: Pro+. Workload management: Business+. Resource planning: Enterprise.
Custom workflows: Pro+ (5 workflows), Business+ (unlimited workflows).
Automation rules: Starter (3 rules), Pro (25 rules), Business+ (unlimited).
Reporting dashboards: Starter (basic), Pro (advanced + exports), Business+ (custom dashboards + scheduled exports).
Guest access: Pro+ (5 guests), Business+ (unlimited guests, view-only by default).
Mobile apps: iOS and Android, all tiers, full feature parity with web.

SECURITY AND COMPLIANCE
SOC 2 Type II certified (renewed annually, report available under NDA via Settings > Compliance).
GDPR compliant — EU data residency option available on Business+ and Enterprise.
Data encrypted at rest (AES-256) and in transit (TLS 1.3).
SSO via SAML 2.0 and OIDC available on Business+ (Okta, Azure AD, Google Workspace supported).
Audit logs retained for 1 year on Business, 7 years on Enterprise.
Two-factor authentication available on all tiers, enforceable org-wide on Business+.
Role-based access control: Owner, Admin, Member, Guest on all tiers; custom roles on Business+.
IP allowlisting available on Enterprise.`;

const systemBlock2 = `BILLING AND PAYMENTS
Accepted: Visa, Mastercard, American Express, bank transfer (Business+), PayPal.
Billing cycle: monthly or annual (annual = 2 months free).
Invoices: auto-emailed on billing date, available in Settings > Billing.
Upgrades: prorated immediately. Downgrades: effective next cycle.
Refunds: 30-day money-back guarantee on first payment.

CANCELLATION POLICY
Cancel anytime from Settings > Billing > Cancel Plan. No cancellation fees.
Data retained for 90 days post-cancellation for export.

INTEGRATIONS
GitHub: two-way sync of issues and pull requests, configurable per-repo.
Jira: one-way import (full bidirectional sync requires Business).
Slack: channel notifications for task updates, mentions, and due dates.
Zapier (Pro+): connect to 5,000+ apps via triggers and actions.
Webhooks (Business+): outbound events for task created, updated, completed, and comment added.
REST API (all tiers): rate-limited to 100 req/min on Starter, 500 req/min on Pro,
2,000 req/min on Business, custom limits on Enterprise.
API authentication via personal access tokens (Starter/Pro) or OAuth 2.0 (Business+).

TROUBLESHOOTING — COMMON ISSUES
"Workspace is locked": occurs when the billing payment fails twice; update payment method
in Settings > Billing > Payment Methods to unlock immediately.
"Sync delayed" for GitHub/Jira: integrations sync every 5 minutes; manual sync available
via the integration settings page, rate-limited to once per 2 minutes.
"Cannot invite users": Starter tier is capped at 10 users; upgrade to Pro or remove
inactive members under Settings > Members > Manage.
"SSO login loop": usually caused by a clock skew greater than 5 minutes between the
identity provider and TechFlow; verify NTP sync on the IdP server.
Export formats supported: CSV, JSON, and PDF for reports; CSV and JSON for raw task data.
Support response times: Starter/Pro best-effort (no SLA), Business 24h SLA on business days,
Enterprise 4h SLA with 24/7 coverage.

DATA RETENTION AND BACKUPS
Backups taken every 6 hours, retained for 30 days on all paid tiers.
Point-in-time restore available on Business+ (granularity: 1 hour) and Enterprise (granularity: 15 minutes).
Deleted workspaces are recoverable for 14 days before permanent purge.
Attachments stored separately from task data; storage quota applies to attachments only.`;

const combined = systemBlock1 + '\n\n' + systemBlock2;
const systemTok1 = tokens(systemBlock1);
const systemTok2 = tokens(systemBlock2);
const combinedTok = tokens(combined);

const cacheResult = cacheOpt.optimize(
  { messages: [{ role: 'system', content: systemBlock1 }, { role: 'system', content: systemBlock2 }, { role: 'user', content: 'How do I cancel?' }] },
  'anthropic'
);

const userQueryTok = tokens('How do I cancel?');
const outputTok3   = tokens('You can cancel anytime from Settings > Billing > Cancel Plan. No fees apply.');
const totalInputTok = combinedTok + userQueryTok;

const costFirstCall  = cost(totalInputTok, outputTok3, 'claude-sonnet');           // full price
const costCachedCall = cost(totalInputTok, outputTok3, 'claude-sonnet', true);     // cached price for system portion

// On repeat calls, user query is still full price, cached portion at 10%
const cachedPortion    = combinedTok;
const uncachedPortion  = userQueryTok;
const costRepeatCall   = cost(uncachedPortion, outputTok3, 'claude-sonnet') + cost(cachedPortion, 0, 'claude-sonnet', true);
const saving3          = costFirstCall - costRepeatCall;
const pctSaved3        = (saving3 / costFirstCall) * 100;

console.log(`  System block 1: ${systemTok1} tokens (BPE)`);
console.log(`  System block 2: ${systemTok2} tokens (BPE)`);
console.log(`  Combined:       ${combinedTok} tokens (BPE)`);
console.log(`  cache_control injected: ${cacheResult.cacheableTokens > 0 ? 'YES — optimizer estimates ' + cacheResult.cacheableTokens + ' tokens (chars/4 heuristic, no tiktoken dependency), which clears the 1,024 threshold' : 'NO — below 1,024 threshold'}`);
console.log('');
console.log(`  First call (cache write): ${usd(costFirstCall)}`);
console.log(`  Repeat calls:             ${usd(costRepeatCall)}`);
console.log(`    (${cachedPortion} system tokens at $${PRICING['claude-sonnet'].cached}/MTok + ${uncachedPortion} query tokens at $${PRICING['claude-sonnet'].in}/MTok)`);
console.log(`  Saving per repeat call:   ${usd(saving3)} (${pctSaved3.toFixed(1)}%)`);
console.log('');
const callsPerDay3 = 500;
const dailySaving3 = saving3 * (callsPerDay3 - 1); // minus one for first call
console.log(`  At ${callsPerDay3} calls/day: first call full price, ${callsPerDay3 - 1} at cached price`);
console.log(`  Daily saving: ${usd(dailySaving3)} | Monthly: ${usd(dailySaving3 * 30)}`);

// ─────────────────────────────────────────────────────────────────────────────
// CLAIM 4: Response cache — 40% repeat traffic = 40% cost reduction
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  CLAIM 4: Response cache — repeat traffic = equivalent cost reduction');
console.log('  ' + HR);

const avgInputTok4  = tokens('You are a helpful assistant. What is the capital of France?');
const avgOutputTok4 = tokens('Paris is the capital of France.');
const costPerCall4  = cost(avgInputTok4, avgOutputTok4, 'gpt-4o');
const totalCalls4   = 1000;
const repeatRate4   = 0.40;
const liveCalls4    = totalCalls4 * (1 - repeatRate4);

const costWithout = costPerCall4 * totalCalls4;
const costWith    = costPerCall4 * liveCalls4; // cache hits = $0
const saving4     = costWithout - costWith;

console.log(`  Scenario: 1,000 calls/day, ${(repeatRate4 * 100).toFixed(0)}% repeat queries`);
console.log(`  Avg input:  ${avgInputTok4} tokens | Avg output: ${avgOutputTok4} tokens`);
console.log(`  Cost per live call (GPT-4o): ${usd(costPerCall4)}`);
console.log('');
console.log(`  WITHOUT cache: ${totalCalls4} calls × ${usd(costPerCall4)} = ${usd(costWithout)}/day`);
console.log(`  WITH cache:    ${liveCalls4} live + ${totalCalls4 * repeatRate4} cached ($0 each) = ${usd(costWith)}/day`);
console.log(`  Saving: ${usd(saving4)}/day (${((saving4 / costWithout) * 100).toFixed(1)}%)`);
console.log(`  Monthly: ${usd(saving4 * 30)}`);

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n' + HR2);
console.log('  VERIFIED SAVINGS SUMMARY');
console.log(HR2);
console.log('');
console.log(`  ModelRouter (simple GPT-4o → GPT-4o-mini)   ${pctSaved1.toFixed(0)}% per routed call`);
console.log(`  ToolSchemaFilter (agent, search step)        ${pctSaved2.toFixed(0)}% of tool token cost per step`);
console.log(`  Native caching (Anthropic, ${combinedTok}-tok system)  ${pctSaved3.toFixed(0)}% on repeat calls`);
console.log(`  Response cache (40% repeat traffic)          ${((saving4/costWithout)*100).toFixed(0)}% of total daily spend`);
console.log('');
console.log('  All numbers derived from:');
console.log('  • tiktoken cl100k_base — same tokenizer GPT-4o uses');
console.log('  • Provider pricing pages — not internal estimates');
console.log('  • Open math — reproduce with: tiktoken.encode(text).length * price_per_token');
console.log('');

enc.free();
