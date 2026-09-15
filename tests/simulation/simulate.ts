/**
 * Run all simulations: npx ts-node tests/simulation/simulate.ts
 * Or after build:      node tests/simulation/simulate.js
 *
 * Produces real attribution data from realistic workloads.
 * No API keys needed — uses RealisticMockProvider.
 */

import { runAllScenarios } from './runner.js';
import { customerSupportScenario }  from './scenarios/customer-support.js';
import { ragAppScenario }           from './scenarios/rag-app.js';
import { agentWorkflowScenario }    from './scenarios/agent-workflow.js';
import { codingAssistantScenario }  from './scenarios/coding-assistant.js';

runAllScenarios(
  [
    customerSupportScenario,
    ragAppScenario,
    agentWorkflowScenario,
    codingAssistantScenario,
  ],
  'simulation-results'
).then(results => {
  // Exit non-zero if any scenario produced zero savings (smoke test)
  const allZero = results.every(r => r.totalSavingsUsd === 0 && r.cacheHitRate === 0);
  if (allZero) {
    console.error('ERROR: No savings detected in any scenario. Check trimmer configuration.');
    process.exit(1);
  }
  process.exit(0);
}).catch(err => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
