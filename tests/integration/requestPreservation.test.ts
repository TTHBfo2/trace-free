/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { trimwares } from '../../src/trimwares.js';
import { CostEngine } from '../../src/core/CostEngine.js';

/**
 * What we send to the provider must be what the caller gave us.
 *
 * The denormalizers used to REBUILD tool definitions from our internal
 * `{name, description, parameters}` shape, so every field we do not model was
 * dropped on the way out: OpenAI's `strict: true` (which changes how the model
 * is constrained) and Anthropic's own `cache_control` markers. Separately, the
 * Anthropic path always injected our cache_control blocks into `system`.
 *
 * The previous test asserted only `toHaveLength` on the tools array — it
 * counted them and never looked inside, so it passed throughout. These assert
 * deep equality on the exact body the provider received.
 */

const made: string[] = [];
function tempLogDir(): void {
  const d = `.trimwares-test-preserve-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(process.cwd(), d), { recursive: true });
  process.env.TRIMWARES_LOG_DIR = d;
  made.push(d);
}
afterAll(() => { for (const d of made) { try { rmSync(join(process.cwd(), d), { recursive: true, force: true }); } catch { /* best effort */ } } });

const wait = (ms = 150) => new Promise(r => setTimeout(r, ms));
const SYSTEM = 'You are a careful assistant. ' + 'x'.repeat(20000);

// Anthropic's cache_control is only injected once the prefix clears the
// provider's minimum: 1024 tokens, but 4096 for Claude Haiku 4.5. The
// Anthropic cases below therefore use Sonnet with a prompt well clear of the
// 1024 line — on Haiku with a smaller prompt, nothing would be injected even
// with the feature ON, so "observe-only suppressed it" would prove nothing.
// That is precisely the trap of asserting an absence that was never present.
const CACHEABLE_MODEL = 'claude-sonnet-4-6';
const BIG_SYSTEM = 'You are a careful assistant. ' + 'lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(1200);

const OBSERVE_ONLY = {
  cache: { response: { enabled: false } },
  optimization: { filterToolSchemas: false, nativePromptCaching: false },
} as const;

function captureOpenAI() {
  const bodies: any[] = [];
  const client = {
    chat: { completions: { create: async (body: any) => {
      bodies.push(structuredClone(body));
      return {
        model: 'gpt-4o-mini',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4902, completion_tokens: 30, total_tokens: 4932, prompt_tokens_details: { cached_tokens: 0 } },
      };
    } } },
  };
  return { client, bodies };
}

function captureAnthropic() {
  const bodies: any[] = [];
  const client = {
    messages: { create: async (body: any) => {
      bodies.push(structuredClone(body));
      return {
        model: 'claude-haiku-4-5', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 4902, output_tokens: 30 },
      };
    } },
  };
  return { client, bodies };
}

describe('OpenAI tool definitions reach the provider unchanged', () => {
  // `strict` is the field that made this a correctness bug rather than a
  // cosmetic one: dropping it silently relaxes structured-output enforcement.
  const tools = [
    { type: 'function', function: { name: 'alpha', description: 'a', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false }, strict: true } },
    { type: 'function', function: { name: 'bravo', description: 'b', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'charlie', description: 'c', parameters: { type: 'object', properties: {} } }, extra_vendor_field: 'keep me' },
  ];

  it('observe-only: every tool is byte-identical to what was passed in', async () => {
    tempLogDir();
    const { client, bodies } = captureOpenAI();
    const traced = trimwares.openai(client as never, OBSERVE_ONLY) as any;
    await traced.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'hello' }],
      tools,
    } as never);
    await wait();

    expect(bodies).toHaveLength(1);
    expect(bodies[0].tools).toEqual(tools);
  });

  it('strict survives even with tool filtering ENABLED', async () => {
    // Filtering picks a subset; the objects it keeps must still be the
    // caller's own, not reconstructions missing their fields.
    tempLogDir();
    const { client, bodies } = captureOpenAI();
    const traced = trimwares.openai(client as never, {
      cache: { response: { enabled: false } },
      optimization: { filterToolSchemas: true },
    }) as any;
    await traced.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'use alpha please' }],
      tools,
    } as never);
    await wait();

    const sent = bodies[0].tools as any[];
    expect(sent.length).toBeGreaterThan(0);
    // Whatever subset survived, each member must be one of the originals
    // exactly — no field added, none removed.
    for (const t of sent) {
      const match = tools.find(o => o.function.name === t.function.name);
      expect(t).toEqual(match);
    }
  });
});

describe('Anthropic requests are not rewritten in observe-only mode', () => {
  const tools = [
    { name: 'alpha', description: 'a', input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral' } },
    { name: 'bravo', description: 'b', input_schema: { type: 'object', properties: {} } },
  ];

  async function send(config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    tempLogDir();
    const { client, bodies } = captureAnthropic();
    const traced = trimwares.anthropic(client as never, config as never) as any;
    await traced.messages.create({
      model: CACHEABLE_MODEL, max_tokens: 100,
      system: BIG_SYSTEM,
      messages: [{ role: 'user', content: 'hello' }],
      ...extra,
    } as never);
    await wait();
    return bodies;
  }

  it('CONTROL: by default this request does get cache_control injected', async () => {
    // Establishes that the two assertions below are observing a real
    // suppression rather than an absence that was never going to be there.
    const bodies = await send({ cache: { response: { enabled: false } } });
    expect(JSON.stringify(bodies[0].system)).toContain('cache_control');
  });

  it("keeps the caller's own cache_control on tools", async () => {
    const bodies = await send(OBSERVE_ONLY, { tools });
    expect(bodies[0].tools).toEqual(tools);
  });

  it('leaves a string system prompt as a string, with nothing injected', async () => {
    const bodies = await send(OBSERVE_ONLY);
    expect(bodies[0].system).toBe(BIG_SYSTEM);
    expect(JSON.stringify(bodies[0])).not.toContain('cache_control');
  });
});

describe('Groq GPT-OSS pricing', () => {
  // Groq reports these ids prefixed, e.g. `openai/gpt-oss-20b`. Rates verified
  // against console.groq.com/docs/model/<id> on 2026-10-14.
  const engine = () => new CostEngine({}, 'groq');

  it.each([
    ['openai/gpt-oss-20b',            0.075, 0.037, 0.30],
    ['openai/gpt-oss-120b',           0.15,  0.075, 0.60],
    ['openai/gpt-oss-safeguard-20b',  0.075, 0.037, 0.30],
  ])('%s resolves to its real published rate', (model, input, cached, output) => {
    const p = engine().getPricing(model as string);
    expect(p.inputPerMillion).toBe(input);
    expect(p.cachedInputPerMillion).toBe(cached);
    expect(p.outputPerMillion).toBe(output);
    expect(p.estimated).toBeUndefined();
  });

  it('does not fall back to GPT-4o rates, which overstated spend 33x', () => {
    const p = engine().getPricing('openai/gpt-oss-20b');
    expect(p.inputPerMillion).not.toBe(2.50);
    expect(p.outputPerMillion).not.toBe(10.00);
  });

  it('carries a cached rate, because Groq does have a prompt cache', () => {
    // An earlier changelog of ours asserted Groq had none. It caches
    // automatically on the GPT-OSS family at 50% off cached input.
    expect(engine().getPricing('openai/gpt-oss-20b').cachedInputPerMillion).toBeLessThan(
      engine().getPricing('openai/gpt-oss-20b').inputPerMillion,
    );
  });
});

describe('unknown models are flagged, not quietly priced as GPT-4o', () => {
  it('marks the fallback and records the model name', () => {
    const e = new CostEngine({}, 'groq');
    const p = e.getPricing('some-model-nobody-has-priced-v9');
    expect(p.estimated).toBe(true);
    expect(e.getUnpricedModels()).toContain('some-model-nobody-has-priced-v9');
  });

  it('leaves known models unflagged and the list empty', () => {
    const e = new CostEngine({}, 'openai');
    expect(e.getPricing('gpt-4o-mini').estimated).toBeUndefined();
    expect(e.getUnpricedModels()).toEqual([]);
  });
});
