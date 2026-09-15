import { ScenarioDefinition, Conversation } from '../runner.js';

// Real-world scenario: multi-step AI agent for competitive research.
// Pain: tool schemas (1,400 tokens) sent on EVERY step. Context accumulates O(N²).
// A 10-step agent loop sends the same tool definitions 10 times.
// This is the scenario where agent waste becomes visibly expensive.

const SYSTEM_PROMPT = `You are a competitive intelligence agent. Your job is to research companies,
analyze their products, pricing, and market positioning, then compile structured reports.
Use the available tools systematically. Always verify information before including it in reports.
Think step by step. When you have all the information needed, compile the final report.`;

// Large tool schemas — 1,400+ tokens of definitions sent every step
const AGENT_TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web for current information about companies, products, or market data. Returns a list of search results with titles, URLs, and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query. Be specific. Include company name and topic.' },
        num_results: { type: 'number', description: 'Number of results to return (1-10). Default 5.' },
        date_filter: { type: 'string', enum: ['any', 'past_week', 'past_month', 'past_year'], description: 'Filter results by date.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'browse_url',
    description: 'Fetch and extract the text content from a specific URL. Use this to read full articles, pricing pages, or documentation after finding relevant URLs via web_search.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch. Must be a valid http/https URL.' },
        extract_sections: { type: 'array', items: { type: 'string' }, description: 'Optional list of section names to prioritize extraction from (e.g., ["pricing", "features"]).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'analyze_competitor',
    description: 'Perform structured analysis of a competitor based on gathered data. Returns a structured analysis object with strengths, weaknesses, pricing, and market position.',
    parameters: {
      type: 'object',
      properties: {
        company_name: { type: 'string' },
        data_points: { type: 'array', items: { type: 'string' }, description: 'List of data points collected about this company.' },
        analysis_depth: { type: 'string', enum: ['surface', 'standard', 'deep'], description: 'Depth of analysis to perform.' },
        focus_areas: { type: 'array', items: { type: 'string' }, description: 'Specific areas to focus on: pricing, features, positioning, customers, technology.' },
      },
      required: ['company_name', 'data_points'],
    },
  },
  {
    name: 'save_finding',
    description: 'Save an important finding to the research notes. Use this to record key facts, quotes, or data points as you discover them.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['pricing', 'feature', 'customer', 'technology', 'positioning', 'news'] },
        company: { type: 'string' },
        finding: { type: 'string', description: 'The specific finding to record.' },
        source_url: { type: 'string', description: 'URL where this finding was discovered.' },
        confidence: { type: 'string', enum: ['confirmed', 'likely', 'uncertain'] },
      },
      required: ['category', 'company', 'finding'],
    },
  },
  {
    name: 'compile_report',
    description: 'Compile all gathered findings into a structured competitive intelligence report. Call this only when you have gathered sufficient data across all required dimensions.',
    parameters: {
      type: 'object',
      properties: {
        target_company: { type: 'string' },
        report_type: { type: 'string', enum: ['quick', 'standard', 'comprehensive'] },
        include_sections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Sections to include: executive_summary, product_analysis, pricing_analysis, customer_analysis, swot, recommendations',
        },
      },
      required: ['target_company', 'report_type'],
    },
  },
];

// Simulate a multi-step agent conversation — context grows at each step
function buildAgentConversation(targetCompany: string, convoId: string): Conversation {
  const steps = [
    { role: 'user'      as const, content: `Research ${targetCompany} and compile a competitive intelligence report. Focus on their pricing, key features, and market positioning versus us.` },
    { role: 'assistant' as const, content: `I'll research ${targetCompany} systematically. Starting with a general web search to get an overview.` },
    { role: 'user'      as const, content: `[Tool result: web_search("${targetCompany} pricing features 2025")] Found 5 results: ${targetCompany} website, G2 reviews, TechCrunch article, LinkedIn page, ProductHunt listing.` },
    { role: 'assistant' as const, content: `Good. I'll browse their pricing page directly for accurate data.` },
    { role: 'user'      as const, content: `[Tool result: browse_url("https://${targetCompany.toLowerCase()}.com/pricing")] Pricing page content: Starter $49/mo, Pro $149/mo, Enterprise custom. Annual discount 20%. Features matrix shows 47 line items across tiers.` },
    { role: 'assistant' as const, content: `Saving the pricing finding. Now checking G2 for customer sentiment and use cases.` },
    { role: 'user'      as const, content: `[Tool result: save_finding({category:"pricing", company:"${targetCompany}", finding:"Starter $49, Pro $149, Enterprise custom, 20% annual discount"})] Saved. [Tool result: web_search("${targetCompany} customer reviews use cases")] Found 8 reviews. Average 4.2/5. Common use cases: enterprise sales teams, customer success, revenue operations.` },
    { role: 'assistant' as const, content: `Noting the customer profile. Checking for recent news and funding.` },
    { role: 'user'      as const, content: `[Tool result: web_search("${targetCompany} funding news 2024 2025")] ${targetCompany} raised Series B $45M in Q3 2024. Expanding into European market. New VP of Sales hired from Salesforce.` },
    { role: 'assistant' as const, content: `I have sufficient data. Running structured analysis and compiling the report.` },
    { role: 'user'      as const, content: `[Tool result: analyze_competitor({company_name:"${targetCompany}", data_points:["Starter $49, Pro $149","4.2/5 G2","Series B $45M","Enterprise focus"]})] Analysis complete. Strengths: strong enterprise features, well-funded. Weaknesses: complex onboarding, high price point for SMB.` },
  ];

  // Build turns where each turn includes the FULL accumulated history (O(N²))
  const turns: ScenarioDefinition['conversations'][number]['turns'] = [];
  const accumulated: typeof steps = [];

  for (const step of steps) {
    accumulated.push(step);
    turns.push([
      { role: 'system' as const, content: SYSTEM_PROMPT },
      ...accumulated.map(s => ({ role: s.role, content: s.content })),
    ]);
  }

  return { id: convoId, turns };
}

// Six different research targets — shows cost pattern across multiple agent runs
const TARGETS = ['Notion', 'Linear', 'Asana', 'Monday.com', 'ClickUp', 'Basecamp'];

export const agentWorkflowScenario: ScenarioDefinition = {
  name:        'AI Agent (Competitive Research)',
  description: '6 agent workflows × 11 steps each = 66 requests. Tool schemas (1,400 tokens) sent every step. O(N²) context growth visible in attribution.',
  provider:    'openai',
  model:       'gpt-4o',
  outputVariance: 0.3,
  tools:       AGENT_TOOLS,

  conversations: TARGETS.map((target, i) => buildAgentConversation(target, `agent-${i}`)),
};
