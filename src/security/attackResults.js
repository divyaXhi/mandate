/** One normalized, audit-ready shape for every Security Lab result. */
export function attackResult(attack, {
  transactionId, detectionLayer, detectionReason, decision,
  blocked = false, paymentAttempted = false, originalAttemptExecuted = false,
  duplicatePaymentExecuted = false, evidence = {}, recoveryAction, timeline = [], defenseChain = null
} = {}) {
  const status = blocked ? 'BLOCKED'
    : decision === 'NEUTRALIZED' ? 'NEUTRALIZED'
      : decision === 'RECOVERED' ? 'RECOVERED' : 'FAILED';
  return {
    attackId: attack.id,
    attackName: attack.name,
    attackType: attack.id, // compatibility with the original Attack Mode UI
    title: attack.name,
    status,
    detectionLayer,
    detectionReason,
    transactionId,
    decision,
    finalDecision: decision,
    blocked,
    paymentAttempted,
    originalAttemptExecuted,
    duplicatePaymentExecuted,
    evidence,
    recoveryAction,
    defenseChain: defenseChain || [
      'Attack received',
      `Detection: ${detectionLayer}`,
      `Defense reason: ${detectionReason}`,
      `Decision: ${decision}`,
      duplicatePaymentExecuted ? 'Payment boundary: duplicate payment executed (failure)' : 'Payment boundary: no duplicate payment executed',
      'Audit recorded'
    ],
    auditEvent: blocked ? 'ATTACK_RESOLVED' : 'ATTACK_RECOVERED',
    timestamp: new Date().toISOString(),
    timeline
  };
}

/** A score is calculated only from observed results, never from a fixed total. */
export function isDefended(result) {
  return result.blocked === true || result.decision === 'NEUTRALIZED' || result.decision === 'RECOVERED' || result.decision === 'SAFE_RETRY';
}

/** Write every Security Lab run into the existing append-only audit trail. */
export function recordAttackAudit(result, logEvent) {
  logEvent(result.transactionId, 'ATTACK_STARTED', { attackId: result.attackId, attackName: result.attackName });
  logEvent(result.transactionId, 'ATTACK_DETECTED', { layer: result.detectionLayer, reason: result.detectionReason });
  logEvent(result.transactionId, 'SECURITY_DECISION', {
    status: result.status, finalDecision: result.finalDecision, blocked: result.blocked,
    paymentAttempted: result.paymentAttempted,
    originalAttemptExecuted: result.originalAttemptExecuted,
    duplicatePaymentExecuted: result.duplicatePaymentExecuted
  });
  logEvent(result.transactionId, result.auditEvent, { recoveryAction: result.recoveryAction });
}
