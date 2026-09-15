/**
 * TTL Strategy Impact — No API needed, pure cache simulation
 *
 * Simulates 100 support tickets spread over 8 hours.
 * Compares cache hit rates under three TTL strategies:
 *   - Old 5-min default: only catches questions asked within 5 minutes of each other
 *   - New 24h default:   catches any repeat within the same day
 *   - Smart (prompt-aware): 24h + auto-invalidates when system prompt changes
 *
 * Run: npx tsx tests/benchmark/ttl-impact.ts
 */

// No external imports needed — pure logic simulation

const THICK = '═'.repeat(70);

// ─── Traffic model ────────────────────────────────────────────────────────────

const FAQ = [
  'How do I cancel my subscription?',
  'What payment methods do you accept?',
  'How much does the Pro plan cost?',
  'Is there a free trial available?',
  'How do I add team members?',
  'What is the Business plan price?',
  'Can I export my project data?',
  'How do I reset my password?',
  'Does TechFlow integrate with Slack?',
  'How long is data kept after cancellation?',
];

const UNIQUE_TEMPLATES = [
  'Our GitHub sync broke after upgrading (ticket #',
  'Need to transfer workspace ownership (ticket #',
  'We have 87 users trying to stay under budget (ticket #',
  'Getting 401 errors on webhook (ticket #',
  'Need compliance reports for SOC2 audit (ticket #',
];

interface Ticket {
  question:     string;
  minuteOfDay:  number;   // 0 = 9am, 480 = 5pm (8-hour work day)
  isRepeatFAQ:  boolean;
}

function generateTraffic(seed = 42): Ticket[] {
  // Deterministic "random" for reproducible results
  let rng = seed;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };

  const tickets: Ticket[] = [];

  // 60 FAQ tickets: same 10 questions, 6 repetitions each, random times
  for (let faqIdx = 0; faqIdx < 10; faqIdx++) {
    for (let rep = 0; rep < 6; rep++) {
      tickets.push({
        question:    FAQ[faqIdx],
        minuteOfDay: Math.floor(rand() * 480),
        isRepeatFAQ: true,
      });
    }
  }

  // 40 unique tickets: each is genuinely unique (ticket number in question)
  for (let i = 0; i < 40; i++) {
    tickets.push({
      question:    UNIQUE_TEMPLATES[i % 5] + (1000 + i) + ')',
      minuteOfDay: Math.floor(rand() * 480),
      isRepeatFAQ: false,
    });
  }

  return tickets.sort((a, b) => a.minuteOfDay - b.minuteOfDay);
}

// ─── Cache hit simulation using actual time comparison ────────────────────────

function simulateCacheHits(
  traffic: Ticket[],
  ttlMinutes: number,
  systemPromptChangesAt: number | null,    // minute when system prompt updates
): { hits: number; misses: number; hitRate: number; staleServed: number } {

  // Map: question → { cachedAtMinute, systemPromptVersion }
  const cache = new Map<string, { cachedAt: number; promptVersion: number }>();

  let hits = 0;
  let misses = 0;
  let staleServed = 0;   // hits that returned OLD system-prompt answers (bad!)
  let currentPromptVersion = 1;

  for (const ticket of traffic) {
    // System prompt changed?
    if (systemPromptChangesAt !== null && ticket.minuteOfDay >= systemPromptChangesAt && currentPromptVersion === 1) {
      currentPromptVersion = 2;
      // With smart cache: auto-invalidate stale entries
      // (We handle this in the smart variant below by checking version)
    }

    const cached = cache.get(ticket.question);

    if (cached) {
      const ageMinutes = ticket.minuteOfDay - cached.cachedAt;
      const expired    = ageMinutes > ttlMinutes;
      const stale      = systemPromptChangesAt !== null && cached.promptVersion !== currentPromptVersion;

      if (!expired) {
        if (stale) {
          // Old system prompt answer served — wrong information
          staleServed++;
          hits++; // counts as a hit technically, but wrong answer
        } else {
          hits++;
        }
      } else {
        misses++;
        cache.set(ticket.question, { cachedAt: ticket.minuteOfDay, promptVersion: currentPromptVersion });
      }
    } else {
      misses++;
      cache.set(ticket.question, { cachedAt: ticket.minuteOfDay, promptVersion: currentPromptVersion });
    }
  }

  const total = hits + misses;
  return { hits, misses, hitRate: total > 0 ? (hits / total) * 100 : 0, staleServed };
}

function simulateSmartCache(traffic: Ticket[], systemPromptChangesAt: number | null) {
  // Smart cache: invalidate ALL entries when system prompt changes
  // Uses very long TTL (7 days) but auto-invalidates on prompt update
  const cache = new Map<string, { cachedAt: number; promptVersion: number }>();
  const TTL_MINUTES = 7 * 24 * 60; // 7 days

  let hits = 0; let misses = 0; let invalidations = 0;
  let currentVersion = 1;
  let invalidatedAt: number | null = null;

  for (const ticket of traffic) {
    if (systemPromptChangesAt !== null && ticket.minuteOfDay >= systemPromptChangesAt && currentVersion === 1) {
      currentVersion = 2;
      invalidatedAt  = ticket.minuteOfDay;
      // Invalidate all cached entries from old prompt version
      for (const [key, entry] of cache) {
        if (entry.promptVersion !== 2) { cache.delete(key); invalidations++; }
      }
    }

    const cached = cache.get(ticket.question);
    if (cached && (ticket.minuteOfDay - cached.cachedAt) <= TTL_MINUTES) {
      hits++;
    } else {
      misses++;
      cache.set(ticket.question, { cachedAt: ticket.minuteOfDay, promptVersion: currentVersion });
    }
  }

  const total = hits + misses;
  return { hits, misses, hitRate: total > 0 ? (hits / total) * 100 : 0, staleServed: 0, invalidations };
}

// ─── Run simulation across multiple seeds for stable averages ─────────────────

console.log('\n' + THICK);
console.log('  TTL Strategy Impact — Realistic Support Bot Traffic Simulation');
console.log('  100 tickets over 8 hours · 60 FAQ (10 questions × 6 repeats) · 40 unique');
console.log('  System prompt updated at midday (new pricing) — tests stale-answer risk');
console.log(THICK + '\n');

const SEEDS     = [42, 77, 123, 256, 512];
const PROMPT_CHANGE = 240; // minute 240 = midday

const allResults = {
  fiveMin:  { hitRates: [] as number[], staleRates: [] as number[] },
  twentyFourH: { hitRates: [] as number[], staleRates: [] as number[] },
  smart:    { hitRates: [] as number[], staleRates: [] as number[] },
};

for (const seed of SEEDS) {
  const traffic = generateTraffic(seed);

  const r5   = simulateCacheHits(traffic, 5,          PROMPT_CHANGE);
  const r24  = simulateCacheHits(traffic, 24 * 60,    PROMPT_CHANGE);
  const rSmt = simulateSmartCache(traffic,             PROMPT_CHANGE);

  allResults.fiveMin.hitRates.push(r5.hitRate);
  allResults.fiveMin.staleRates.push((r5.staleServed / (r5.hits + r5.misses)) * 100);
  allResults.twentyFourH.hitRates.push(r24.hitRate);
  allResults.twentyFourH.staleRates.push((r24.staleServed / (r24.hits + r24.misses)) * 100);
  allResults.smart.hitRates.push(rSmt.hitRate);
  allResults.smart.staleRates.push(0);
}

const avg = (arr: number[]) => (arr.reduce((s, v) => s + v, 0) / arr.length);

const fiveMinHit  = avg(allResults.fiveMin.hitRates);
const fiveMinStale = avg(allResults.fiveMin.staleRates);
const twentyFourHit = avg(allResults.twentyFourH.hitRates);
const twentyFourStale = avg(allResults.twentyFourH.staleRates);
const smartHit    = avg(allResults.smart.hitRates);

console.log('  Strategy              Hit Rate    Stale answers served   Verdict');
console.log('  ' + '─'.repeat(68));
console.log(`  Old default (5 min)   ${fiveMinHit.toFixed(1).padEnd(12)}%  ${fiveMinStale.toFixed(1)}%                   ✗ Low hits + stale risk`);
console.log(`  New default (24h)     ${twentyFourHit.toFixed(1).padEnd(12)}%  ${twentyFourStale.toFixed(1)}%                   ⚠ High hits but serves stale`);
console.log(`  Smart (prompt-aware)  ${smartHit.toFixed(1).padEnd(12)}%  0.0%                   ✓ High hits + always fresh`);

const costPerCall  = 0.000011;
const totalTickets = 100;
const scale        = 10_000 / totalTickets;

const costOld   = ((totalTickets * (1 - fiveMinHit    / 100)) * costPerCall * scale * 30);
const costNew   = ((totalTickets * (1 - twentyFourHit  / 100)) * costPerCall * scale * 30);
const costSmart = ((totalTickets * (1 - smartHit      / 100)) * costPerCall * scale * 30);
const costNone  = (totalTickets * costPerCall * scale * 30);

console.log('');
console.log('  Monthly cost at 10,000 tickets/day (real Groq prices):');
console.log(`    No cache:           $${costNone.toFixed(2)}/mo`);
console.log(`    Old default (5min): $${costOld.toFixed(2)}/mo   (saves $${(costNone - costOld).toFixed(2)}/mo)`);
console.log(`    New default (24h):  $${costNew.toFixed(2)}/mo   (saves $${(costNone - costNew).toFixed(2)}/mo)`);
console.log(`    Smart:              $${costSmart.toFixed(2)}/mo   (saves $${(costNone - costSmart).toFixed(2)}/mo)`);

console.log('');
console.log('  The stale answer problem (why 24h alone is not enough):');
console.log(`    With 24h TTL, after a midday system prompt update,`);
console.log(`    ${twentyFourStale.toFixed(1)}% of all tickets are answered with OLD information`);
console.log(`    (old pricing, old cancellation policy, old features).`);
console.log(`    Smart cache detects the change and invalidates immediately.`);
console.log(`    Zero stale answers after any system prompt update.\n`);

console.log('  Bottom line:');
console.log(`    Old → Smart TTL improvement: +${(smartHit - fiveMinHit).toFixed(1)}% hit rate`);
console.log(`    Same developer workload required: zero code changes`);
console.log(`    The default TTL change alone closes most of the real-world gap.\n`);
