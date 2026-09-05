import { evaluatePolicy as evaluatePolicyRules } from '../policyEngine.js';
import { policyReasonCode } from './policyRules.js';

/** Answers only: "did the user mandate authorise this transaction?" */
export function evaluateMandatePolicy(input = {}) {
  const result = evaluatePolicyRules(input);
  const decision = result.decision === 'blocked' ? 'BLOCK' : result.decision === 'human_approval_required' ? 'REVIEW' : 'ALLOW';
  const reasonCode = policyReasonCode(result);
  return {
    ...result,
    decision,
    canonicalDecision: decision,
    legacyDecision: result.decision,
    reasonCode,
    reasonCodes: [reasonCode],
    rules: input.mandate || null,
    reasons: [...(result.violations || []), ...(result.flags || [])]
  };
}
