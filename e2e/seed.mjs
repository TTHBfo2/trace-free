// Writes synthetic-but-schema-valid session entries into <dir>/.trimwares/
// session.jsonl so the dashboard has something to render. No provider calls.
// Used by e2e/serve.mjs; can also be run by hand: node e2e/seed.mjs <dir> [n]
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export function seed(dir, n = 40) {
  mkdirSync(join(dir, '.trimwares'), { recursive: true });
  const models = [
    { model: 'gpt-4o',            provider: 'openai',    inRate: 2.5,  outRate: 10   },
    { model: 'claude-sonnet-4-5', provider: 'anthropic', inRate: 3.0,  outRate: 15   },
    { model: 'gpt-4o-mini',       provider: 'openai',    inRate: 0.15, outRate: 0.6  },
  ];
  const lines = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const m = models[i % models.length];
    const sys = 900 + (i % 5) * 40, tools = i % 2 ? 600 : 0, q = 40 + (i % 7) * 10, out = 120 + (i % 4) * 30;
    const inTok = sys + tools + q, total = inTok + out;
    const cached = i % 4 === 0;
    const cost = inTok / 1e6 * m.inRate + out / 1e6 * m.outRate;
    const cat = (t, rate) => ({ tokens: t, estimatedCost: t / 1e6 * rate, percentOfTotal: +(t / total * 100).toFixed(1) });
    lines.push(JSON.stringify({
      timestamp: now - (n - i) * 60_000, requestId: `e2e_${i}`, provider: m.provider, model: m.model,
      attribution: { systemPrompt: cat(sys, m.inRate), toolSchemas: cat(tools, m.inRate), ragChunks: cat(0, m.inRate),
        conversationHistory: cat(0, m.inRate), userQuery: cat(q, m.inRate), outputTokens: cat(out, m.outRate),
        totalInputTokens: inTok, totalOutputTokens: out, totalCost: cost },
      cached, cacheType: cached ? 'response' : 'none', latencyMs: cached ? 12 : 600, nativeCache: false,
      realInputTokens: inTok, realOutputTokens: out, nativeCachedTokens: 0,
      realCost: cached ? 0 : cost, realSavings: cached ? cost : 0, labels: { project: 'e2e-app' },
    }));
  }
  writeFileSync(join(dir, '.trimwares', 'session.jsonl'), lines.join('\n') + '\n');
  return lines.length;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const n = seed(process.argv[2] ?? process.cwd(), Number(process.argv[3] ?? 40));
  console.log(`seeded ${n} entries`);
}
