import { ToolSchemaFilter } from '../../src/optimization/ToolSchemaFilter.js';
import { LLMTool } from '../../src/types/index.js';

const AGENT_TOOLS: LLMTool[] = [
  { name: 'web_search',     description: 'Search the web for current information and news',          parameters: {} },
  { name: 'browse_url',     description: 'Fetch and extract text content from a specific webpage',   parameters: {} },
  { name: 'analyze_data',   description: 'Analyze and summarize structured data or spreadsheets',    parameters: {} },
  { name: 'save_finding',   description: 'Save an important finding or note to research memory',     parameters: {} },
  { name: 'compile_report', description: 'Compile all findings into a final structured report',      parameters: {} },
];

describe('ToolSchemaFilter', () => {
  let filter: ToolSchemaFilter;

  beforeEach(() => { filter = new ToolSchemaFilter(); });

  it('returns all tools unchanged when fewer than 3 tools', () => {
    const twoTools = AGENT_TOOLS.slice(0, 2);
    const result = filter.filter(twoTools, [{ role: 'user', content: 'search the web' }]);
    expect(result.tools).toHaveLength(2);
    expect(result.tokensSaved).toBe(0);
    expect(result.reasoning).toContain('Too few tools');
  });

  it('filters to relevant tools based on current step intent', () => {
    const messages = [{ role: 'user' as const, content: 'Now search for the latest AI news from this week' }];
    const result = filter.filter(AGENT_TOOLS, messages);
    // web_search and browse_url should score high for "search" intent
    const names = result.tools.map(t => t.name);
    expect(names).toContain('web_search');
  });

  it('always retains recently used tools', () => {
    const messages = [
      { role: 'assistant' as const, content: '{"tool_name": "compile_report", "args": {}}' },
      { role: 'user'      as const, content: 'Now just do a quick calculation on this data' },
    ];
    const result = filter.filter(AGENT_TOOLS, messages);
    const names = result.tools.map(t => t.name);
    expect(names).toContain('compile_report'); // recently used, must be included
  });

  it('falls back to all tools when fewer than 2 match', () => {
    const messages = [{ role: 'user' as const, content: 'xyzzy frumple snargblat' }]; // nonsense keywords
    const result = filter.filter(AGENT_TOOLS, messages);
    // Should fall back conservatively
    expect(result.tools.length).toBeGreaterThanOrEqual(AGENT_TOOLS.length);
    expect(result.reasoning).toContain('safe');
  });

  it('reports token savings when filtering occurs', () => {
    const messages = [{ role: 'user' as const, content: 'Search for competitors and browse their pricing pages' }];
    const result = filter.filter(AGENT_TOOLS, messages);
    if (result.filteredCount < result.originalCount) {
      expect(result.tokensSaved).toBeGreaterThan(0);
    }
  });
});
