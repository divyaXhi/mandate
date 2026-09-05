import { demoScenarioById } from './demoScenarios.js';
import { NegotiationEngine } from '../negotiationEngine.js';
import { buyerAgentIdentity, merchantAgentIdentity } from '../agentIdentity.js';
import { explainDecision } from '../observability/decisionExplanation.js';

/**
 * Deterministic judge scenarios that call the same negotiation, decision,
 * approval, and payment-guard functions as live transactions. No fake verdicts
 * or timers are used here.
 */
export function runDemoScenario(id, context) {
  const scenario = demoScenarioById(id);
  if (!scenario) throw new Error(`Unknown demo scenario: ${id}`);
  const { buildCartMandate, evaluateTransaction, evaluateApproval, runPaymentGuard, logEvent } = context;
  const transactionId = `DEMO-${scenario.id.toUpperCase()}`;
  const buyer = buyerAgentIdentity({ agentSeed: 'demo', profile: { name: 'Demo Buyer' } });
  const merchant = merchantAgentIdentity(scenario.product.merchant);
  const engine = new NegotiationEngine({ now: () => 1_700_000_000_000 });
  const negotiation = engine.createSession({
    transactionId, buyerAgent: buyer, merchantAgent: merchant, product: scenario.product,
    buyerMaxInr: scenario.buyerMaxInr, mandateVersion: 1
  });
  logEvent(transactionId, 'INTENT_RECEIVED', { prompt: scenario.prompt, deterministic: true });
  logEvent(transactionId, 'PRODUCT_SELECTED', { productId: scenario.product.id, source: 'demo_catalog' });
  engine.createOffer(negotiation.negotiationId, { productId: scenario.product.id, basePriceInr: scenario.negotiatedPriceInr });
  logEvent(transactionId, 'NEGOTIATION_COMPLETED', { negotiationId: negotiation.negotiationId, amountInr: scenario.negotiatedPriceInr });
  const deal = engine.acceptOffer(negotiation.negotiationId);
  const validation = engine.revalidateDeal(deal.dealId, {
    mandateVersion: 1, buyerMaxInr: scenario.buyerMaxInr, productId: scenario.product.id,
    merchantAgentId: merchant.agentId, finalAmountInr: deal.pricing.finalAmountInr, bundlePriceInr: 0
  });
  logEvent(transactionId, 'DEAL_CREATED', { dealId: deal.dealId, fingerprint: deal.fingerprint, valid: validation.valid });

  const cart = buildCartMandate(scenario.product, 'IN', scenario.buyerMaxInr, scenario.negotiatedPriceInr);
  cart.pricing.totalInr = deal.pricing.finalAmountInr;
  cart.approved = true; // deterministic stand-in for the explicit demo confirmation
  const decision = evaluateTransaction({
    transactionId,
    trustInput: { crossBorder: false, verificationMatch: true, amountRatio: deal.pricing.finalAmountInr / scenario.buyerMaxInr, knownMerchant: true, merchantTenureDays: 1200, gstVerified: true, category: scenario.product.category },
    riskInput: { amountInr: deal.pricing.finalAmountInr, mandate: scenario.mandate, dailySpentInr: 0, merchantTenureDays: 1200, gstVerified: true, category: scenario.product.category },
    policyInput: { amountInr: deal.pricing.finalAmountInr, category: scenario.product.category, isCrossBorder: false, mandate: scenario.mandate, dailySpentInr: 0 }
  });
  logEvent(transactionId, 'TRUST_EVALUATED', { score: decision.trust.score, decision: decision.trust.decision, reasonCodes: decision.trust.reasonCodes });
  logEvent(transactionId, 'RISK_EVALUATED', { score: decision.risk.score, level: decision.risk.level, reasonCodes: decision.risk.reasonCodes });
  logEvent(transactionId, 'POLICY_EVALUATED', { decision: decision.policy.decision, reasonCodes: decision.policy.reasonCodes });
  logEvent(transactionId, 'DECISION_EVALUATED', { finalDecision: decision.finalDecision, finalReason: decision.finalReason });
  const approval = evaluateApproval({ amountInr: cart.pricing.totalInr, mandate: scenario.mandate, trust: decision.trust, risk: decision.risk, policy: decision.policy, decision });
  logEvent(transactionId, 'APPROVAL_EVALUATED', { mode: approval.mode, allowed: approval.allowed });
  const paymentGuard = runPaymentGuard({
    cart, approvedAmountInr: cart.pricing.totalInr, mandate: scenario.mandate,
    transactionId, paymentMethod: 'cod', railConfigured: true, decision
  });
  logEvent(transactionId, paymentGuard.passed ? 'PAYMENT_GUARD_PASSED' : 'PAYMENT_GUARD_BLOCKED', { failedCheckId: paymentGuard.failedCheckId, paymentExecuted: false });

  return {
    scenario: { id: scenario.id, name: scenario.name, prompt: scenario.prompt },
    transactionId, deal: { ...deal, validation }, decision, approval, paymentGuard,
    paymentAuthorized: paymentGuard.passed && decision.finalDecision === 'ALLOW',
    explanation: explainDecision(decision, { deal: { ...deal, validation }, mandate: scenario.mandate, approval, paymentGuard })
  };
}
