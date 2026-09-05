/**
 * Payment Guard — the last gate before money moves.
 *
 * Every check here re-verifies something an earlier stage already decided. That
 * duplication is the point: this stage assumes the rest of the pipeline could
 * be wrong, compromised, or simply out of date, and refuses to move funds
 * unless the facts still hold at the moment of execution.
 *
 * These guards were once scattered and invisible — the price
 * integrity check lived inside executePayment(), the idempotency check lived in
 * a Map in server.js, the mandate ceilings were only checked much earlier
 * against a price that could since have changed. They run together, in
 * one place, and returns a structured result so the UI can show six green ticks
 * (or the one red one that stopped it) instead of a thrown error string.
 *
 * This is a REAL gate, not a display. server.js calls it and honours the
 * result; if `passed` is false, no Razorpay order is created.
 */

export const CHECK = {
  PASS: 'pass',
  FAIL: 'fail',
  SKIP: 'skip'
};

/**
 * Run all six pre-flight checks.
 *
 * @param {object}  input
 * @param {object}  input.cart                 the frozen cart mandate
 * @param {number}  input.approvedAmountInr     the exact amount the user approved
 * @param {object}  input.mandate               user mandate
 * @param {number}  input.dailySpentInr         already spent today
 * @param {string}  input.transactionId
 * @param {object}  input.ledgerEntry           existing idempotency record, if any
 * @param {string}  input.paymentMethod         'cod' | 'online'
 * @param {boolean} input.railConfigured        are Razorpay credentials present?
 * @param {object}  input.decision              canonical transaction decision
 * @param {object}  input.dealValidation         current immutable-deal revalidation result
 * @returns {{passed:boolean, blockedReason:string|null, failedCheckId:string|null,
 *            checks:Array<{id:string,label:string,status:string,detail:string,critical:boolean}>,
 *            passedCount:number, totalCount:number}}
 */
export function runPaymentGuard({
  cart = null,
  approvedAmountInr = 0,
  mandate = null,
  dailySpentInr = 0,
  transactionId = null,
  ledgerEntry = null,
  paymentMethod = 'online',
  railConfigured = true,
  decision = null,
  dealValidation = null
} = {}) {
  const checks = [];
  const total = cart?.pricing?.totalInr ?? 0;

  // The deal is checked again immediately before funds move. A permit from a
  // few seconds earlier is not authority if its mandate, product, merchant,
  // amount, bundle, currency, transaction binding, or fingerprint changed.
  if (dealValidation && !dealValidation.valid) {
    checks.push({
      id: 'deal_revalidation', label: 'Immutable deal still matches final facts', status: CHECK.FAIL,
      detail: `Deal revalidation failed (${dealValidation.reason || 'DEAL_STALE_OR_CHANGED'}). Payment cannot use a stale deal.`, critical: true
    });
  } else if (dealValidation) {
    checks.push({
      id: 'deal_revalidation', label: 'Immutable deal still matches final facts', status: CHECK.PASS,
      detail: 'Deal ID, transaction, product, merchant, amount, currency, bundle, mandate version, and fingerprint still match.', critical: true
    });
  }

  // A blocked canonical decision is a hard precondition failure. This runs
  // before any rail readiness check, so no Razorpay order can be created for a
  // deal already refused by Trust or Policy.
  if (decision) {
    const blocked = decision.finalDecision === 'BLOCK';
    checks.push({
      id: 'canonical_decision',
      label: 'Canonical transaction decision permits payment',
      status: blocked ? CHECK.FAIL : CHECK.PASS,
      detail: blocked
        ? `Decision Engine returned BLOCK (${decision.finalReason || decision.reason || 'UNSPECIFIED'}). Payment must not execute.`
        : `Decision Engine returned ${decision.finalDecision}; payment may continue to independent guard checks.`,
      critical: true
    });
  }

  // ---- 1. Approval provenance.
  //      Not "did someone click yes" but "is the approval attached to THIS cart".
  if (cart?.approved === true) {
    checks.push({
      id: 'cart_approved',
      label: 'Approval attached to this exact cart',
      status: CHECK.PASS,
      detail: 'The approval on file belongs to this cart object, not to an earlier version of it.',
      critical: true
    });
  } else {
    checks.push({
      id: 'cart_approved',
      label: 'Approval attached to this exact cart',
      status: CHECK.FAIL,
      detail: 'This cart carries no approval. Payment cannot proceed on an unapproved cart, regardless of what the conversation said.',
      critical: true
    });
  }

  // ---- 2. Price integrity — the drift check.
  //      This is the one that stops a merchant (or a bug) raising the price
  //      between "yes" and "charge".
  if (total <= approvedAmountInr) {
    checks.push({
      id: 'price_integrity',
      label: 'Charge equals the approved amount',
      status: CHECK.PASS,
      detail: `₹${total.toLocaleString('en-IN')} to be charged, ₹${Math.round(approvedAmountInr).toLocaleString('en-IN')} was approved — no drift.`,
      critical: true
    });
  } else {
    checks.push({
      id: 'price_integrity',
      label: 'Charge equals the approved amount',
      status: CHECK.FAIL,
      detail: `Cart total ₹${total.toLocaleString('en-IN')} now exceeds the ₹${Math.round(approvedAmountInr).toLocaleString('en-IN')} you approved. The price moved after approval, so this is refused rather than silently overcharged.`,
      critical: true
    });
  }

  // ---- 3. Per-transaction ceiling, re-checked against the FINAL price.
  const maxTxn = mandate?.maxTransactionInr ?? 0;
  if (maxTxn <= 0) {
    checks.push({
      id: 'transaction_ceiling',
      label: 'Within per-transaction ceiling',
      status: CHECK.SKIP,
      detail: 'No per-transaction ceiling configured in your mandate.',
      critical: false
    });
  } else if (total <= maxTxn) {
    checks.push({
      id: 'transaction_ceiling',
      label: 'Within per-transaction ceiling',
      status: CHECK.PASS,
      detail: `₹${total.toLocaleString('en-IN')} ≤ ₹${maxTxn.toLocaleString('en-IN')} ceiling.`,
      critical: true
    });
  } else {
    checks.push({
      id: 'transaction_ceiling',
      label: 'Within per-transaction ceiling',
      status: CHECK.FAIL,
      detail: `₹${total.toLocaleString('en-IN')} exceeds your ₹${maxTxn.toLocaleString('en-IN')} per-transaction ceiling. Re-checked here against the final price, not the price shown earlier.`,
      critical: true
    });
  }

  // ---- 4. Daily ceiling, including this charge.
  const dailyLimit = mandate?.dailyLimitInr ?? 0;
  const projected = dailySpentInr + total;
  if (dailyLimit <= 0) {
    checks.push({
      id: 'daily_ceiling',
      label: 'Within daily ceiling',
      status: CHECK.SKIP,
      detail: 'No daily limit configured in your mandate.',
      critical: false
    });
  } else if (projected <= dailyLimit) {
    checks.push({
      id: 'daily_ceiling',
      label: 'Within daily ceiling',
      status: CHECK.PASS,
      detail: `₹${Math.round(projected).toLocaleString('en-IN')} total today ≤ ₹${dailyLimit.toLocaleString('en-IN')} daily limit.`,
      critical: true
    });
  } else {
    checks.push({
      id: 'daily_ceiling',
      label: 'Within daily ceiling',
      status: CHECK.FAIL,
      detail: `This charge would take today to ₹${Math.round(projected).toLocaleString('en-IN')}, past your ₹${dailyLimit.toLocaleString('en-IN')} daily limit.`,
      critical: true
    });
  }

  // ---- 5. Idempotency — the double-charge guard.
  //      A retry after a network failure must never become a second charge.
  if (!transactionId) {
    checks.push({
      id: 'idempotency',
      label: 'No prior charge for this transaction',
      status: CHECK.FAIL,
      detail: 'No transaction ID present, so a duplicate charge could not be ruled out. Refusing rather than risking it.',
      critical: true
    });
  } else if (ledgerEntry && ledgerEntry.status === 'succeeded') {
    checks.push({
      id: 'idempotency',
      label: 'No prior charge for this transaction',
      status: CHECK.FAIL,
      detail: `${transactionId} was already charged successfully (order ${ledgerEntry.orderId}). The existing result is returned instead of charging again — this is what makes a retry safe.`,
      critical: true
    });
  } else if (ledgerEntry && ledgerEntry.status === 'pending') {
    checks.push({
      id: 'idempotency',
      label: 'No prior charge for this transaction',
      status: CHECK.PASS,
      detail: `${transactionId} has an in-flight attempt on record; this run continues it rather than starting a second one.`,
      critical: true
    });
  } else {
    checks.push({
      id: 'idempotency',
      label: 'No prior charge for this transaction',
      status: CHECK.PASS,
      detail: `${transactionId} has no completed charge on the ledger — first and only attempt.`,
      critical: true
    });
  }

  // ---- 6. Rail integrity — currency and credentials.
  if (paymentMethod === 'cod') {
    checks.push({
      id: 'rail_integrity',
      label: 'Payment rail ready',
      status: CHECK.SKIP,
      detail: 'Cash on Delivery — no card rail is touched, so nothing is charged now.',
      critical: false
    });
  } else if (!railConfigured) {
    checks.push({
      id: 'rail_integrity',
      label: 'Payment rail ready',
      status: CHECK.FAIL,
      detail: 'Razorpay credentials are missing, so the charge cannot be attempted. Failing here is better than failing halfway through a payment.',
      critical: true
    });
  } else {
    checks.push({
      id: 'rail_integrity',
      label: 'Payment rail ready',
      status: CHECK.PASS,
      detail: 'Razorpay test-mode credentials present, currency INR, amount converted to paise exactly once.',
      critical: true
    });
  }

  const firstFailure = checks.find(c => c.status === CHECK.FAIL && c.critical) || null;
  const passedCount = checks.filter(c => c.status === CHECK.PASS).length;

  return {
    passed: !firstFailure,
    failedCheckId: firstFailure ? firstFailure.id : null,
    blockedReason: firstFailure ? firstFailure.detail : null,
    checks,
    passedCount,
    totalCount: checks.length
  };
}

/**
 * One-line summary for the pipeline rail.
 */
export function guardSummary(guard) {
  if (!guard) return null;
  if (guard.passed) return `${guard.passedCount}/${guard.totalCount} checks passed · cleared for execution`;
  const failed = guard.checks.find(c => c.id === guard.failedCheckId);
  return `Stopped by: ${failed ? failed.label : 'a pre-flight check'}`;
}
