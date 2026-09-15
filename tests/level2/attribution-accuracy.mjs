/**
 * Level 2 — Attribution Accuracy Benchmark
 *
 * Compares our 4-chars/token approximation against tiktoken's real
 * cl100k_base BPE counts (the same encoding GPT-4/GPT-4o/GPT-4o-mini use).
 *
 * Answers the question: how far off are our attribution percentages in practice?
 */

import { get_encoding } from 'tiktoken';
import { TokenCounter } from '../../src/core/TokenCounter.js';

const enc = get_encoding('cl100k_base');
const counter = new TokenCounter('openai');

// ─── Real BPE counter ────────────────────────────────────────────────────────

function bpeCount(text) {
  if (!text) return 0;
  return enc.encode(text).length;
}

// ─── Test samples — realistic content from real apps ─────────────────────────

const SAMPLES = [
  {
    label: 'Short user message',
    category: 'user_query',
    text: 'What is the capital of France?',
  },
  {
    label: 'Medium user message',
    category: 'user_query',
    text: 'Can you explain the difference between supervised and unsupervised machine learning? I want to understand when to use each approach in practice.',
  },
  {
    label: 'Small system prompt',
    category: 'system_prompt',
    text: 'You are a helpful customer support agent for TechFlow. Be concise and professional. Always ask clarifying questions before providing solutions.',
  },
  {
    label: 'Medium system prompt (support bot)',
    category: 'system_prompt',
    text: `You are a customer support agent for TechFlow, an AI-powered project management platform.\n\nPRICING TIERS\nStarter: $29/month per workspace. Up to 10 users.\nPro: $99/month per workspace. Up to 50 users. Advanced analytics.\nBusiness: $299/month per workspace. Unlimited users. SSO, audit logs.\n\nBILLING\nAccepted: Visa, Mastercard, American Express, bank transfer, PayPal.\nBilling cycle: monthly or annual (annual = 2 months free).\nRefunds: 30-day money-back guarantee on first payment.\n\nCANCELLATION\nCancel anytime from Settings > Billing > Cancel Plan.\nNo cancellation fees. Data retained 90 days post-cancellation.\n\nSUPPORT\nChat (all plans), email (Pro+), phone (Business+).\nHours: Monday–Friday 9AM–6PM EST.`,
  },
  {
    label: 'Large system prompt (codebase)',
    category: 'system_prompt',
    text: `You are a coding assistant.\n\n=== src/OrderManager.ts ===\nexport class OrderManager {\n  private riskEngine: RiskEngine;\n  private broker: ExecutionBroker;\n  \n  async submitOrder(order: Order): Promise<{ orderId: string; status: OrderStatus }> {\n    const riskCheck = await this.riskEngine.validate(order);\n    if (!riskCheck.approved) throw new OrderRejectedError(riskCheck.reason);\n    const orderId = this.generateOrderId();\n    const executionResult = await this.broker.execute({ ...order, id: orderId });\n    return { orderId, status: executionResult.filled ? 'FILLED' : 'PARTIAL' };\n  }\n  \n  async cancelOrder(orderId: string): Promise<void> {\n    const order = this.pendingOrders.get(orderId);\n    if (!order) throw new Error('Order not found');\n    if (order.status === 'FILLED') throw new Error('Cannot cancel filled order');\n    await this.broker.cancel(orderId);\n  }\n}\n\n=== src/RiskEngine.ts ===\nexport class RiskEngine {\n  async validate(order: Order): Promise<RiskCheckResult> {\n    const checks = await Promise.all([\n      this.checkConcentrationLimit(order),\n      this.checkLiquidityRequirement(order),\n      this.checkProhibitedList(order),\n    ]);\n    const failed = checks.find(c => !c.passed);\n    return failed ? { approved: false, reason: failed.reason } : { approved: true };\n  }\n}`,
  },
  {
    label: 'Tool schema (single tool)',
    category: 'tool_schema',
    text: JSON.stringify({
      name: 'web_search',
      description: 'Search the web for current information. Returns a list of results with titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query. Be specific.' },
          num_results: { type: 'number', description: 'Results to return (1-10). Default 5.' },
          date_filter: { type: 'string', enum: ['any', 'past_week', 'past_month', 'past_year'] },
        },
        required: ['query'],
      },
    }),
  },
  {
    label: 'Tool schemas (5 tools — agent)',
    category: 'tool_schema',
    text: JSON.stringify([
      { name: 'web_search',       description: 'Search the web for current information',               parameters: { type: 'object', properties: { query: { type: 'string' }, num_results: { type: 'number' } }, required: ['query'] } },
      { name: 'browse_url',       description: 'Fetch and extract text content from a specific URL',    parameters: { type: 'object', properties: { url: { type: 'string' }, extract: { type: 'array', items: { type: 'string' } } }, required: ['url'] } },
      { name: 'analyze_data',     description: 'Perform structured analysis on gathered data',          parameters: { type: 'object', properties: { data: { type: 'string' }, analysis_type: { type: 'string', enum: ['summary', 'comparison', 'trend'] } }, required: ['data'] } },
      { name: 'save_finding',     description: 'Save an important finding to research notes',           parameters: { type: 'object', properties: { category: { type: 'string' }, finding: { type: 'string' }, confidence: { type: 'string', enum: ['confirmed', 'likely', 'uncertain'] } }, required: ['category', 'finding'] } },
      { name: 'compile_report',   description: 'Compile all findings into a structured report',         parameters: { type: 'object', properties: { target: { type: 'string' }, report_type: { type: 'string', enum: ['quick', 'standard', 'comprehensive'] } }, required: ['target', 'report_type'] } },
    ]),
  },
  {
    label: 'RAG chunk (policy document)',
    category: 'rag_chunk',
    text: `<document id="investment-policy-v3">\nRISK MANAGEMENT FRAMEWORK\nAll portfolio positions must comply with the following concentration limits:\n- Single equity: maximum 8% of total AUM at time of purchase\n- Single sector: maximum 25% of total AUM\n- Single geography (ex-US): maximum 30% of total AUM\n- Emerging markets combined: maximum 15% of total AUM\n\nLIQUIDITY REQUIREMENTS\nMinimum 30% of total AUM must be held in instruments liquidatable within T+2.\nCash and cash equivalents must not exceed 15% except during documented market dislocations.\n\nPROHIBITED INVESTMENTS\nDirect real estate ownership, commodities futures (except hedging), cryptocurrency (all forms).\n</document>`,
  },
  {
    label: 'Conversation history (5 turns)',
    category: 'conversation_history',
    text: [
      'User: How do I cancel my subscription?',
      'Assistant: You can cancel anytime from Settings > Billing > Cancel Plan. No fees apply.',
      'User: Will I lose my data immediately?',
      'Assistant: No — your data is retained for 90 days after cancellation so you can export it.',
      'User: What formats can I export in?',
      'Assistant: You can export as JSON or CSV from Settings > Data > Export.',
    ].join('\n'),
  },
  {
    label: 'Mixed multilingual content',
    category: 'user_query',
    text: 'What does "schadenfreude" mean? Also, how do you say "thank you" in Japanese (arigatou) and Arabic (shukran)?',
  },
  {
    label: 'Code block (TypeScript)',
    category: 'user_query',
    text: 'Fix this TypeScript function:\n```typescript\nasync function fetchUser(id: string): Promise<User> {\n  const res = await fetch(`/api/users/${id}`);\n  const data = res.json();\n  return data as User;\n}\n```\nThe problem is that `res.json()` is a Promise and I\'m not awaiting it.',
  },
];

// ─── Run benchmark ────────────────────────────────────────────────────────────

console.log('\n  Trimwares — Level 2: Attribution Accuracy Benchmark');
console.log('  Tokenizer: tiktoken cl100k_base (GPT-4/GPT-4o encoding)');
console.log('  ─────────────────────────────────────────────────────────────────────\n');

const results = [];
const byCategory = {};

for (const sample of SAMPLES) {
  const bpe      = bpeCount(sample.text);
  const approx   = counter.countText(sample.text);
  const delta    = approx - bpe;
  const deltaP   = bpe > 0 ? ((delta / bpe) * 100).toFixed(1) : '0';
  const absDeltaP = Math.abs(parseFloat(deltaP));

  const status = absDeltaP <= 5   ? '✓ excellent'
               : absDeltaP <= 10  ? '~ good'
               : absDeltaP <= 20  ? '! acceptable'
               :                    '✗ poor';

  results.push({ label: sample.label, category: sample.category, bpe, approx, delta, deltaP, absDeltaP, status });

  if (!byCategory[sample.category]) byCategory[sample.category] = { totalBpe: 0, totalApprox: 0, count: 0 };
  byCategory[sample.category].totalBpe   += bpe;
  byCategory[sample.category].totalApprox += approx;
  byCategory[sample.category].count++;
}

// Print per-sample results
const col = (s, w) => String(s).padEnd(w);
console.log(`  ${col('Sample', 42)} ${col('Real (BPE)', 11)} ${col('Ours', 7)} ${col('Delta', 8)} Status`);
console.log('  ' + '─'.repeat(82));
for (const r of results) {
  const sign = r.delta >= 0 ? '+' : '';
  console.log(`  ${col(r.label, 42)} ${col(r.bpe, 11)} ${col(r.approx, 7)} ${sign}${col(r.deltaP + '%', 8)} ${r.status}`);
}

// Print per-category summary
console.log('\n  ─────────────────────────────────────────────────────────────────────');
console.log('  Category averages\n');
for (const [cat, data] of Object.entries(byCategory)) {
  const catDelta = ((data.totalApprox - data.totalBpe) / data.totalBpe * 100).toFixed(1);
  const sign = parseFloat(catDelta) >= 0 ? '+' : '';
  console.log(`  ${cat.padEnd(26)} avg delta: ${sign}${catDelta}%   (${data.count} samples)`);
}

// Overall
const totalBpe   = results.reduce((s, r) => s + r.bpe,   0);
const totalApprox = results.reduce((s, r) => s + r.approx, 0);
const overallDelta = ((totalApprox - totalBpe) / totalBpe * 100).toFixed(1);
console.log(`\n  ${'OVERALL'.padEnd(26)} avg delta: +${overallDelta}%`);

const poor = results.filter(r => r.absDeltaP > 20);
if (poor.length > 0) {
  console.log(`\n  ⚠  ${poor.length} sample(s) exceeded 20% accuracy threshold:`);
  poor.forEach(r => console.log(`     - ${r.label}: ${r.deltaP}%`));
} else {
  console.log('\n  ✓  All samples within 20% accuracy threshold');
}

console.log('\n  Verdict:');
const avg = Math.abs(parseFloat(overallDelta));
if (avg <= 5)  console.log('  Attribution accuracy is excellent (< 5% average error). Ready to ship as-is.');
else if (avg <= 10) console.log('  Attribution accuracy is good (< 10% average error). Directionally correct for all use cases.');
else if (avg <= 20) console.log('  Attribution accuracy is acceptable (< 20% error). Consider improving tokenizer for v0.2.');
else           console.log('  Attribution accuracy needs improvement. Tokenizer replacement recommended before v0.1 ship.');

enc.free();
console.log('');
