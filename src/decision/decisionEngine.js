/** Policy is never overridable. Trust can block; high risk requires review. */
export function resolveFinalDecision({ trust, risk, policy }) {
  if (policy.decision === 'BLOCK') return { finalDecision: 'BLOCK', finalReason: policy.reasonCode };
  if (trust.decision === 'BLOCK') return { finalDecision: 'BLOCK', finalReason: 'TRUST_TOO_LOW' };
  if (risk.decision === 'REVIEW') return { finalDecision: 'REVIEW', finalReason: 'RISK_REVIEW_REQUIRED' };
  if (trust.decision === 'REVIEW' || policy.decision === 'REVIEW') return { finalDecision: 'REVIEW', finalReason: trust.decision === 'REVIEW' ? 'TRUST_REVIEW_REQUIRED' : policy.reasonCode };
  return { finalDecision: 'ALLOW', finalReason: 'ALL_DETERMINISTIC_CHECKS_PASS' };
}
