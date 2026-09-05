function codes(result) { return result?.reasonCodes || []; }
function amount(deal) { return deal?.pricing?.finalAmountInr ?? deal?.pricing?.totalInr ?? null; }

/** Records authority already exercised by the decision engine; never decides. */
export function buildDecisionProvenance(decision, { deal = null, mandate = null } = {}) {
  if (!decision) return null;
  const trust = decision.trust || {};
  const risk = decision.risk || {};
  const policy = decision.policy || {};
  const finalDecision = decision.finalDecision || decision.decision || null;
  let authority = { layer: 'DECISION_ENGINE', rule: decision.finalReason || 'ALL_CHECKS_PASSED' };
  if (finalDecision === 'BLOCK' && policy.decision === 'BLOCK') authority = { layer: 'POLICY', rule: decision.finalReason === 'AMOUNT_EXCEEDS_LIMIT' ? 'MAX_TRANSACTION_LIMIT' : (decision.finalReason || 'POLICY_RULE') };
  else if (finalDecision === 'BLOCK' && trust.decision === 'BLOCK') authority = { layer: 'TRUST', rule: decision.finalReason || 'TRUST_THRESHOLD' };
  else if (finalDecision === 'REVIEW' && (risk.decision === 'REVIEW' || risk.level === 'HIGH')) authority = { layer: 'RISK', rule: decision.finalReason || 'RISK_REVIEW' };
  const reasonCodes = [...new Set([...codes(trust), ...codes(risk), ...codes(policy), ...(decision.reasonCodes || []), decision.finalReason].filter(Boolean))];
  const evidence = [];
  if (amount(deal) != null) evidence.push(`Final deal: ₹${amount(deal).toLocaleString('en-IN')}`);
  if (mandate?.maxTransactionInr != null) evidence.push(`Mandate maximum: ₹${mandate.maxTransactionInr.toLocaleString('en-IN')}`);
  evidence.push(`Trust: ${trust.decision || 'UNKNOWN'}${trust.score != null ? ` (${trust.score})` : ''}`);
  evidence.push(`Risk: ${risk.decision || risk.level || 'UNKNOWN'}${risk.score != null ? ` (${risk.score})` : ''}`);
  evidence.push(`Policy: ${policy.decision || 'UNKNOWN'}`);
  return { finalDecision, authority, trust, risk, policy, reasonCodes, evidence };
}
