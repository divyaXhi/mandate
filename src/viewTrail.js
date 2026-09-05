import { getTrail } from './auditLog.js';

const STEP_LABELS = {
  intent_parsed: '🎯 Intent parsed',
  item_found: '🔍 Item found',
  no_match_found: '❌ No match found',
  cart_shown: '🛒 Cart shown to user',
  blocked_over_budget: '🚫 Blocked — over budget',
  confidence_scored: '📊 Confidence scored',
  paused_for_reconfirmation: '⏸️  Paused — low confidence',
  user_reconfirmed_after_pause: '✅ User re-confirmed',
  user_approved: '✍️  User approved cart',
  payment_executed: '💳 Payment executed',
  payment_blocked: '🚫 Payment blocked',
};

function formatStep(entry) {
  const label = STEP_LABELS[entry.step] || entry.step;
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const lines = [`  ${time}  ${label}`];

  switch (entry.step) {
    case 'intent_parsed':
      lines.push(`           "${entry.details.request}"`);
      lines.push(`           → looking for: ${entry.details.intent.query}, budget ≤ ₹${entry.details.intent.budget ?? '∞'}`);
      break;
    case 'item_found':
      lines.push(`           ${entry.details.item.name} — ₹${entry.details.item.price_inr} (${entry.details.item.merchant}, ${entry.details.item.origin_country})`);
      break;
    case 'cart_shown': {
      const c = entry.details.cart;
      lines.push(`           ${c.item.name} — ₹${c.pricing.basePriceInr}${c.pricing.crossBorderFeeInr ? ` + ₹${c.pricing.crossBorderFeeInr} fee` : ''} = ₹${c.pricing.totalInr}`);
      lines.push(`           ${c.pricing.displayCurrencyNote}`);
      break;
    }
    case 'confidence_scored': {
      const conf = entry.details.confidence;
      lines.push(`           score: ${conf.score}/100 (threshold: ${conf.threshold}) → ${conf.decision}`);
      conf.reasons.forEach(r => lines.push(`           • ${r}`));
      break;
    }
    case 'user_approved':
      lines.push(`           approved amount: ₹${entry.details.approvedAmountInr}`);
      lines.push(`           method: ${entry.details.authorizationProof.approvalMethod}`);
      break;
    case 'payment_executed':
      lines.push(`           order ${entry.details.orderId} — ₹${entry.details.amountInr} (${entry.details.status})`);
      break;
    case 'payment_blocked':
      lines.push(`           reason: ${entry.details.error}`);
      break;
  }

  return lines.join('\n');
}

/**
 * Print a clean, human-readable version of a transaction's audit trail.
 * This is the version you actually want to show in a demo or pitch video —
 * the raw JSON in getTrail() is still there underneath for anyone who wants it.
 */
export function printTrail(transactionId) {
  const trail = getTrail(transactionId);
  if (trail.length === 0) {
    console.log(`No audit trail found for transaction ${transactionId}`);
    return;
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`AUDIT TRAIL — ${transactionId}`);
  console.log('─'.repeat(60));
  trail.forEach(entry => console.log(formatStep(entry)));
  console.log('─'.repeat(60) + '\n');
}
