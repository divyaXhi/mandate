/**
 * Risk Engine — the second decision axis, deliberately kept separate from the
 * Trust Engine (trustLayer.js).
 *
 * WHY THIS EXISTS AS ITS OWN MODULE
 * Trust and risk answer different questions, and collapsing them into one
 * number is the single most misleading thing this product could do:
 *
 *   Trust  = "how credible is this COUNTERPARTY?"   (about the merchant)
 *   Risk   = "how unusual is this TRANSACTION?"     (about the purchase)
 *
 * A 96/100 merchant selling you something at 98% of your ceiling, as your
 * fourth purchase in ten minutes, is high trust AND high risk. Averaging those
 * into one "safety score" would hide exactly the case worth showing.
 *
 * WHAT THIS IS NOT
 * This is not a model, and it deliberately adds no new capability. Every input
 * below is already computed elsewhere in the pipeline — mandate limits, the
 * frozen deal price, merchant metadata, session velocity, injection detection.
 * Risk only reads existing facts and expresses them on a second axis so the UI
 * can show two independent opinions instead of one blended one.
 *
 * SCALE — note this runs OPPOSITE to trust:
 *   0   = nothing unusual
 *   100 = maximally unusual
 * Higher is worse. The UI must never render these two bars the same colour
 * direction, or a judge will read one of them backwards.
 *
 * Risk NEVER blocks on its own. Only the Policy Engine blocks. Risk raises the
 * approval bar (see approvalGate.js) and explains itself; it does not get a veto.
 */

const WATCH_THRESHOLD = 30;
const HIGH_THRESHOLD = 60;

/**
 * Category exposure — deliberately the same ordering as the trust layer's
 * category risk, because it reflects the same real-world fact (electronics get
 * resold, groceries don't). Kept as its own table so tuning one engine can't
 * silently move the other.
 */
const CATEGORY_EXPOSURE = {
  electronics: 9,
  live: 6,
  fashion: 4,
  apparel: 4,
  footwear: 4,
  accessories: 2,
  home: 2,
  fitness: 1,
  groceries: 0,
  default: 3
};

function pushSignal(signals, label, delta, detail, triggered) {
  signals.push({ label, delta, detail, triggered });
  return triggered ? delta : 0;
}

/**
 * Score the risk of one transaction.
 *
 * Every argument is optional and defaults to the benign case, so a partially
 * built transaction (e.g. mid-discovery, before a deal is frozen) still scores
 * without throwing — the Control Center needs to render at every stage, not
 * only at the end.
 *
 * @param {object}  input
 * @param {number}  input.amountInr              final deal total
 * @param {object}  input.mandate                the user's mandate (limits)
 * @param {number}  input.dailySpentInr          already spent today
 * @param {number}  input.listPriceInr           pre-negotiation list price
 * @param {number}  input.basePriceInr           post-negotiation price
 * @param {number}  input.merchantTenureDays
 * @param {boolean} input.gstVerified
 * @param {boolean} input.isCrossBorder
 * @param {number}  input.recentPurchaseCount    purchases in the recent window
 * @param {boolean} input.injectionDetected      prompt-injection seen on this request
 * @param {string}  input.category
 * @returns {{score:number, band:string, decision:string, reasons:string[],
 *            signals:Array<{label:string,delta:number,detail:string,triggered:boolean}>,
 *            thresholds:{watch:number, high:number}}}
 */
export function scoreRisk({
  amountInr = 0,
  mandate = null,
  dailySpentInr = 0,
  listPriceInr = null,
  basePriceInr = null,
  merchantTenureDays = 365,
  gstVerified = true,
  isCrossBorder = false,
  recentPurchaseCount = 0,
  injectionDetected = false,
  category = 'default'
} = {}) {
  const signals = [];
  let score = 0;

  // ---- 1. Limit proximity — how much of the per-transaction ceiling this eats.
  const maxTxn = mandate?.maxTransactionInr || 0;
  const limitRatio = maxTxn > 0 ? amountInr / maxTxn : 0;
  if (limitRatio >= 0.9) {
    score += pushSignal(signals, 'Limit proximity', 22,
      `₹${Math.round(amountInr).toLocaleString('en-IN')} is ${Math.round(limitRatio * 100)}% of your ₹${maxTxn.toLocaleString('en-IN')} per-transaction ceiling`, true);
  } else if (limitRatio >= 0.7) {
    score += pushSignal(signals, 'Limit proximity', 14,
      `Uses ${Math.round(limitRatio * 100)}% of your per-transaction ceiling`, true);
  } else if (limitRatio >= 0.5) {
    score += pushSignal(signals, 'Limit proximity', 7,
      `Uses ${Math.round(limitRatio * 100)}% of your per-transaction ceiling`, true);
  } else {
    pushSignal(signals, 'Limit proximity', 0,
      maxTxn > 0 ? `Comfortably inside your ₹${maxTxn.toLocaleString('en-IN')} ceiling` : 'No ceiling configured', false);
  }

  // ---- 2. Daily headroom — cumulative, not just this purchase in isolation.
  const dailyLimit = mandate?.dailyLimitInr || 0;
  const dayRatio = dailyLimit > 0 ? (dailySpentInr + amountInr) / dailyLimit : 0;
  if (dayRatio >= 0.9) {
    score += pushSignal(signals, 'Daily headroom', 18,
      `Would put today at ${Math.round(dayRatio * 100)}% of your ₹${dailyLimit.toLocaleString('en-IN')} daily limit`, true);
  } else if (dayRatio >= 0.7) {
    score += pushSignal(signals, 'Daily headroom', 10,
      `Would put today at ${Math.round(dayRatio * 100)}% of your daily limit`, true);
  } else {
    pushSignal(signals, 'Daily headroom', 0,
      dailyLimit > 0 ? `Today would reach ${Math.round(dayRatio * 100)}% of your daily limit` : 'No daily limit configured', false);
  }

  // ---- 3. Autonomous threshold — is this beyond "routine spend" for this user?
  const autoThreshold = mandate?.autonomousSpendThresholdInr || 0;
  if (autoThreshold > 0 && amountInr > autoThreshold) {
    score += pushSignal(signals, 'Autonomous threshold', 12,
      `Above your ₹${autoThreshold.toLocaleString('en-IN')} hands-off threshold — not a routine-size purchase`, true);
  } else {
    pushSignal(signals, 'Autonomous threshold', 0,
      autoThreshold > 0 ? `Within your ₹${autoThreshold.toLocaleString('en-IN')} hands-off threshold` : 'No autonomous threshold set', false);
  }

  // ---- 4. Price deviation — a suspiciously deep discount is a classic tell.
  //         Note the framing: negotiation is a FEATURE, so this is about depth,
  //         not about the fact that negotiation happened at all.
  if (listPriceInr && basePriceInr && listPriceInr > basePriceInr) {
    const discountPct = (listPriceInr - basePriceInr) / listPriceInr;
    if (discountPct >= 0.09) {
      score += pushSignal(signals, 'Price deviation', 12,
        `${Math.round(discountPct * 100)}% below list — at the outer edge of the enforced discount bound`, true);
    } else if (discountPct >= 0.05) {
      score += pushSignal(signals, 'Price deviation', 6,
        `${Math.round(discountPct * 100)}% below list price`, true);
    } else {
      pushSignal(signals, 'Price deviation', 0, `Only ${Math.round(discountPct * 100)}% off list — modest`, false);
    }
  } else {
    pushSignal(signals, 'Price deviation', 0, 'Paying list price — no negotiation applied', false);
  }

  // ---- 5. Merchant age.
  if (merchantTenureDays < 30) {
    score += pushSignal(signals, 'Merchant age', 18, `Merchant is only ${merchantTenureDays} days old on the platform`, true);
  } else if (merchantTenureDays < 90) {
    score += pushSignal(signals, 'Merchant age', 12, `Merchant has ${merchantTenureDays} days of history — still thin`, true);
  } else if (merchantTenureDays < 180) {
    score += pushSignal(signals, 'Merchant age', 6, `Merchant has ${merchantTenureDays} days of history`, true);
  } else {
    pushSignal(signals, 'Merchant age', 0, `Merchant has ${merchantTenureDays} days of history — established`, false);
  }

  // ---- 6. Tax verification.
  if (!gstVerified) {
    score += pushSignal(signals, 'Tax verification', 14, 'No verified GST registration on file for this merchant', true);
  } else {
    pushSignal(signals, 'Tax verification', 0, 'GST registration verified', false);
  }

  // ---- 7. Border crossing — recourse is materially weaker across borders.
  if (isCrossBorder) {
    score += pushSignal(signals, 'Border crossing', 10, 'Cross-border purchase — slower recourse if it goes wrong', true);
  } else {
    pushSignal(signals, 'Border crossing', 0, 'Domestic purchase', false);
  }

  // ---- 8. Purchase velocity — a runaway agent looks exactly like this.
  if (recentPurchaseCount >= 3) {
    score += pushSignal(signals, 'Purchase velocity', 16,
      `${recentPurchaseCount} purchases in quick succession — consistent with a runaway agent loop`, true);
  } else if (recentPurchaseCount >= 2) {
    score += pushSignal(signals, 'Purchase velocity', 8, `${recentPurchaseCount} recent purchases in a short window`, true);
  } else {
    pushSignal(signals, 'Purchase velocity', 0, 'Normal purchase pace', false);
  }

  // ---- 9. Injection attempt — if the request itself tried to manipulate the
  //         agent, the transaction is suspect regardless of how it scored.
  if (injectionDetected) {
    score += pushSignal(signals, 'Injection attempt', 25,
      'Instruction-injection pattern found in the incoming request text', true);
  } else {
    pushSignal(signals, 'Injection attempt', 0, 'No injection pattern in the request', false);
  }

  // ---- 10. Category exposure.
  const exposure = CATEGORY_EXPOSURE[category] ?? CATEGORY_EXPOSURE.default;
  if (exposure > 0) {
    score += pushSignal(signals, 'Category exposure', exposure,
      `"${category}" has above-baseline resale/chargeback exposure`, true);
  } else {
    pushSignal(signals, 'Category exposure', 0, `"${category}" is a low-exposure category`, false);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const band = score >= HIGH_THRESHOLD ? 'high' : score >= WATCH_THRESHOLD ? 'medium' : 'low';
  const decision = band === 'high' ? 'high_risk' : band === 'medium' ? 'watch' : 'clear';

  return {
    score,
    band,
    decision,
    reasons: signals.filter(s => s.triggered).map(s => s.detail),
    signals,
    thresholds: { watch: WATCH_THRESHOLD, high: HIGH_THRESHOLD }
  };
}

/**
 * Human-readable one-liner for the pipeline rail. Kept here so the wording
 * stays consistent everywhere risk is summarised.
 */
export function riskSummary(risk) {
  if (!risk) return null;
  const label = risk.band === 'high' ? 'HIGH RISK' : risk.band === 'medium' ? 'ELEVATED' : 'LOW RISK';
  const n = risk.reasons.length;
  return `${risk.score}/100 · ${label}${n ? ` · ${n} factor${n > 1 ? 's' : ''} triggered` : ' · nothing unusual'}`;
}
