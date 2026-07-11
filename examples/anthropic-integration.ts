/**
 * Anthropic / Claude integration example.
 */

import { LLMCostTrimmer, AnthropicProvider } from '@trimwares/trace';
import Anthropic from '@anthropic-ai/sdk';

async function main() {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const trimmer = new LLMCostTrimmer(new AnthropicProvider(anthropic), {
    defaultModel: 'claude-haiku-4-5',
    cache: {
      semantic: { similarityThreshold: 0.90 }, // slightly more aggressive for Claude
    },
  });

  const questions = [
    'Explain what a Large Language Model is in one sentence.',
    'In a single sentence, what is an LLM?',          // semantically similar — may hit cache
    'What is machine learning? Give a one-line answer.',
  ];

  for (const q of questions) {
    const res = await trimmer.chat({
      messages: [{ role: 'user', content: q }],
    });
    console.log(`Q: ${q}`);
    console.log(`A: ${res.content}`);
    console.log(`Cache: ${res.cacheType} | Cost: $${res.cost.toFixed(6)} | Savings: $${res.savings.toFixed(6)}\n`);
  }

  const report = trimmer.getCostReport();
  console.log('Hit rate:', `${report.cacheHitRate}%`);
  console.log('Saved:   ', `$${report.totalSavings.toFixed(6)}`);
}

main().catch(console.error);
