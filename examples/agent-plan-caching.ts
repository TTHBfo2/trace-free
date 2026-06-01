/**
 * Agentic Plan Caching example — the novel layer.
 *
 * Shows how to cache an agent's execution plan (the sequence of tool calls
 * it derives) so that similar tasks skip the planning phase entirely.
 *
 * This is NOT prompt caching or response caching.
 * It caches the *reasoning structure* — the plan itself.
 */

import { LLMCostTrimmer, OpenAIProvider, AgentStep } from '@tthbfo2/llm-cost-trimmer';
import OpenAI from 'openai';

const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web for current information',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'summarize',
    description: 'Summarize a piece of text',
    parameters: { type: 'object', properties: { text: { type: 'string' }, maxWords: { type: 'number' } } },
  },
];

async function runAgentTask(trimmer: LLMCostTrimmer, taskDescription: string) {
  console.log(`\nTask: ${taskDescription}`);

  // Check if we have a cached plan for this task type
  const cachedPlan = trimmer.getPlan(taskDescription);
  if (cachedPlan) {
    console.log(`[PLAN CACHE HIT] Skipping planning phase. Using ${cachedPlan.steps.length}-step cached plan.`);
    console.log('Cached steps:', cachedPlan.steps.map(s => s.toolName).join(' → '));
    console.log(`Est. tokens saved: ${cachedPlan.estimatedTokensSaved * cachedPlan.hitCount}`);
    return cachedPlan;
  }

  console.log('[PLAN CACHE MISS] Asking model to derive execution plan...');

  // Ask the model to plan the task
  const response = await trimmer.chat({
    messages: [
      {
        role: 'system',
        content: 'You are an AI agent. When given a task, respond with the tool calls needed to complete it.',
      },
      { role: 'user', content: taskDescription },
    ],
    tools: TOOLS,
    model: 'gpt-4o-mini',
  });

  // If the model returned tool calls, store the plan for future reuse
  if (response.toolCalls && response.toolCalls.length > 0) {
    const steps: AgentStep[] = response.toolCalls.map((tc, i) => ({
      stepIndex: i,
      toolName: tc.name,
      toolArgs: tc.arguments,
      reasoning: i === 0 ? response.content : undefined,
    }));

    const plan = trimmer.recordPlan({
      taskDescription,
      steps,
      inputTokensUsed: response.usage.inputTokens,
      outputTokensUsed: response.usage.outputTokens,
      model: response.model,
    });

    console.log(`[PLAN STORED] ${steps.length} steps cached for future similar tasks.`);
    return plan;
  }

  console.log('No tool calls returned — task may not require agentic planning.');
  return null;
}

async function main() {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const trimmer = new LLMCostTrimmer(new OpenAIProvider(openai));

  // First run: derives and caches the plan
  await runAgentTask(trimmer, 'Search for today\'s top AI news and summarize the key points in under 100 words');

  // Second run with similar task: should hit the plan cache
  await runAgentTask(trimmer, 'Find today\'s AI news headlines and summarize them briefly');

  // Third run: exact same task
  await runAgentTask(trimmer, 'Search for today\'s top AI news and summarize the key points in under 100 words');

  const planStats = trimmer['planCache'].stats();
  console.log('\n--- Plan Cache Stats ---');
  console.log('Entries:', planStats.totalEntries);
  console.log('Hits:   ', planStats.hitCount);
  console.log('Misses: ', planStats.missCount);
  console.log('Hit rate:', `${planStats.hitRate}%`);

  const cost = trimmer.getCostReport();
  console.log('\n--- Cost Report ---');
  console.log('Total cost:    ', `$${cost.totalCost.toFixed(6)}`);
  console.log('Total savings: ', `$${cost.totalSavings.toFixed(6)}`);
}

main().catch(console.error);
