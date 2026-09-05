import { scoreRiskSignals } from './riskSignals.js';
import { riskLevel, riskDecision, riskReasonCodes } from './riskReasons.js';

/** Answers only: "does this transaction look unusual or suspicious?" */
export function evaluateRisk(input = {}) {
  const result = scoreRiskSignals(input);
  const decision = riskDecision(result.band);
  return {
    ...result,
    level: riskLevel(result.band),
    decision,
    canonicalDecision: decision,
    legacyDecision: result.decision,
    reasons: result.reasons || [],
    reasonCodes: riskReasonCodes(result)
  };
}
