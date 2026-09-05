import assert from 'assert';
import { NegotiationEngine } from '../src/negotiationEngine.js';
import { buyerAgentIdentity, merchantAgentIdentity } from '../src/agentIdentity.js';
import { buildCartMandate } from '../src/cartMandate.js';
import { scoreConfidence } from '../src/trustLayer.js';
import { scoreRisk } from '../src/riskEngine.js';
import { evaluatePolicy } from '../src/policyEngine.js';
import { evaluateApproval } from '../src/approvalGate.js';
import { runPaymentGuard } from '../src/paymentGuard.js';

const mandate = {
  maxTransactionInr: 80000,
  dailyLimitInr: 100000,
  autonomousSpendThresholdInr: 2000,
  blockedCategories: ['gambling', 'financial'],
  allowedCategories: [],
  allowCrossBorder: true
};
const product = {
  id: 'laptop-x', name: 'Laptop X', merchant: 'TechStore AI', category: 'electronics',
  price_inr: 84000, origin_country: 'IN', merchant_tenure_days: 1200, gst_verified: true,
  merchant_rating: 4.8, merchant_order_count: 5400, dispute_rate: 0.004
};
const buyer = buyerAgentIdentity({ agentSeed: '04242', profile: { name: 'E2E Tester' } });
const merchant = merchantAgentIdentity(product.merchant);
const engine = new NegotiationEngine();
const negotiation = engine.createSession({
  transactionId: 'TXN-E2E-1042', buyerAgent: buyer, merchantAgent: merchant,
  product, buyerMaxInr: 80000, mandateVersion: 7
});

// USER INTENT -> BUYER REQUEST -> MERCHANT OFFER -> BUYER COUNTER -> BUNDLE -> ACCEPT.
engine.receiveMessage(negotiation.negotiationId, {
  senderRole: 'BUYER', type: 'PRICE_REQUEST', productId: product.id,
  requestedPriceInr: 80000, message: 'Can you get this under ₹80,000?'
});
engine.createOffer(negotiation.negotiationId, { productId: product.id, basePriceInr: 80000, message: 'I can do ₹80,000.' });
engine.createCounterOffer(negotiation.negotiationId, { productId: product.id, requestedPriceInr: 79000, message: 'Buyer counters at ₹79,000.' });
const offer = engine.createOffer(negotiation.negotiationId, {
  productId: product.id, basePriceInr: 78999, type: 'BUNDLE_OFFER',
  bundle: { name: 'Laptop Bag', listPriceInr: 1500, priceInr: 1000 },
  message: 'Laptop plus bag totals ₹79,999.'
});
assert.strictEqual(offer.validation.valid, true, 'the final merchant offer must pass both agent bounds');
const deal = engine.acceptOffer(negotiation.negotiationId);

// IMMUTABLE DEAL -> MANDATE -> TRUST/RISK/POLICY -> APPROVAL -> PAYMENT GUARD.
assert.strictEqual(deal.status, 'PENDING_MANDATE_VALIDATION');
assert.ok(Object.isFrozen(deal), 'accepted deal is immutable');
assert.strictEqual(deal.pricing.finalAmountInr, 79999);
const revalidation = engine.revalidateDeal(deal.dealId, {
  mandateVersion: 7, buyerMaxInr: 80000, productId: product.id,
  merchantAgentId: merchant.agentId, finalAmountInr: 79999, bundlePriceInr: 1000
});
assert.strictEqual(revalidation.valid, true);

const cart = buildCartMandate(product, 'IN', null, deal.pricing.negotiatedPriceInr);
cart.pricing.bundlePriceInr = deal.pricing.bundlePriceInr;
cart.pricing.totalInr = deal.pricing.finalAmountInr;
const trust = scoreConfidence({
  crossBorder: false, verificationMatch: true, amountRatio: 79999 / 80000,
  knownMerchant: true, merchantTenureDays: 1200, gstVerified: true,
  category: product.category, recentPurchaseCount: 0
});
const risk = scoreRisk({ amountInr: deal.pricing.finalAmountInr, mandate, merchantTenureDays: 1200, gstVerified: true, category: product.category });
const policy = evaluatePolicy({ amountInr: deal.pricing.finalAmountInr, category: product.category, isCrossBorder: false, mandate });
const approval = evaluateApproval({ amountInr: deal.pricing.finalAmountInr, mandate, trust, risk, policy });
assert.notStrictEqual(policy.decision, 'blocked');
assert.strictEqual(approval.allowed, true);

// Critical claim: deal acceptance never supplies approval provenance, so
// Payment Guard still blocks. No payment order can be created from this test.
const guardBeforeApproval = runPaymentGuard({
  cart, approvedAmountInr: deal.pricing.finalAmountInr, mandate,
  transactionId: deal.transactionId, paymentMethod: 'cod'
});
assert.strictEqual(guardBeforeApproval.passed, false);
assert.strictEqual(guardBeforeApproval.failedCheckId, 'cart_approved');
assert.strictEqual(typeof engine.executePayment, 'undefined');

console.log('✓ E2E negotiation: deal accepted -> validated -> policy/approval evaluated -> payment still blocked until user approval');
