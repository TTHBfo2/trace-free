// Shared display formatting for the free dashboard.
//
// Every page used to carry its own copy of `usd()` with slightly different
// thresholds, so the same quantity rendered as $1.53 on Overview, $1.659 on
// Attribution and $0.9710 on Models. One formatter, imported everywhere.

/** Money, scaled for readability. Sub-cent values keep enough precision to be
 *  meaningful (per-request / per-1k costs), whole dollars get cents only. */
export function usd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0.00';
  if (n >= 1000)  return `$${(n / 1000).toFixed(1)}K`;
  if (n >= 1)     return `$${n.toFixed(2)}`;
  if (n >= 0.001) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

/** Brand-correct provider names. The session log stores lowercase ids;
 *  rendering them through CSS `capitalize` produced "Openai". */
const PROVIDER_LABELS: Record<string, string> = {
  openai:     'OpenAI',
  anthropic:  'Anthropic',
  gemini:     'Gemini',
  groq:       'Groq',
  ollama:     'Ollama',
  azure:      'Azure OpenAI',
  deepseek:   'DeepSeek',
  openrouter: 'OpenRouter',
  mistral:    'Mistral',
  custom:     'Custom',
};

export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : '');
}
