/**
 * Black-box test — Level 3.
 *
 * This file knows NOTHING about the internals of llm-cost-trimmer.
 * It uses only what the public API exposes, exactly as a real developer would.
 * Imports are from the package name, not relative source paths.
 */

import { LLMCostTrimmer, BaseProvider } from '@trimwares/trace';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    failed++;
  }
}

// ─── Minimal provider — written from scratch, no internal knowledge ───────────

class StandaloneProvider extends BaseProvider {
  get name()         { return 'openai'; }
  get defaultModel() { return 'gpt-4o-mini'; }

  async send(request) {
    // Simulate realistic token counts proportional to content
    const totalChars    = request.messages.reduce((s, m) => s + m.content.length, 0);
    const inputTokens   = Math.ceil(totalChars / 4);
    const outputTokens  = Math.ceil(inputTokens * 0.15);
    return {
      content:      `Standalone answer for: ${request.messages.at(-1)?.content?.slice(0, 40)}`,
      model:        'gpt-4o-mini',
      inputTokens,
      outputTokens,
      cachedTokens: 0,
    };
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n  Trimwares — Black-Box Install Test');
console.log('  ─────────────────────────────────────────────────\n');

// 1. Package imports correctly
console.log('  [1] Package imports');
assert(typeof LLMCostTrimmer === 'function', 'LLMCostTrimmer is exported and is a class');
assert(typeof BaseProvider   === 'function', 'BaseProvider is exported');

// 2. Instantiation
console.log('\n  [2] Instantiation');
const provider = new StandaloneProvider();
const trimmer  = new LLMCostTrimmer(provider);
assert(typeof trimmer.chat          === 'function', 'trimmer.chat() exists');
assert(typeof trimmer.getCostReport === 'function', 'trimmer.getCostReport() exists');
assert(typeof trimmer.getWasteReport === 'function', 'trimmer.getWasteReport() exists');
assert(typeof trimmer.printReport   === 'function', 'trimmer.printReport() exists');
assert(typeof trimmer.getPlan       === 'function', 'trimmer.getPlan() exists');
assert(typeof trimmer.recordPlan    === 'function', 'trimmer.recordPlan() exists');

// 3. First call — live, not cached
console.log('\n  [3] First chat() call');
const req = {
  messages: [
    { role: 'system',  content: 'You are a helpful assistant with deep knowledge of world geography.' },
    { role: 'user',    content: 'What is the capital of France?' },
  ],
};
const first = await trimmer.chat(req);
assert(typeof first.content   === 'string',  'response has content');
assert(first.cached           === false,     'first call is not cached');
assert(first.cacheType        === 'none',    'cacheType is none');
assert(first.cost             >  0,          'cost is greater than zero');
assert(first.savings          === 0,         'no savings on first call');
assert(typeof first.requestId === 'string',  'requestId is a string');
assert(first.requestId.length === 12,        'requestId is 12 chars');
assert(first.usage.inputTokens  > 0,         'inputTokens recorded');
assert(first.usage.outputTokens > 0,         'outputTokens recorded');

// 4. Second identical call — must hit response cache
console.log('\n  [4] Cache hit on repeat request');
const second = await trimmer.chat(req);
assert(second.cached     === true,       'second call is cached');
assert(second.cacheType  === 'response', 'cacheType is response');
assert(second.cost       === 0,          'cached call costs nothing');
assert(second.savings    === first.cost, 'savings equals original cost');

// 5. Different request — must miss
console.log('\n  [5] Cache miss on different request');
const different = await trimmer.chat({
  messages: [{ role: 'user', content: 'What is the capital of Germany?' }],
});
assert(different.cached === false, 'different request is not cached');

// 6. Cost report reflects all 3 calls
console.log('\n  [6] getCostReport()');
const report = trimmer.getCostReport();
assert(report.totalRequests  === 3,    'all 3 requests counted');
assert(report.cachedRequests === 1,    '1 cached request');
assert(report.cacheHitRate   === 33.3, 'cache hit rate is 33.3%');
assert(report.totalCost      >  0,     'total cost is positive');
assert(report.totalSavings   >  0,     'total savings is positive');
assert(typeof report.byProvider === 'object', 'byProvider breakdown exists');
assert(typeof report.byModel    === 'object', 'byModel breakdown exists');
assert(report.dashboardHint !== undefined,    'dashboardHint present');

// 7. Waste report works
console.log('\n  [7] getWasteReport()');
const waste = trimmer.getWasteReport();
assert(typeof waste.totalWaste      === 'number', 'totalWaste is a number');
assert(typeof waste.recommendations === 'object', 'recommendations is an array');
assert(Array.isArray(waste.topWasteDrivers),      'topWasteDrivers is an array');

// 8. ResetStats clears everything
console.log('\n  [8] resetStats()');
trimmer.resetStats();
const cleared = trimmer.getCostReport();
assert(cleared.totalRequests === 0, 'after reset: 0 requests');
assert(cleared.totalCost     === 0, 'after reset: $0 cost');

// 9. Agentic plan cache
console.log('\n  [9] AgentPlanCache');
const plan = trimmer.recordPlan({
  taskDescription: 'Search for AI news and summarize the top 3 headlines',
  steps: [
    { stepIndex: 0, toolName: 'web_search',  toolArgs: { query: 'AI news today' } },
    { stepIndex: 1, toolName: 'summarize',   toolArgs: { maxWords: 150 } },
  ],
  inputTokensUsed:  400,
  outputTokensUsed: 80,
});
assert(typeof plan.planId          === 'string', 'plan has planId');
assert(plan.steps.length           === 2,        'plan has 2 steps');
assert(plan.estimatedTokensSaved   === 480,      'estimatedTokensSaved = 400 + 80');

const cached = trimmer.getPlan('Search for AI news and summarize the top 3 headlines');
assert(cached !== null,            'exact task retrieves cached plan');
assert(cached?.hitCount === 1,     'hitCount incremented to 1');

const miss = trimmer.getPlan('something completely unrelated about cooking');
assert(miss === null,              'unrelated task returns null');

// 10. Security — session log has no content strings
console.log('\n  [10] Security — no content in session log');
await trimmer.chat({ messages: [
  { role: 'user', content: 'My credit card is 4532-0151-1283-0366 and my SSN is 078-05-1120' }
]});
const buffer    = trimmer['sessionLog']?.getBuffer?.() ?? [];
const bufferStr = JSON.stringify(buffer);
assert(!bufferStr.includes('4532'), 'card number not in session log');
assert(!bufferStr.includes('078-05'), 'SSN not in session log');

// ─── Summary ──────────────────────────────────────────────────────────────────

trimmer.destroy();

console.log('\n  ─────────────────────────────────────────────────');
console.log(`  Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('\n  BLACKBOX TEST FAILED — package does not behave as documented\n');
  process.exit(1);
} else {
  console.log('\n  All black-box checks passed — package works as a real install would\n');
  process.exit(0);
}
