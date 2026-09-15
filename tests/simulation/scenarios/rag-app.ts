import { ScenarioDefinition } from '../runner.js';

// Real-world scenario: RAG-powered internal knowledge base.
// Pain: each request sends 4-6 large retrieved document chunks (avg 400 tokens each).
// User query is 20-50 tokens. Payload is 80x inflated by RAG content.
// Provider-native caching on stable document chunks is the key saving.

const SYSTEM_PROMPT = `You are an internal knowledge assistant for Meridian Capital, a mid-size investment firm.
Answer questions using only the provided document context. Be precise and cite sources when possible.
If the answer is not in the provided context, say so clearly. Do not speculate.`;

// Realistic document chunks (as would be retrieved from a vector DB)
const DOC_CHUNKS = {
  investmentPolicy: `<document id="investment-policy-v3" section="risk-management">
MERIDIAN CAPITAL — INVESTMENT POLICY STATEMENT v3.2 (Effective January 2025)

RISK MANAGEMENT FRAMEWORK
All portfolio positions must comply with the following concentration limits:
- Single equity: maximum 8% of total AUM at time of purchase
- Single sector: maximum 25% of total AUM
- Single geography (ex-US): maximum 30% of total AUM
- Emerging markets combined: maximum 15% of total AUM
- Alternative investments (PE, hedge, real assets): maximum 20% combined

LIQUIDITY REQUIREMENTS
Minimum 30% of total AUM must be held in instruments liquidatable within T+2.
Cash and cash equivalents must not exceed 15% except during documented market dislocations.
Illiquid investments (lockup > 12 months) capped at 12% of total AUM.

LEVERAGE POLICY
No leverage permitted in equity accounts.
Fixed income accounts: maximum 1.2x leverage on investment-grade positions only.
Derivatives: permitted for hedging only — no speculative derivative positions.

PROHIBITED INVESTMENTS
Direct real estate ownership, commodities futures (except for hedging),
cryptocurrency (all forms), companies with sanctions exposure (OFAC list),
investments in direct competitors as defined in Schedule A.

APPROVAL REQUIREMENTS
Positions > $5M: Investment Committee approval required within 48 hours of trade.
New asset class: Board approval required before initial allocation.
ESG screening: all new positions must pass Meridian ESG scorecard (minimum 65/100).
</document>`,

  complianceGuide: `<document id="compliance-manual-2025" section="reporting">
MERIDIAN CAPITAL — COMPLIANCE MANUAL 2025 EDITION

REGULATORY REPORTING OBLIGATIONS
Form ADV: Filed annually with SEC by March 31. Updated promptly on material changes.
Form PF: Quarterly filing within 60 days of quarter end (applies as registered investment adviser).
13F Holdings Report: Filed within 45 days of each quarter end for positions > $100M aggregate.
Blue Sky filings: Maintained in all states where clients are domiciled.

TRADE SURVEILLANCE
All personal trading by employees requires pre-clearance via ComplianceEdge portal.
Blackout periods: 5 trading days before and after earnings releases for covered companies.
Gifts and entertainment: Must be logged. Limit $250/person/year from any single source.
Political contributions: Subject to pay-to-play rules — approval required before any contribution.

CLIENT COMMUNICATION STANDARDS
All client-facing materials must be reviewed by Compliance before distribution.
Performance presentations must comply with GIPS standards.
Social media: personal accounts discussing firm business require prior approval.
Email retention: all business emails retained for 7 years per SEC Rule 17a-4.

INCIDENT REPORTING
Potential regulatory violations: report to Chief Compliance Officer within 24 hours.
Data breach: immediate notification to IT Security and CCO; client notification per state laws.
Regulatory inquiry: forward immediately to Legal — do not respond directly.
</document>`,

  hrPolicy: `<document id="hr-handbook-2025" section="benefits-pto">
MERIDIAN CAPITAL — EMPLOYEE HANDBOOK 2025

PAID TIME OFF
Employees (Years 0-2): 15 days PTO + 10 company holidays + 5 sick days = 30 days total
Employees (Years 3-5): 20 days PTO + 10 company holidays + 5 sick days = 35 days total
Employees (6+ years): 25 days PTO + 10 company holidays + 5 sick days = 40 days total
PTO rollover: Maximum 10 days carry into next calendar year. Excess forfeited December 31.
PTO payout: Accrued unused PTO paid out at termination at current daily rate.

PARENTAL LEAVE
Primary caregiver: 16 weeks fully paid.
Secondary caregiver: 6 weeks fully paid.
Adoption: same as birth. Surrogacy: primary caregiver policy applies.
Benefits (health, retirement) continue throughout leave.

RETIREMENT BENEFITS
401(k): Company matches 100% of first 4% of salary, 50% of next 2% (max 5% company match).
Vesting: 3-year cliff vesting on company match.
Profit sharing: discretionary annual contribution, typically 3-7% of salary.
Financial planning: two complimentary sessions per year with Meridian's financial adviser.

HEALTH INSURANCE
Medical: Blue Shield PPO (company pays 80%, employee 20%) or Kaiser HMO (company pays 90%).
Dental: Delta Dental. Company pays 75%.
Vision: VSP. Company pays 100%.
HSA contribution: $750/year for employee-only; $1,500 for family coverage.
Life insurance: 2x annual salary, company-paid. Supplemental available.
</document>`,

  techStack: `<document id="tech-architecture-2025" section="core-systems">
MERIDIAN CAPITAL — TECHNOLOGY ARCHITECTURE OVERVIEW 2025

CORE TRADING SYSTEMS
Order Management: FlexTrade OMS — primary system for all equity and fixed income orders.
Execution: Direct market access via Bloomberg EMSX and ITG POSIT (dark pool).
Risk: Axioma Portfolio Analytics — real-time pre-trade and post-trade risk.
Portfolio Accounting: Geneva by Advent — books and records, NAV calculation.
Data: Bloomberg Terminal (primary), Refinitiv Eikon (secondary), FactSet (research).

INFRASTRUCTURE
Cloud: AWS primary (us-east-1), Azure secondary (disaster recovery).
Data Center: Equinix NY5 co-location for latency-sensitive trading infrastructure.
Network: Dedicated MPLS circuit to NYSE and NASDAQ. Redundant internet via Cogent and Level 3.
DR: Full failover capability. RTO 4 hours, RPO 1 hour for critical trading systems.

SECURITY ARCHITECTURE
Identity: Okta SSO with MFA enforced for all applications.
Endpoint: CrowdStrike Falcon on all devices. MDM via Jamf (Mac) and Intune (Windows).
Network: Palo Alto NGFW, Zscaler ZIA for internet access, Zscaler ZPA for remote access.
Email: Microsoft 365 with Mimecast anti-phishing and archiving.
SIEM: Splunk Enterprise Security. SOC: outsourced to Arctic Wolf (24/7 monitoring).

VENDOR ACCESS
All vendor remote access via BeyondTrust Privileged Remote Access.
Vendor access reviewed quarterly. Inactive accounts auto-disabled after 30 days.
Penetration testing: annual by external firm, quarterly scans by internal team.
</document>`,
};

type DocChunkKey = keyof typeof DOC_CHUNKS;

// Realistic questions mapped to relevant document chunks
const QUESTIONS: Array<{ query: string; chunks: DocChunkKey[]; repeat?: boolean }> = [
  // Investment policy questions (high repeat rate in real usage)
  { query: 'What is the maximum position size for a single equity?', chunks: ['investmentPolicy'], repeat: true },
  { query: 'Are we allowed to invest in cryptocurrency?', chunks: ['investmentPolicy'], repeat: true },
  { query: 'What is the leverage policy for fixed income accounts?', chunks: ['investmentPolicy'] },
  { query: 'What approval is needed for a $6M trade?', chunks: ['investmentPolicy'], repeat: true },

  // Compliance questions
  { query: 'When is the Form ADV annual filing due?', chunks: ['complianceGuide'], repeat: true },
  { query: 'What is the blackout period before earnings releases?', chunks: ['complianceGuide'], repeat: true },
  { query: 'How long do we need to retain business emails?', chunks: ['complianceGuide'] },

  // HR questions (very high repeat in practice)
  { query: 'How many PTO days does a 4-year employee get?', chunks: ['hrPolicy'], repeat: true },
  { query: 'What is the parental leave policy for primary caregivers?', chunks: ['hrPolicy'], repeat: true },
  { query: 'What is the 401k company match?', chunks: ['hrPolicy'], repeat: true },
  { query: 'Does the company cover vision insurance?', chunks: ['hrPolicy'] },

  // Cross-document questions (multiple chunks retrieved)
  { query: 'Who do I contact if I suspect a compliance violation and what are the timelines?', chunks: ['complianceGuide', 'techStack'] },
  { query: 'What is our cloud infrastructure setup and DR capability?', chunks: ['techStack'] },
  { query: 'What trading systems do we use for equity orders?', chunks: ['techStack'] },
];

function buildConversation(q: typeof QUESTIONS[number], id: string) {
  const chunks = q.chunks.map((k: DocChunkKey) => DOC_CHUNKS[k]).join('\n\n');
  return {
    id,
    turns: [[
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user'   as const, content: `${chunks}\n\n[QUESTION]\n${q.query}` },
    ]],
  };
}

export const ragAppScenario: ScenarioDefinition = {
  name:        'RAG Knowledge Base',
  description: '60 requests — large retrieved chunks per query, 80x payload inflation. Tests RAG detection and provider caching on stable docs.',
  provider:    'anthropic',
  model:       'claude-haiku-4-5',
  outputVariance: 0.1,

  conversations: [
    // First pass — all questions
    ...QUESTIONS.map((q, i) => buildConversation(q, `q-first-${i}`)),
    // Repeated questions (simulates different users asking the same thing)
    ...QUESTIONS.filter(q => q.repeat).flatMap((q, i) => [
      buildConversation(q, `q-repeat-a-${i}`),
      buildConversation(q, `q-repeat-b-${i}`),
      buildConversation(q, `q-repeat-c-${i}`),
    ]),
  ],
};
