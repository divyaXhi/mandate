import { evaluateTrust } from '../trust/trustEngine.js';
import { evaluateRisk } from '../risk/riskEngine.js';
import { evaluateMandatePolicy } from '../policy/policyEngine.js';
import { resolveFinalDecision } from './decisionEngine.js';

/**
 * Canonical evaluation. The three engines receive the same frozen deal
 * facts, remain independently explainable, and produce one non-overridable
 * decision used by the existing Approval Gate and Payment Guard flow.
 */
export function evaluateTransaction({ transactionId = null, trustInput = {}, riskInput = {}, policyInput = {} } = {}) {
  const trust = evaluateTrust(trustInput);
  const risk = evaluateRisk(riskInput);
  const policy = evaluateMandatePolicy(policyInput);
  const resolution = resolveFinalDecision({ trust, risk, policy });
  const reasons = [
    ...trust.reasons.map(detail => ({ engine: 'TRUST', detail })),
    ...risk.reasons.map(detail => ({ engine: 'RISK', detail })),
    ...policy.reasons.map(detail => ({ engine: 'POLICY', detail }))
  ];
  return {
    trust,
    risk,
    policy,
    transactionId,
    ...resolution,
    // `reason` is retained for UI compatibility; finalReason is the
    // canonical field used by state, audit, and payment enforcement.
    reason: resolution.finalReason,
    evaluatedAt: new Date().toISOString(),
    approval: {
      required: resolution.finalDecision === 'REVIEW',
      status: resolution.finalDecision === 'BLOCK' ? 'NOT_AVAILABLE' : resolution.finalDecision === 'REVIEW' ? 'REQUIRED' : 'NOT_REQUIRED'
    },
    reasons,
    rule: 'Policy cannot be overridden by Trust or Risk. Approval follows this decision; Payment Guard still re-checks facts before execution.'
  };
}
