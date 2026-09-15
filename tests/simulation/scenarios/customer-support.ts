import { ScenarioDefinition } from '../runner.js';

// Real-world scenario: SaaS customer support bot.
// Pain: same 800-token product knowledge base sent on every single request.
// Mix: 35% exact repeats, 40% near-identical phrasing, 25% unique.
// This is where provider-native caching and response caching deliver the most.

const SYSTEM_PROMPT = `You are a customer support agent for TechFlow, an AI-powered project management platform.

PRODUCT OVERVIEW
TechFlow helps engineering and product teams track work, collaborate, and ship faster.
Core features: Kanban boards, sprint planning, roadmaps, time tracking, GitHub/Jira sync.

PRICING TIERS
Starter: $29/month per workspace. Up to 10 users. Core features. 5GB storage.
Pro: $99/month per workspace. Up to 50 users. Advanced analytics, custom workflows, 50GB storage, priority support.
Business: $299/month per workspace. Unlimited users. SSO, audit logs, custom roles, 500GB storage, SLA.
Enterprise: Custom pricing. Dedicated infrastructure, compliance packages, professional onboarding.
All plans: 14-day free trial, no credit card required.

BILLING AND PAYMENTS
Accepted: Visa, Mastercard, American Express, bank transfer (Business+), PayPal.
Billing cycle: monthly or annual (annual = 2 months free).
Invoices: auto-emailed on billing date, available in Settings > Billing.
Upgrades: prorated immediately. Downgrades: effective next cycle.
Refunds: 30-day money-back guarantee on first payment. No refunds after 30 days.

CANCELLATION POLICY
Cancel anytime from Settings > Billing > Cancel Plan.
No cancellation fees or penalties.
Data retained for 90 days post-cancellation for export.
Annual plan cancellations: refund for unused full months only.

ACCOUNT MANAGEMENT
Password reset: Login page > Forgot Password.
Two-factor authentication: Settings > Security > Enable 2FA.
Team invites: Settings > Team > Invite Members (email or link).
Removing members: Settings > Team > click member > Remove.
Workspace transfer: contact support — cannot be done self-serve.
Data export: Settings > Data > Export (JSON or CSV, includes all projects and tasks).

INTEGRATIONS
GitHub: two-way sync of issues and pull requests.
Jira: one-way import. Full sync requires Business plan.
Slack: notifications for task updates, mentions, deadlines.
Zapier: connect to 5,000+ apps. Available on Pro+.
Webhooks: available on Business+.

TECHNICAL / SECURITY
Data hosting: AWS us-east-1 (default). EU region available on Business+.
Encryption: AES-256 at rest, TLS 1.3 in transit.
SOC 2 Type II certified. GDPR compliant. HIPAA available on Enterprise.
Uptime SLA: 99.9% (Business), 99.99% (Enterprise).
Support: chat (all plans), email (Pro+), phone (Business+), dedicated CSM (Enterprise).
Support hours: Monday–Friday 9AM–6PM EST. Emergency line: 24/7 for Business+.`;

// Exact repeat questions — tests response cache
const EXACT_REPEATS = [
  'How do I cancel my subscription?',
  'What payment methods do you accept?',
  'How much does the Pro plan cost?',
  'How do I add team members to my workspace?',
  'Do you offer a free trial?',
];

// Near-identical phrasing — tests semantic cache
const NEAR_IDENTICAL_PAIRS: [string, string][] = [
  ['How do I cancel my account?',        'Steps to cancel my TechFlow subscription'],
  ['What cards do you accept?',           'Which payment methods are supported?'],
  ['How can I invite my team?',           'How do I add users to my workspace?'],
  ['Is there a free plan?',               'Do you have a free tier?'],
  ['How do I reset my password?',         'I forgot my password, how do I get back in?'],
  ['Can I export my data?',               'How do I download all my project data?'],
  ['Do you have GitHub integration?',     'Can TechFlow sync with GitHub?'],
  ['What is the Enterprise plan?',        'Tell me about enterprise pricing'],
];

// Unique questions — no cache hit expected
const UNIQUE_QUESTIONS = [
  'Our GitHub integration stopped syncing yesterday. What should I check first?',
  'We need HIPAA compliance for our healthcare client — is that available?',
  'We have 87 users and need to stay under $500/month. What plan fits?',
  'Can I transfer workspace ownership to a colleague who is taking over the account?',
  'We got a SOC 2 audit request — can you send us your compliance documentation?',
];

function makeConvo(id: string, userMessage: string, label?: string) {
  return {
    id,
    label,
    turns: [[
      { role: 'system' as const,  content: SYSTEM_PROMPT },
      { role: 'user'   as const,  content: userMessage },
    ]],
  };
}

export const customerSupportScenario: ScenarioDefinition = {
  name:        'Customer Support Bot',
  description: '100 requests — 35% exact repeats, 40% near-identical, 25% unique. 800-token system prompt on every call.',
  provider:    'openai',
  model:       'gpt-4o-mini',
  outputVariance: 0.15, // support answers are concise

  conversations: [
    // Round 1: first time each exact repeat question is asked
    ...EXACT_REPEATS.map((q, i) => makeConvo(`exact-first-${i}`, q, 'first-ask')),
    // Round 2: exact same questions again (should all hit response cache)
    ...EXACT_REPEATS.map((q, i) => makeConvo(`exact-repeat-${i}`, q, 'cache-hit')),
    // Round 3: third time (still cache hits)
    ...EXACT_REPEATS.map((q, i) => makeConvo(`exact-third-${i}`, q, 'cache-hit')),
    // Near-identical pairs — first question then paraphrase
    ...NEAR_IDENTICAL_PAIRS.flatMap(([q1, q2], i) => [
      makeConvo(`near-a-${i}`, q1, 'near-first'),
      makeConvo(`near-b-${i}`, q2, 'near-paraphrase'),
    ]),
    // Unique questions
    ...UNIQUE_QUESTIONS.map((q, i) => makeConvo(`unique-${i}`, q, 'unique')),
  ],
};
