import { buildDecisionProvenance } from './decisionProvenance.js';

/** Deterministic WHY panel data—built only from engine evidence and reason codes. */
export function explainDecision(decision, { deal = null, mandate = null, approval = null, paymentGuard = null, auditEvidence = [] } = {}) {
  if (!decision) return null;
  const provenance = buildDecisionProvenance(decision, { deal, mandate });
  const summary = decision.finalDecision === 'BLOCK'
    ? `${provenance.authority.layer} stopped this transaction.`
    : decision.finalDecision === 'REVIEW' ? `${provenance.authority.layer} requires human review.`
      : 'The deal is within the evaluated mandate and decision constraints.';
  return {
    summary,
    finalDecision: decision.finalDecision,
    finalReason: decision.finalReason || decision.reason,
    authority: provenance.authority,
    reasonCodes: provenance.reasonCodes,
    evidence: [...provenance.evidence, ...auditEvidence.map(event => `${event.stage}: ${event.event}`)],
    trust: { score: decision.trust?.score, level: decision.trust?.level, decision: decision.trust?.decision, reasons: decision.trust?.reasons || [], reasonCodes: decision.trust?.reasonCodes || [] },
    risk: { score: decision.risk?.score, level: decision.risk?.level, decision: decision.risk?.decision, reasons: decision.risk?.reasons || [], reasonCodes: decision.risk?.reasonCodes || [] },
    policy: { decision: decision.policy?.decision, reasons: decision.policy?.reasons || [], reasonCodes: decision.policy?.reasonCodes || [] },
    deal: deal ? { amountInr: deal.pricing?.finalAmountInr ?? deal.pricing?.totalInr, fingerprint: deal.fingerprint || null, valid: deal.validation?.valid ?? true } : null,
    approval: approval ? { mode: approval.mode, allowed: approval.allowed } : null,
    payment: paymentGuard ? { passed: paymentGuard.passed, failedCheckId: paymentGuard.failedCheckId } : null,
    paymentGuard: paymentGuard ? { passed: paymentGuard.passed, failedCheckId: paymentGuard.failedCheckId } : null,
    provenance
  };
}
