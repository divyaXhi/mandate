import { v4 as uuid } from 'uuid';
import { parseIntent, searchCatalog } from './agent.js';
import { buildCartMandate } from './cartMandate.js';
import { scoreConfidence } from './trustLayer.js';
import { executePayment } from './paymentMandate.js';
import { logEvent, getTrail } from './auditLog.js';

/**
 * Run one full purchase flow end to end.
 *
 * @param {string} request - natural language, e.g. "buy me a phone case under 500"
 * @param {object} options
 * @param {string} options.buyerCountry - e.g. "IN"
 * @param {boolean} options.simulateVerificationFail - force a verification mismatch, for demoing the pause case
 * @param {boolean} options.autoApprove - skip interactive confirmation (for scripted demo runs)
 */
export async function runPurchase(request, { buyerCountry = 'IN', simulateVerificationFail = false, autoApprove = true } = {}) {
  const transactionId = uuid();

  // Step 1: Intent Mandate
  const intent = parseIntent(request);
  logEvent(transactionId, 'intent_parsed', { request, intent });

  // Step 2: Search catalog
  const matches = searchCatalog(intent);
  if (matches.length === 0) {
    logEvent(transactionId, 'no_match_found', { intent });
    return { transactionId, status: 'no_match', message: 'No catalog item matched this request.' };
  }
  const item = matches[0];
  logEvent(transactionId, 'item_found', { item });

  // Step 3: Cart Mandate
  const cart = buildCartMandate(item, buyerCountry, intent.budget);
  logEvent(transactionId, 'cart_shown', { cart });

  if (!cart.withinBudget) {
    logEvent(transactionId, 'blocked_over_budget', { cart, budget: intent.budget });
    return { transactionId, status: 'blocked_over_budget', cart };
  }

  // Step 4: Trust layer scoring
  const verificationMatch = !simulateVerificationFail;
  const confidence = scoreConfidence({
    crossBorder: cart.isCrossBorder,
    verificationMatch,
    amountRatio: intent.budget ? cart.pricing.totalInr / intent.budget : 0.5,
    knownMerchant: !cart.isCrossBorder // simplification: treat domestic as "known" for demo purposes
  });
  logEvent(transactionId, 'confidence_scored', { confidence });

  if (confidence.decision === 'pause_for_reconfirmation') {
    logEvent(transactionId, 'paused_for_reconfirmation', { confidence });
    if (!autoApprove) {
      return { transactionId, status: 'paused_for_reconfirmation', cart, confidence };
    }
    // In the CLI demo, autoApprove=true simulates the user re-confirming after being shown the pause.
    logEvent(transactionId, 'user_reconfirmed_after_pause', { transactionId });
  }

  // Step 5: User approval (Cart Mandate approval + authorization proof)
  cart.approved = true;
  logEvent(transactionId, 'user_approved', {
    approvedAmountInr: cart.pricing.totalInr,
    approvedAt: new Date().toISOString(),
    // Authorization-proof field, added specifically to withstand a later
    // "the agent bought this without my okay" dispute — see project brief.
    authorizationProof: {
      transactionId,
      cartSnapshot: cart,
      approvalMethod: 'explicit_cart_confirmation'
    }
  });

  // Step 6: Payment Mandate
  let paymentResult;
  try {
    paymentResult = await executePayment(cart, cart.pricing.totalInr);
    logEvent(transactionId, 'payment_executed', paymentResult);
  } catch (err) {
    logEvent(transactionId, 'payment_blocked', { error: err.message });
    return { transactionId, status: 'payment_blocked', error: err.message };
  }

  return {
    transactionId,
    status: 'success',
    item,
    cart,
    confidence,
    payment: paymentResult,
    auditTrail: getTrail(transactionId)
  };
}
