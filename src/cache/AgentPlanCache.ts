// Agentic Plan Cache — the novel layer.
//
// Problem: In multi-step tool-calling workflows, agents spend tokens re-deriving
// the same execution plan (sequence of tool calls + reasoning) for similar tasks.
// This cache stores the *plan* itself, not the final output.
//
// On a cache hit, callers get the cached plan back immediately and can seed their
// agent with it, skipping the planning phase entirely. Zero extra AI calls.

import { createHash } from 'crypto';
import { AgentPlan, AgentStep, CacheStats, ProviderName } from '../types/index.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes — plans stay valid longer than responses
const DEFAULT_MAX_ENTRIES = 200;

export class AgentPlanCache {
  private store = new Map<string, AgentPlan>();
  private hitCount = 0;
  private missCount = 0;
  private ttlMs: number;
  private maxEntries: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.cleanupTimer = setInterval(() => this.evictExpired(), 5 * 60 * 1000);
  }

  getPlan(taskDescription: string): AgentPlan | null {
    const hash = this.hashTask(taskDescription);

    for (const [, plan] of this.store) {
      if (plan.taskHash !== hash) continue;
      if (Date.now() - plan.createdAt > this.ttlMs) { this.store.delete(plan.planId); continue; }
      plan.hitCount++;
      plan.lastUsedAt = Date.now();
      this.hitCount++;
      return plan;
    }

    this.missCount++;
    return null;
  }

  storePlan(params: {
    taskDescription: string;
    steps: AgentStep[];
    provider: ProviderName;
    model: string;
    inputTokensUsed: number;
    outputTokensUsed: number;
  }): AgentPlan {
    if (this.store.size >= this.maxEntries) this.evictLRU();

    const planId = generatePlanId();
    const taskHash = this.hashTask(params.taskDescription);
    const estimatedTokensSaved = params.inputTokensUsed + params.outputTokensUsed;

    const plan: AgentPlan = {
      planId,
      taskHash,
      steps: params.steps,
      createdAt: Date.now(),
      hitCount: 0,
      lastUsedAt: Date.now(),
      provider: params.provider,
      model: params.model,
      estimatedTokensSaved,
    };

    this.store.set(planId, plan);
    return plan;
  }

  // Call this after a tool-calling response to extract and cache the plan.
  extractAndStore(params: {
    taskDescription: string;
    toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
    reasoning?: string;
    provider: ProviderName;
    model: string;
    inputTokensUsed: number;
    outputTokensUsed: number;
  }): AgentPlan {
    const steps: AgentStep[] = params.toolCalls.map((tc, i) => ({
      stepIndex: i,
      toolName: tc.name,
      toolArgs: tc.arguments,
      reasoning: i === 0 ? params.reasoning : undefined,
    }));

    return this.storePlan({
      taskDescription: params.taskDescription,
      steps,
      provider: params.provider,
      model: params.model,
      inputTokensUsed: params.inputTokensUsed,
      outputTokensUsed: params.outputTokensUsed,
    });
  }

  invalidate(taskDescription: string): void {
    const hash = this.hashTask(taskDescription);
    for (const [id, plan] of this.store) {
      if (plan.taskHash === hash) this.store.delete(id);
    }
  }

  clear(): void {
    this.store.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }

  stats(): CacheStats {
    const total = this.hitCount + this.missCount;
    return {
      totalEntries: this.store.size,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: total > 0 ? parseFloat(((this.hitCount / total) * 100).toFixed(1)) : 0,
      sizeBytes: this.store.size * 1024, // rough estimate
    };
  }

  totalTokensSaved(): number {
    let saved = 0;
    for (const plan of this.store.values()) {
      saved += plan.estimatedTokensSaved * plan.hitCount;
    }
    return saved;
  }

  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.clear();
  }

  private hashTask(taskDescription: string): string {
    const normalized = taskDescription.toLowerCase().replace(/\s+/g, ' ').trim();
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, plan] of this.store) {
      if (now - plan.createdAt > this.ttlMs) this.store.delete(id);
    }
  }

  private evictLRU(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [id, plan] of this.store) {
      if (plan.lastUsedAt < oldestTime) { oldestTime = plan.lastUsedAt; oldest = id; }
    }
    if (oldest) this.store.delete(oldest);
  }
}

function generatePlanId(): string {
  return createHash('sha256')
    .update(`plan-${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 16);
}
