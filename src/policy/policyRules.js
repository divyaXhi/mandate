export function policyReasonCode(policy) {
  if (policy.decision === 'blocked') {
    const text = (policy.violations || []).join(' ').toLowerCase();
    if (text.includes('per-transaction')) return 'AMOUNT_EXCEEDS_LIMIT';
    if (text.includes('daily limit')) return 'DAILY_LIMIT_EXCEEDED';
    if (text.includes('cross-border')) return 'CROSS_BORDER_NOT_ALLOWED';
    if (text.includes('blocked list')) return 'CATEGORY_BLOCKED';
    if (text.includes('allowed list')) return 'CATEGORY_NOT_ALLOWED';
    return 'MANDATE_VIOLATION';
  }
  return policy.decision === 'human_approval_required' ? 'HUMAN_APPROVAL_REQUIRED' : 'MANDATE_PERMITS';
}
