import { ScenarioDefinition } from '../runner.js';

// Real-world scenario: AI coding assistant with large codebase context.
// Pain: 3,000-token codebase context in system prompt, sent fresh on every question.
// Mix of questions about the same code — semantic cache should catch paraphrases.

const CODEBASE_CONTEXT = `You are a coding assistant for the Meridian Capital trading platform.
You have access to the following codebase context. Answer questions accurately based on the code.

=== src/trading/OrderManager.ts ===
import { Order, OrderStatus, OrderType } from '../types/trading';
import { RiskEngine } from './RiskEngine';
import { ExecutionBroker } from './ExecutionBroker';
import { AuditLogger } from '../audit/AuditLogger';
import { EventEmitter } from 'events';

export class OrderManager extends EventEmitter {
  private riskEngine: RiskEngine;
  private broker: ExecutionBroker;
  private auditLogger: AuditLogger;
  private pendingOrders = new Map<string, Order>();

  constructor(riskEngine: RiskEngine, broker: ExecutionBroker, auditLogger: AuditLogger) {
    super();
    this.riskEngine = riskEngine;
    this.broker = broker;
    this.auditLogger = auditLogger;
  }

  async submitOrder(order: Order): Promise<{ orderId: string; status: OrderStatus }> {
    const riskCheck = await this.riskEngine.validate(order);
    if (!riskCheck.approved) {
      await this.auditLogger.log('ORDER_REJECTED', { order, reason: riskCheck.reason });
      throw new OrderRejectedError(riskCheck.reason);
    }
    const orderId = this.generateOrderId();
    this.pendingOrders.set(orderId, { ...order, id: orderId, status: 'PENDING' });
    await this.auditLogger.log('ORDER_SUBMITTED', { orderId, order });
    const executionResult = await this.broker.execute({ ...order, id: orderId });
    const finalStatus = executionResult.filled ? 'FILLED' : 'PARTIAL';
    this.pendingOrders.set(orderId, { ...order, id: orderId, status: finalStatus });
    this.emit('orderUpdate', { orderId, status: finalStatus, executionResult });
    await this.auditLogger.log('ORDER_EXECUTED', { orderId, executionResult });
    return { orderId, status: finalStatus };
  }

  async cancelOrder(orderId: string): Promise<void> {
    const order = this.pendingOrders.get(orderId);
    if (!order) throw new Error(\`Order \${orderId} not found\`);
    if (order.status === 'FILLED') throw new Error('Cannot cancel filled order');
    await this.broker.cancel(orderId);
    this.pendingOrders.set(orderId, { ...order, status: 'CANCELLED' });
    await this.auditLogger.log('ORDER_CANCELLED', { orderId });
  }

  getOrder(orderId: string): Order | undefined {
    return this.pendingOrders.get(orderId);
  }

  private generateOrderId(): string {
    return \`ORD-\${Date.now()}-\${Math.random().toString(36).slice(2, 8).toUpperCase()}\`;
  }
}

=== src/trading/RiskEngine.ts ===
import { Order, RiskCheckResult } from '../types/trading';
import { PositionBook } from './PositionBook';
import { InvestmentPolicy } from '../compliance/InvestmentPolicy';

export class RiskEngine {
  private positions: PositionBook;
  private policy: InvestmentPolicy;

  constructor(positions: PositionBook, policy: InvestmentPolicy) {
    this.positions = positions;
    this.policy = policy;
  }

  async validate(order: Order): Promise<RiskCheckResult> {
    const checks = await Promise.all([
      this.checkConcentrationLimit(order),
      this.checkLiquidityRequirement(order),
      this.checkProhibitedList(order),
      this.checkLeveragePolicy(order),
      this.checkApprovalThreshold(order),
    ]);

    const failed = checks.find(c => !c.passed);
    if (failed) return { approved: false, reason: failed.reason };
    return { approved: true };
  }

  private async checkConcentrationLimit(order: Order): Promise<{ passed: boolean; reason?: string }> {
    const currentPosition = this.positions.getPosition(order.symbol);
    const totalAUM = this.positions.getTotalAUM();
    const orderValue = order.quantity * order.limitPrice;
    const newConcentration = (currentPosition.marketValue + orderValue) / totalAUM;
    if (newConcentration > 0.08) {
      return { passed: false, reason: \`Concentration limit exceeded: \${(newConcentration * 100).toFixed(1)}% > 8% max\` };
    }
    return { passed: true };
  }

  private async checkApprovalThreshold(order: Order): Promise<{ passed: boolean; reason?: string }> {
    const orderValue = order.quantity * order.limitPrice;
    if (orderValue > 5_000_000) {
      const hasApproval = await this.policy.checkInvestmentCommitteeApproval(order.id);
      if (!hasApproval) {
        return { passed: false, reason: 'Order > $5M requires Investment Committee approval' };
      }
    }
    return { passed: true };
  }

  private async checkLiquidityRequirement(order: Order): Promise<{ passed: boolean; reason?: string }> {
    const liquidRatio = this.positions.getLiquidRatio();
    if (order.type === 'BUY' && liquidRatio < 0.30) {
      return { passed: false, reason: \`Minimum 30% liquidity not maintained: currently \${(liquidRatio * 100).toFixed(1)}%\` };
    }
    return { passed: true };
  }

  private async checkProhibitedList(order: Order): Promise<{ passed: boolean; reason?: string }> {
    const isProhibited = await this.policy.isProhibitedSecurity(order.symbol);
    if (isProhibited) return { passed: false, reason: \`\${order.symbol} is on the prohibited securities list\` };
    return { passed: true };
  }

  private async checkLeveragePolicy(_order: Order): Promise<{ passed: boolean; reason?: string }> {
    return { passed: true }; // leverage check for equity: always passes (no leverage permitted)
  }
}

=== src/types/trading.ts ===
export interface Order {
  id?: string;
  symbol: string;
  type: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT' | 'STOP';
  quantity: number;
  limitPrice: number;
  account: string;
  trader: string;
  timestamp?: Date;
  status?: OrderStatus;
  metadata?: Record<string, unknown>;
}

export type OrderStatus = 'PENDING' | 'FILLED' | 'PARTIAL' | 'CANCELLED' | 'REJECTED';

export interface RiskCheckResult {
  approved: boolean;
  reason?: string;
  checks?: string[];
}`;

// Questions about the codebase — mix of exact and paraphrased
const QUESTIONS = [
  // Exact repeats (different devs asking the same thing)
  { q: 'What checks does the RiskEngine run on an order?',                  repeat: 3 },
  { q: 'How is an order ID generated?',                                     repeat: 3 },
  { q: 'What happens when an order exceeds the concentration limit?',       repeat: 2 },
  { q: 'What is the approval threshold for large orders?',                  repeat: 3 },
  // Paraphrases (semantic cache candidates)
  { q: 'What validation does RiskEngine perform before executing a trade?' },
  { q: 'Walk me through the order submission flow in OrderManager' },
  { q: 'How does the system enforce the $5M investment committee approval rule?' },
  { q: 'What is the maximum concentration allowed per position?' },
  { q: 'How can I cancel an order and what conditions prevent cancellation?' },
  // Unique debugging/extension questions
  { q: 'How would I add a new risk check for sector concentration limits?' },
  { q: 'The audit logger is called three times in submitOrder — is that correct and intentional?' },
  { q: 'I need to add a timeout to the broker.execute() call. Where is the best place to add it?' },
  { q: 'What event does OrderManager emit after an order is executed?' },
];

export const codingAssistantScenario: ScenarioDefinition = {
  name:        'Coding Assistant (Codebase Context)',
  description: '~45 requests — 3,000-token codebase in system prompt every call. High repeat rate across dev team questions.',
  provider:    'openai',
  model:       'gpt-4o',
  outputVariance: 0.35,

  conversations: QUESTIONS.flatMap((item, i) => {
    const count = item.repeat ?? 1;
    return Array.from({ length: count }, (_, j) => ({
      id:    `code-${i}-${j}`,
      turns: [[
        { role: 'system' as const, content: CODEBASE_CONTEXT },
        { role: 'user'   as const, content: item.q },
      ]],
    }));
  }),
};
