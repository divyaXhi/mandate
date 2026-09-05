import { scoreTrustSignals } from './trustSignals.js';
import { trustLevel, trustDecision, trustReasonCodes } from './trustReasons.js';

/** Answers only: "who are we dealing with?" */
export function evaluateTrust(input = {}) {
  const result = scoreTrustSignals(input);
  const decision = trustDecision(result.decision);
  return {
    ...result,
    level: trustLevel(result.score),
    decision,
    canonicalDecision: decision,
    legacyDecision: result.decision,
    reasons: result.reasons || [],
    reasonCodes: trustReasonCodes(result)
  };
}
