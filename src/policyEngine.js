/**
 * Policy Engine — deterministic, rule-based enforcement of a user's spending
 * mandate. This is intentionally NOT part of trustLayer.js: the trust layer
 * scores how *risky* a purchase looks (a judgment call, built from weighted
 * signals). The policy engine checks whether a purchase is even *allowed* at
 * all under limits the user has set (a fact, not a judgment).
 *
 * The core architectural claim this embodies: the agent (or an LLM) can
 * PROPOSE a purchase, but only this deterministic engine — never a model —
 * DISPOSES whether money is allowed to move. Nothing here is a heuristic or
 * a score; every check is a plain comparison against a fixed limit.
 */

export const DEFAULT_MANDATE = {
  maxTransactionInr: 10000,       // hard ceiling per single purchase — never overridable
  dailyLimitInr: 20000,           // cumulative spend allowed per calendar day
  autonomousSpendThresholdInr: 2000, // above this, explicit human approval is always required regardless of trust score
  blockedCategories: ['gambling', 'financial'],
  allowedCategories: [],          // empty = all categories allowed except blockedCategories
  allowCrossBorder: true          // cross-border purchases are allowed, but always flagged for human approval
};

/**
 * @param {object} params
 * @param {number} params.amountInr
 * @param {string} params.category
 * @param {boolean} params.isCrossBorder
 * @param {object} params.mandate - a mandate object (see DEFAULT_MANDATE shape)
 * @param {number} params.dailySpentInr - amount already spent today (before this purchase)
 * @returns {{ decision: 'blocked'|'human_approval_required'|'approved', violations: string[], flags: string[] }}
 */
export function evaluatePolicy({ amountInr, category, isCrossBorder, mandate, dailySpentInr = 0 }) {
  const m = mandate || DEFAULT_MANDATE;
  const violations = [];
  const flags = [];

  if (amountInr > m.maxTransactionInr) {
    violations.push(`Amount ₹${amountInr} exceeds your per-transaction maximum of ₹${m.maxTransactionInr}`);
  }

  if (m.blockedCategories.includes(category)) {
    violations.push(`Category "${category}" is on your blocked list`);
  }

  if (m.allowedCategories.length > 0 && !m.allowedCategories.includes(category)) {
    violations.push(`Category "${category}" is not on your allowed list`);
  }

  if (dailySpentInr + amountInr > m.dailyLimitInr) {
    violations.push(`This would bring today's spend to ₹${dailySpentInr + amountInr}, over your daily limit of ₹${m.dailyLimitInr}`);
  }

  if (isCrossBorder && !m.allowCrossBorder) {
    violations.push(`Cross-border purchases are disabled on your mandate`);
  }

  if (violations.length > 0) {
    return { decision: 'blocked', violations, flags };
  }

  if (isCrossBorder) {
    flags.push('Cross-border purchase — flagged for human approval');
  }
  if (amountInr > m.autonomousSpendThresholdInr) {
    flags.push(`Amount exceeds your autonomous-spend threshold of ₹${m.autonomousSpendThresholdInr} — human approval required`);
  }

  return {
    decision: flags.length > 0 ? 'human_approval_required' : 'approved',
    violations: [],
    flags
  };
}

/** Sum of a session's completed-today transactions, for the daily-limit check. */
export function dailySpent(transactions) {
  const today = new Date().toDateString();
  return transactions
    .filter(t => new Date(t.completedAt).toDateString() === today)
    .reduce((sum, t) => sum + (t.paymentResult?.amountInr || 0), 0);
}
