/**
 * Cost reduction integration tests — proves concrete savings numbers.
 *
 * These tests use realistic scenarios and verify that the three
 * cost reduction mechanisms actually deliver measurable savings.
 */

import { LLMCostTrimmer } from '../../src/index.js';
import { MockProvider } from '../helpers/MockProvider.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTrimmer(overrides = {}) {
  const provider = new MockProvider({ name: 'openai', model: 'gpt-4o', inputTokens: 500, outputTokens: 80 });
  const trimmer  = new LLMCostTrimmer(provider, overrides);
  return { trimmer, provider };
}

const SYSTEM_800 = 'A'.repeat(3200);  // ~800 tokens (3200 chars / 4)
const SYSTEM_500 = 'B'.repeat(2000);  // ~500 tokens

const TOOL_SCHEMAS_5 = [
  { name: 'web_search',     description: 'Search the web for current information about any topic',  parameters: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'browse_url',     description: 'Fetch content from a URL to read articles or pages',      parameters: { type: 'object', properties: { url:   { type: 'string' } } } },
  { name: 'analyze_data',   description: 'Analyze data sets, spreadsheets, and structured content', parameters: { type: 'object', properties: { data:  { type: 'string' } } } },
  { name: 'save_finding',   description: 'Save research notes and important discovered findings',    parameters: { type: 'object', properties: { note:  { type: 'string' } } } },
  { name: 'compile_report', description: 'Compile all research into a final structured report',     parameters: { type: 'object', properties: { title: { type: 'string' } } } },
];

// ─── Test 1: Response cache delivers near-100% savings on repeat traffic ─────

describe('Cost reduction: Response cache', () => {
  it('40% repeat traffic → 40% cost reduction', async () => {
    const { trimmer } = makeTrimmer();

    const uniqueReqs = Array.from({ length: 6 }, (_, i) => ({
      messages: [{ role: 'user' as const, content: `Unique question number ${i} about topic ${i}` }],
    }));
    const repeatReqs = Array.from({ length: 4 }, () => ({
      messages: [{ role: 'user' as const, content: 'Unique question number 0 about topic 0' }],
    }));

    // 6 unique + 4 repeats = 10 total, 40% repeat
    for (const req of [...uniqueReqs, ...repeatReqs]) {
      await trimmer.chat(req);
    }

    const report = trimmer.getCostReport();
    expect(report.totalRequests).toBe(10);
    expect(report.cachedRequests).toBe(4);
    expect(report.cacheHitRate).toBe(40);

    // Savings should be ≥ 40% of what we'd have spent without caching
    const totalIfNoCaching = report.totalCost + report.totalSavings;
    const actualSavingsPct = (report.totalSavings / totalIfNoCaching) * 100;
    expect(actualSavingsPct).toBeGreaterThanOrEqual(38); // within 2% of target
    trimmer.destroy();
  });

  it('typical support bot: 70% repeat → 70% cost reduction', async () => {
    const { trimmer } = makeTrimmer();
    const req = { messages: [
      { role: 'system' as const, content: SYSTEM_800 },
      { role: 'user'   as const, content: 'How do I cancel?' },
    ]};

    await trimmer.chat(req); // first call
    for (let i = 0; i < 9; i++) await trimmer.chat(req); // 9 repeats

    const report = trimmer.getCostReport();
    const totalIfNoCaching = report.totalCost + report.totalSavings;
    const savingsPct = (report.totalSavings / totalIfNoCaching) * 100;

    expect(savingsPct).toBeGreaterThanOrEqual(85); // 9/10 cached = 90%
    trimmer.destroy();
  });
});

// ─── Test 2: ModelRouter routes simple requests to cheaper models ─────────────

describe('Cost reduction: ModelRouter', () => {
  it('classifies short non-tool request as simple', () => {
    const { trimmer } = makeTrimmer();
    const router = (trimmer as unknown as { router: { classify: (r: unknown) => string } }).router;
    const complexity = router.classify({
      messages: [{ role: 'user', content: 'What is 2 + 2?' }],
    });
    expect(complexity).toBe('simple');
    trimmer.destroy();
  });

  it('classifies agent request with tools as complex', () => {
    const { trimmer } = makeTrimmer();
    const router = (trimmer as unknown as { router: { classify: (r: unknown) => string } }).router;
    const complexity = router.classify({
      messages: [{ role: 'user', content: 'Search for competitors' }],
      tools: TOOL_SCHEMAS_5,
    });
    expect(complexity).toBe('complex');
    trimmer.destroy();
  });

  it('classifies long context request as complex', () => {
    const { trimmer } = makeTrimmer();
    const router = (trimmer as unknown as { router: { classify: (r: unknown) => string } }).router;
    const complexity = router.classify({
      messages: [
        { role: 'system',    content: SYSTEM_800 },
        { role: 'user',      content: 'Turn 1' },
        { role: 'assistant', content: 'Response 1' },
        { role: 'user',      content: 'Turn 2' },
        { role: 'assistant', content: 'Response 2' },
        { role: 'user',      content: 'Turn 3' },
        { role: 'assistant', content: 'Response 3' },
        { role: 'user',      content: 'Turn 4 — long conversation' },
      ],
    });
    expect(complexity).toBe('complex');
    trimmer.destroy();
  });

  it('routes simple request to cheaper same-provider model', () => {
    const { trimmer } = makeTrimmer();
    const router = (trimmer as unknown as { router: { route: (r: unknown, m: string, p: string) => unknown } }).router;
    const decision = router.route(
      { messages: [{ role: 'user', content: 'What time is it?' }] },
      'gpt-4o', 'openai'
    ) as { wasRouted: boolean; model: string; estimatedSavingsPercent: number };

    expect(decision.wasRouted).toBe(true);
    expect(decision.model).toBe('gpt-4o-mini');   // same provider, budget tier
    expect(decision.estimatedSavingsPercent).toBeGreaterThanOrEqual(90); // gpt-4o→mini is ~94% cheaper
    trimmer.destroy();
  });

  it('does NOT route complex requests', () => {
    const { trimmer } = makeTrimmer();
    const router = (trimmer as unknown as { router: { route: (r: unknown, m: string, p: string) => unknown } }).router;
    const decision = router.route(
      { messages: [{ role: 'user', content: 'Analyze this dataset and explain the trends' }], tools: TOOL_SCHEMAS_5 },
      'gpt-4o', 'openai'
    ) as { wasRouted: boolean };
    expect(decision.wasRouted).toBe(false);
    trimmer.destroy();
  });
});

// ─── Test 3: ToolSchemaFilter cuts agent token waste ─────────────────────────

describe('Cost reduction: ToolSchemaFilter', () => {
  it('filters irrelevant tools from agent step', () => {
    const { trimmer } = makeTrimmer();
    const filter = (trimmer as unknown as { toolFilter: { filter: (t: unknown, m: unknown) => { tokensSaved: number; filteredCount: number; originalCount: number } } }).toolFilter;

    const result = filter.filter(TOOL_SCHEMAS_5, [
      { role: 'user', content: 'Now search the web for pricing information on competitor products' },
    ]);

    // web_search and browse_url should be relevant; save tokens on the rest
    expect(result.originalCount).toBe(5);
    expect(result.filteredCount).toBeLessThan(5);
    expect(result.tokensSaved).toBeGreaterThan(0);
    trimmer.destroy();
  });

  it('never drops below 2 tools (conservative fallback)', () => {
    const { trimmer } = makeTrimmer();
    const filter = (trimmer as unknown as { toolFilter: { filter: (t: unknown, m: unknown) => { tools: unknown[] } } }).toolFilter;

    const result = filter.filter(TOOL_SCHEMAS_5, [
      { role: 'user', content: 'xyzzy frumple absurdist query that matches nothing' },
    ]);
    expect(result.tools.length).toBeGreaterThanOrEqual(2);
    trimmer.destroy();
  });

  it('retains recently called tools regardless of current intent', () => {
    const { trimmer } = makeTrimmer();
    const filter = (trimmer as unknown as { toolFilter: { filter: (t: unknown, m: unknown) => { tools: { name: string }[] } } }).toolFilter;

    const result = filter.filter(TOOL_SCHEMAS_5, [
      { role: 'assistant', content: 'I used {"tool_name": "compile_report"} to make the report' },
      { role: 'user',      content: 'Search the web now' },
    ]);
    const names = result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('compile_report'); // recently used
    expect(names).toContain('web_search');     // current intent
    trimmer.destroy();
  });
});

// ─── Test 4: Combined — all three working together ───────────────────────────

describe('Cost reduction: Combined savings', () => {
  it('agent with repeat tasks saves on both caching and schema filtering', async () => {
    const provider = new MockProvider({ name: 'openai', model: 'gpt-4o', inputTokens: 800, outputTokens: 100 });
    const trimmer  = new LLMCostTrimmer(provider);

    const agentStep = {
      messages: [
        { role: 'system' as const,    content: 'You are a research agent.' },
        { role: 'user'   as const,    content: 'Search the web for the latest AI model releases' },
      ],
      tools: TOOL_SCHEMAS_5,
    };

    // 10 calls — first live, rest cached
    for (let i = 0; i < 10; i++) await trimmer.chat(agentStep);

    const report = trimmer.getCostReport();
    expect(report.cachedRequests).toBeGreaterThanOrEqual(8); // most are cached
    expect(report.totalSavings).toBeGreaterThan(report.totalCost); // saved more than spent

    trimmer.destroy();
  });
});
