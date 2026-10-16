/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { trimwares } from '../../src/trimwares.js';
import { TrimwareEngine } from '../../src/engine/TrimwareEngine.js';

/**
 * The config flags that turn interception off must actually work.
 *
 * `cache.response.enabled` and `cache.semantic.enabled` were literals in both
 * engines' resolved config, so a caller's value was dropped on the floor:
 * response caching could not be disabled and semantic caching could not be
 * enabled. A developer adding Trace to an existing app to *measure* it got
 * silent response de-duplication with no way out, which is a behaviour change
 * to their app, not observation of it.
 *
 * These assert on how many times the provider was actually called, not on
 * cache internals — the internals were never the thing that was broken.
 *
 * Provider responses are mocked; no network, no key.
 */

function tempLogDir(): string {
  const d = `.trimwares-test-cacheflags-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(process.cwd(), d), { recursive: true });
  process.env.TRIMWARES_LOG_DIR = d;
  made.push(d);
  return d;
}
const made: string[] = [];
afterAll(() => { for (const d of made) { try { rmSync(join(process.cwd(), d), { recursive: true, force: true }); } catch { /* best effort */ } } });

const wait = (ms = 150) => new Promise(r => setTimeout(r, ms));

const SYSTEM = 'x'.repeat(20000);
const REQ = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'system' as const, content: SYSTEM }, { role: 'user' as const, content: 'identical question' }],
};

// Counts provider calls so the assertions are about reaching the provider,
// which is what a caller disabling the cache actually cares about.
function countingOpenAI() {
  const state = { calls: 0 };
  const client = {
    chat: {
      completions: {
        create: async () => {
          state.calls++;
          return {
            model: 'gpt-4o-mini',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 4902,
              completion_tokens: 30,
              total_tokens: 4932,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          };
        },
      },
    },
  };
  return { client, state };
}

function countingOpenAIStream() {
  const state = { calls: 0 };
  const client = {
    chat: {
      completions: {
        create: async () => {
          state.calls++;
          return {
            async *[Symbol.asyncIterator]() {
              yield { model: 'gpt-4o-mini', choices: [{ delta: { content: 'ok' } }] };
              yield {
                model: 'gpt-4o-mini',
                choices: [{ delta: {} }],
                usage: { prompt_tokens: 4902, completion_tokens: 30, total_tokens: 4932, prompt_tokens_details: { cached_tokens: 0 } },
              };
            },
          };
        },
      },
    },
  };
  return { client, state };
}

describe('cache.response.enabled', () => {
  it('on by default: two identical requests make one provider call', async () => {
    tempLogDir();
    const { client, state } = countingOpenAI();
    const traced = trimwares.openai(client as never) as any;
    await traced.chat.completions.create(REQ as never);
    await traced.chat.completions.create(REQ as never);
    await wait();
    expect(state.calls).toBe(1);
  });

  it('disabled: two identical requests both reach the provider', async () => {
    tempLogDir();
    const { client, state } = countingOpenAI();
    const traced = trimwares.openai(client as never, {
      cache: { response: { enabled: false } },
    }) as any;
    await traced.chat.completions.create(REQ as never);
    await traced.chat.completions.create(REQ as never);
    await wait();
    expect(state.calls).toBe(2);
  });

  it('disabled: the streaming path also reaches the provider every time', async () => {
    tempLogDir();
    const { client, state } = countingOpenAIStream();
    const traced = trimwares.openai(client as never, {
      cache: { response: { enabled: false } },
    }) as any;
    for (let i = 0; i < 2; i++) {
      const stream = await traced.chat.completions.create({ ...REQ, stream: true } as never);
      for await (const _ of stream as AsyncIterable<unknown>) { /* drain */ }
    }
    await wait();
    expect(state.calls).toBe(2);
  });

  it('disabled: nothing is WRITTEN to the cache — asserted on that same cache', async () => {
    // This used to make a second call through a NEW wrapper and assert the
    // provider was hit again. Every wrapper builds its own engine with its own
    // ResponseCache, so a fresh instance misses whether or not writes were
    // gated: the assertion could not fail. Inspect the entry count on the very
    // instance that did the work instead.
    tempLogDir();
    const engineOff = new TrimwareEngine('openai', { cache: { response: { enabled: false } } });
    const { state: offState } = await driveEngine(engineOff, 2);
    expect(offState.calls).toBe(2);                                 // no read served
    expect(engineOff.responseCache.stats().totalEntries).toBe(0);   // and no write made

    // CONTROL: the same drive with caching on must populate it, otherwise the
    // assertion above would hold for a cache that simply never works.
    const engineOn = new TrimwareEngine('openai', {});
    const { state: onState } = await driveEngine(engineOn, 2);
    expect(onState.calls).toBe(1);
    expect(engineOn.responseCache.stats().totalEntries).toBe(1);
  });
});

/** Drives `intercept` N times with one identical request, counting real calls. */
async function driveEngine(engine: TrimwareEngine, times: number) {
  const state = { calls: 0 };
  const request = {
    model: 'gpt-4o-mini',
    messages: [{ role: 'system' as const, content: SYSTEM }, { role: 'user' as const, content: 'identical question' }],
  };
  for (let i = 0; i < times; i++) {
    await engine.intercept(request as never, async () => {
      state.calls++;
      return {
        model: 'gpt-4o-mini',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4902, completion_tokens: 30, total_tokens: 4932, prompt_tokens_details: { cached_tokens: 0 } },
      } as never;
    }, false);
  }
  await wait();
  return { state };
}

describe('observe-only configuration', () => {
  it('documented config disables caching and sends every tool definition', async () => {
    // This is the exact config the README's observe-only block recommends.
    // If it ever stops meaning "change nothing", that doc is wrong.
    tempLogDir();
    const seen: unknown[][] = [];
    const client = {
      chat: {
        completions: {
          create: async (body: any) => {
            seen.push(body.tools ?? []);
            return {
              model: 'gpt-4o-mini',
              choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 4902, completion_tokens: 30, total_tokens: 4932, prompt_tokens_details: { cached_tokens: 0 } },
            };
          },
        },
      },
    };
    const tools = [
      { type: 'function', function: { name: 'alpha',   description: 'a', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'bravo',   description: 'b', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'charlie', description: 'c', parameters: { type: 'object', properties: {} } } },
    ];
    const traced = trimwares.openai(client as never, {
      cache: { response: { enabled: false } },
      optimization: { filterToolSchemas: false },
    }) as any;

    await traced.chat.completions.create({ ...REQ, tools } as never);
    await traced.chat.completions.create({ ...REQ, tools } as never);
    await wait();

    expect(seen).toHaveLength(2);                 // no request was de-duplicated
    expect(seen[0]).toHaveLength(tools.length);   // no tool was filtered out
    expect(seen[1]).toHaveLength(tools.length);
  });
});

// `config` is private, deliberately. These few assertions reach past that
// rather than widening the production API for a test's benefit.
type Layer = { enabled?: boolean };
const layers = (e: TrimwareEngine) =>
  (e as unknown as { config: { cache: { response: Layer; semantic: Layer; plan: Layer } } }).config.cache;

describe('resolved cache config', () => {
  it('semantic can be switched on, having been dropped before', () => {
    // Asserted on resolved config rather than on a similarity hit: the trigram
    // fallback's matching behaviour is its own suite's business. What was broken
    // here is that the caller's flag never arrived at all.
    expect(layers(new TrimwareEngine('openai', { cache: { semantic: { enabled: true } } })).semantic.enabled).toBe(true);
  });

  it('keeps the shipped defaults when nothing is passed', () => {
    const c = layers(new TrimwareEngine('openai', {}));
    expect(c.response.enabled).toBe(true);
    expect(c.semantic.enabled).toBe(false);
    expect(c.plan.enabled).toBe(true);
  });

  it('nativePromptCaching defaults on, and can be switched off', () => {
    expect(new TrimwareEngine('anthropic', {}).nativePromptCachingEnabled()).toBe(true);
    expect(new TrimwareEngine('anthropic', { optimization: { nativePromptCaching: false } })
      .nativePromptCachingEnabled()).toBe(false);
  });
});

describe('cache.plan.enabled means no reuse AND no storage', () => {
  // It used to gate only getPlan, so a "disabled" plan cache still grew and a
  // later enabled instance would serve plans captured while it was off.
  const plan = {
    taskDescription: 'summarise the quarterly report',
    steps: [{ tool: 'search', args: {} }] as never,
    inputTokensUsed: 100, outputTokensUsed: 50,
  };

  // The constructor is (provider, config) — passing a bare config object as
  // the single argument silently lands it in the `provider` slot and leaves
  // config as {}, so every flag reads as its default and a gating test passes
  // for the wrong reason. Caught exactly that way while writing this.
  const stubProvider = { name: 'openai', defaultModel: 'gpt-4o-mini' };
  const makeTrimmer = async (config: Record<string, unknown>) => {
    const { LLMCostTrimmer } = await import('../../src/index.js');
    return new LLMCostTrimmer(stubProvider as never, config as never) as any;
  };

  it('disabled: recordPlan stores nothing and getPlan returns null', async () => {
    const t = await makeTrimmer({ cache: { plan: { enabled: false } } });
    t.recordPlan(plan);
    expect(t.getPlan(plan.taskDescription)).toBeNull();
    expect(t.planCache.getPlan(plan.taskDescription)).toBeNull(); // nothing retained
  });

  it('CONTROL: enabled by default, recordPlan is retained and readable', async () => {
    const t = await makeTrimmer({});
    t.recordPlan(plan);
    expect(t.getPlan(plan.taskDescription)).not.toBeNull();
  });

  it('exposes the response flag through the public helper the proxies use', () => {
    expect(new TrimwareEngine('openai', {}).responseCacheEnabled()).toBe(true);
    expect(new TrimwareEngine('openai', { cache: { response: { enabled: false } } }).responseCacheEnabled()).toBe(false);
  });
});
