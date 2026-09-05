export function trustLevel(score) {
  return score >= 70 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW';
}

export function trustDecision(legacyDecision) {
  if (legacyDecision === 'blocked') return 'BLOCK';
  if (legacyDecision === 'step_up_required') return 'REVIEW';
  return 'PASS';
}

/** Stable evidence labels for audit, replay, and the Security Lab. */
export function trustReasonCodes(result = {}) {
  const bySignal = {
    'Cross-border': 'CROSS_BORDER',
    'Verification': 'VERIFICATION_FAILED',
    'Budget proximity': 'NEAR_BUDGET_LIMIT',
    'Merchant familiarity': 'UNKNOWN_MERCHANT',
    'Merchant tenure': 'MERCHANT_NEW',
    'GST/KYC': 'MERCHANT_UNVERIFIED',
    'Seller rating': 'SELLER_REPUTATION_LOW',
    'Review volume': 'SELLER_HISTORY_THIN',
    'Category risk': 'CATEGORY_RISK',
    'Spend velocity': 'HIGH_VELOCITY'
  };
  const codes = (result.signals || [])
    .filter(signal => signal.triggered)
    .map(signal => bySignal[signal.label] || 'TRUST_SIGNAL');
  return codes.length ? [...new Set(codes)] : ['MERCHANT_VERIFIED'];
}
