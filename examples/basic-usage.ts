/**
 * Basic usage example — works with any provider.
 * This shows the full API surface in one file.
 */

import { LLMCostTrimmer, OpenAIProvider } from '@tthbfo2/llm-cost-trimmer';
import OpenAI from 'openai';

async function main() {
  // 1. Wrap your existing client — zero config changes to the rest of your app
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const trimmer = new LLMCostTrimmer(new OpenAIProvider(openai));

  // 2. Use exactly like you would normally
  const response = await trimmer.chat({
    messages: [
      { role: 'system', content: 'You are a concise assistant.' },
      { role: 'user',   content: 'What is the capital of France?' },
    ],
    model: 'gpt-4o-mini',
  });

  console.log('Response:', response.content);
  console.log('Cost:    ', `$${response.cost.toFixed(6)}`);
  console.log('Cached:  ', response.cached);

  // 3. Second identical request — served from ResponseCache for free
  const cached = await trimmer.chat({
    messages: [
      { role: 'system', content: 'You are a concise assistant.' },
      { role: 'user',   content: 'What is the capital of France?' },
    ],
    model: 'gpt-4o-mini',
  });

  console.log('\nCached response:', cached.content);
  console.log('Cache type:     ', cached.cacheType); // 'response'
  console.log('Savings:        ', `$${cached.savings.toFixed(6)}`);

  // 4. Cost report — see exactly where your money went
  const report = trimmer.getCostReport();
  console.log('\n--- Cost Report ---');
  console.log('Total cost:    ', `$${report.totalCost.toFixed(6)}`);
  console.log('Total savings: ', `$${report.totalSavings.toFixed(6)}`);
  console.log('Savings %:     ', `${report.savingsPercent}%`);
  console.log('Cache hit rate:', `${report.cacheHitRate}%`);

  // 5. Waste report — find what's burning money and why
  const waste = trimmer.getWasteReport();
  console.log('\n--- Waste Report ---');
  console.log('Total waste est.:', `$${waste.totalWaste.toFixed(6)}`);
  if (waste.recommendations.length > 0) {
    console.log('Recommendations:');
    waste.recommendations.forEach(r => console.log(' •', r));
  }
}

main().catch(console.error);
