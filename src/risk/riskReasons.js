export function riskLevel(band) {
  return String(band || 'low').toUpperCase();
}

export function riskDecision(band) {
  if (band === 'high') return 'REVIEW';
  return 'PASS';
}

/** Stable evidence labels for audit, replay, and the Security Lab. */
export function riskReasonCodes(result = {}) {
  const bySignal = {
    'Limit proximity': 'UNUSUAL_AMOUNT',
    'Daily headroom': 'DAILY_SPEND_PRESSURE',
    'Autonomous threshold': 'ABOVE_AUTONOMOUS_THRESHOLD',
    'Price deviation': 'PRICE_ANOMALY',
    'Merchant age': 'MERCHANT_NEW',
    'Tax verification': 'MERCHANT_UNVERIFIED',
    'Border crossing': 'CROSS_BORDER',
    'Purchase velocity': 'HIGH_VELOCITY',
    'Injection attempt': 'PROMPT_INJECTION_DETECTED',
    'Category exposure': 'CATEGORY_EXPOSURE'
  };
  const codes = (result.signals || [])
    .filter(signal => signal.triggered)
    .map(signal => bySignal[signal.label] || 'RISK_SIGNAL');
  return codes.length ? [...new Set(codes)] : ['NO_ANOMALY_DETECTED'];
}
