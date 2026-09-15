import { AgentPlanCache } from '../../src/cache/AgentPlanCache.js';

const STEPS = [
  { stepIndex: 0, toolName: 'search', toolArgs: { query: 'weather today' }, reasoning: 'Need current data' },
  { stepIndex: 1, toolName: 'format', toolArgs: { style: 'brief' } },
];

describe('AgentPlanCache', () => {
  let cache: AgentPlanCache;

  beforeEach(() => {
    cache = new AgentPlanCache({ ttlMs: 60_000, maxEntries: 50 });
  });

  afterEach(() => {
    cache.destroy();
  });

  it('returns null for unknown task', () => {
    expect(cache.getPlan('some unknown task description')).toBeNull();
  });

  it('stores and retrieves a plan', () => {
    const task = 'Fetch today\'s weather for New York and format as a brief summary';
    cache.storePlan({ taskDescription: task, steps: STEPS, provider: 'openai', model: 'gpt-4o', inputTokensUsed: 500, outputTokensUsed: 200 });

    const plan = cache.getPlan(task);
    expect(plan).not.toBeNull();
    expect(plan?.steps).toHaveLength(2);
    expect(plan?.steps[0].toolName).toBe('search');
  });

  it('increments hitCount on each retrieval', () => {
    const task = 'Summarize the latest news headlines';
    cache.storePlan({ taskDescription: task, steps: STEPS, provider: 'anthropic', model: 'claude-haiku-4-5', inputTokensUsed: 300, outputTokensUsed: 100 });

    cache.getPlan(task);
    cache.getPlan(task);
    const plan = cache.getPlan(task);
    expect(plan?.hitCount).toBe(3);
  });

  it('is case and whitespace insensitive for task hashing', () => {
    const task1 = 'Fetch Weather Data';
    const task2 = '  fetch weather data  ';
    cache.storePlan({ taskDescription: task1, steps: STEPS, provider: 'openai', model: 'gpt-4o-mini', inputTokensUsed: 100, outputTokensUsed: 50 });

    const plan = cache.getPlan(task2);
    expect(plan).not.toBeNull();
  });

  it('tracks total tokens saved', () => {
    cache.storePlan({ taskDescription: 'task A', steps: STEPS, provider: 'openai', model: 'gpt-4o', inputTokensUsed: 1000, outputTokensUsed: 500 });
    cache.getPlan('task A'); // one hit

    expect(cache.totalTokensSaved()).toBe(1500);
  });

  it('invalidates a plan by task description', () => {
    const task = 'Run a database backup';
    cache.storePlan({ taskDescription: task, steps: STEPS, provider: 'openai', model: 'gpt-4o', inputTokensUsed: 200, outputTokensUsed: 80 });
    cache.invalidate(task);
    expect(cache.getPlan(task)).toBeNull();
  });
});
