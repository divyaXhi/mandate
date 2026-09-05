import assert from 'assert';
import { NegotiationEngine, NEGOTIATION_STATUS } from '../src/negotiationEngine.js';
import { buyerAgentIdentity, merchantAgentIdentity } from '../src/agentIdentity.js';
import { canPerformNegotiationAction } from '../src/agentPermissions.js';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✕ ${name}\n      ${error.message}`);
  }
}

function group(name) { console.log(`\n${name}`); }

const product = { id: 'laptop-x', name: 'Laptop X', merchant: 'TechStore AI', category: 'electronics', price_inr: 84000 };
const buyer = buyerAgentIdentity({ agentSeed: '04242', profile: { name: 'Buyer' } });
const merchant = merchantAgentIdentity(product.merchant);

function active({ now = () => Date.now(), maxRounds, expiresInMs, dealExpiresInMs } = {}) {
  const engine = new NegotiationEngine({ now, maxRounds, expiresInMs, dealExpiresInMs });
  const negotiation = engine.createSession({
    transactionId: 'TXN-1042', buyerAgent: buyer, merchantAgent: merchant,
    product, buyerMaxInr: 80000, mandateVersion: 7
  });
  return { engine, negotiation };
}

function request(engine, negotiation) {
  return engine.receiveMessage(negotiation.negotiationId, {
    senderRole: 'BUYER', type: 'PRICE_REQUEST', productId: product.id,
    requestedPriceInr: 80000, message: 'Can you do ₹80,000?'
  });
}

group('Negotiation session');
check('creates identified active session with buyer and merchant constraints', () => {
  const { negotiation } = active();
  assert.match(negotiation.negotiationId, /^NEG-/);
  assert.strictEqual(negotiation.transactionId, 'TXN-1042');
  assert.strictEqual(negotiation.buyerAgent.agentId, buyer.agentId);
  assert.strictEqual(negotiation.merchantAgent.agentId, merchant.agentId);
  assert.strictEqual(negotiation.buyerConstraints.maxPriceInr, 80000);
  assert.strictEqual(negotiation.merchantConstraints.floorInr, 75600);
  assert.strictEqual(negotiation.status, NEGOTIATION_STATUS.ACTIVE);
});

group('Structured protocol');
check('creates inspectable messages with server-owned sender and receiver', () => {
  const { engine, negotiation } = active();
  const entry = request(engine, negotiation);
  assert.match(entry.messageId, /^MSG-/);
  assert.strictEqual(entry.negotiationId, negotiation.negotiationId);
  assert.strictEqual(entry.sender.agentId, buyer.agentId);
  assert.strictEqual(entry.receiver.agentId, merchant.agentId);
  assert.strictEqual(entry.type, 'PRICE_REQUEST');
  assert.ok(entry.timestamp);
});
check('rejects a product from another negotiation', () => {
  const { engine, negotiation } = active();
  assert.throws(() => engine.receiveMessage(negotiation.negotiationId, {
    senderRole: 'BUYER', type: 'PRICE_REQUEST', productId: 'phone-y', requestedPriceInr: 80000
  }), /Cross-negotiation product mismatch/);
});

group('Agent permission boundary');
check('allows only the protocol actions assigned to each role', () => {
  assert.strictEqual(canPerformNegotiationAction('BUYER', 'ACCEPT'), true);
  assert.strictEqual(canPerformNegotiationAction('BUYER', 'OFFER'), false);
  assert.strictEqual(canPerformNegotiationAction('MERCHANT', 'OFFER'), true);
  assert.strictEqual(canPerformNegotiationAction('MERCHANT', 'PRICE_REQUEST'), false);
});
check('rejects agent impersonation before it can become a protocol message', () => {
  const { engine, negotiation } = active();
  assert.throws(() => engine.receiveMessage(negotiation.negotiationId, {
    senderRole: 'MERCHANT', type: 'PRICE_REQUEST', productId: product.id, requestedPriceInr: 80000
  }), /AGENT_ACTION_DENIED/);
  assert.strictEqual(negotiation.messages.length, 0, 'denied action must not become a negotiation message');
});

group('Buyer and merchant bounds');
check('accepts the list price and the exact 10% merchant floor', () => {
  const { engine, negotiation } = active();
  const list = engine.createOffer(negotiation.negotiationId, { productId: product.id, basePriceInr: 80000 });
  assert.strictEqual(list.validation.valid, true);
  const floor = engine.createOffer(negotiation.negotiationId, { productId: product.id, basePriceInr: 75600 });
  assert.strictEqual(floor.validation.valid, true);
});
check('rejects discount beyond merchant floor, above-list price, zero, and negative amounts', () => {
  const { engine, negotiation } = active();
  const belowFloor = engine.createOffer(negotiation.negotiationId, { productId: product.id, basePriceInr: 75599 });
  assert.strictEqual(belowFloor.validation.code, 'MERCHANT_BOUND');
  const aboveList = engine.createOffer(negotiation.negotiationId, { productId: product.id, basePriceInr: 84001 });
  assert.strictEqual(aboveList.validation.code, 'MERCHANT_BOUND');
  const zero = engine.createOffer(negotiation.negotiationId, { productId: product.id, basePriceInr: 0 });
  assert.strictEqual(zero.validation.code, 'AMOUNT_INVALID');
  const negative = engine.createOffer(negotiation.negotiationId, { productId: product.id, basePriceInr: -1 });
  assert.strictEqual(negative.validation.code, 'AMOUNT_INVALID');
});
check('rejects offers above Buyer Agent maximum without altering that maximum', () => {
  const { engine, negotiation } = active();
  const offer = engine.createOffer(negotiation.negotiationId, { productId: product.id, basePriceInr: 80001 });
  assert.strictEqual(offer.validation.code, 'BUYER_BOUND');
  assert.strictEqual(negotiation.buyerConstraints.maxPriceInr, 80000);
});

group('Bundle and state machine');
check('records a valid bundle in the all-in final amount', () => {
  const { engine, negotiation } = active();
  request(engine, negotiation);
  engine.receiveMessage(negotiation.negotiationId, { senderRole: 'BUYER', type: 'BUNDLE_REQUEST', productId: product.id, message: 'Add a bag' });
  const offer = engine.createOffer(negotiation.negotiationId, {
    productId: product.id, basePriceInr: 78999, type: 'BUNDLE_OFFER',
    bundle: { name: 'Laptop Bag', listPriceInr: 1500, priceInr: 1000 }
  });
  assert.strictEqual(offer.validation.valid, true);
  assert.strictEqual(offer.finalAmountInr, 79999);
});
check('moves ACTIVE → OFFER → COUNTER → OFFER → ACCEPTED → DEAL_CREATED', () => {
  const { engine, negotiation } = active();
  request(engine, negotiation);
  const first = engine.createOffer(negotiation.negotiationId, { productId: product.id, basePriceInr: 80000 });
  assert.strictEqual(negotiation.status, NEGOTIATION_STATUS.OFFER_SENT);
  engine.createCounterOffer(negotiation.negotiationId, { productId: product.id, requestedPriceInr: 79000 });
  assert.strictEqual(negotiation.status, NEGOTIATION_STATUS.COUNTER_OFFER);
  engine.createOffer(negotiation.negotiationId, { productId: product.id, basePriceInr: 78999 });
  assert.strictEqual(negotiation.status, NEGOTIATION_STATUS.OFFER_SENT);
  const deal = engine.acceptOffer(negotiation.negotiationId);
  assert.ok(deal.dealId);
  assert.strictEqual(negotiation.status, NEGOTIATION_STATUS.DEAL_CREATED);
  assert.throws(() => engine.createOffer(negotiation.negotiationId, { productId: product.id, basePriceInr: first.basePriceInr }), /DEAL_CREATED/);
});
check('expires and rejects follow-up acceptance', () => {
  let now = 0;
  const { engine, negotiation } = active({ now: () => now, expiresInMs: 10 });
  engine.createOffer(negotiation.negotiationId, { productId: product.id, basePriceInr: 80000 });
  now = 11;
  assert.throws(() => engine.acceptOffer(negotiation.negotiationId), /NEGOTIATION_EXPIRED/);
  assert.strictEqual(negotiation.status, NEGOTIATION_STATUS.EXPIRED);
});

group('Immutable deal and revalidation');
check('creates a frozen snapshot with fingerprint and mandate binding', () => {
  const { engine, negotiation } = active();
  const offer = engine.createOffer(negotiation.negotiationId, {
    productId: product.id, basePriceInr: 78999, type: 'BUNDLE_OFFER', bundle: { name: 'Laptop Bag', listPriceInr: 1500, priceInr: 1000 }
  });
  assert.strictEqual(offer.validation.valid, true);
  const deal = engine.acceptOffer(negotiation.negotiationId);
  assert.strictEqual(deal.status, 'PENDING_MANDATE_VALIDATION');
  assert.strictEqual(deal.pricing.finalAmountInr, 79999);
  assert.strictEqual(deal.mandateVersion, 7);
  assert.ok(deal.fingerprint);
  assert.ok(Object.isFrozen(deal));
  assert.ok(Object.isFrozen(deal.pricing));
  assert.throws(() => { deal.pricing.finalAmountInr = 89999; }, TypeError);
});
check('detects mandate, budget, amount, and bundle drift', () => {
  const { engine, negotiation } = active();
  engine.createOffer(negotiation.negotiationId, {
    productId: product.id, basePriceInr: 78999, type: 'BUNDLE_OFFER', bundle: { name: 'Laptop Bag', listPriceInr: 1500, priceInr: 1000 }
  });
  const deal = engine.acceptOffer(negotiation.negotiationId);
  const facts = { mandateVersion: 7, buyerMaxInr: 80000, productId: product.id, merchantAgentId: merchant.agentId, finalAmountInr: 79999, bundlePriceInr: 1000 };
  assert.strictEqual(engine.revalidateDeal(deal.dealId, facts).valid, true);
  assert.strictEqual(engine.revalidateDeal(deal.dealId, { ...facts, mandateVersion: 8 }).valid, false);
  assert.strictEqual(engine.revalidateDeal(deal.dealId, { ...facts, buyerMaxInr: 75000 }).valid, false);
  assert.strictEqual(engine.revalidateDeal(deal.dealId, { ...facts, finalAmountInr: 80000 }).valid, false);
  assert.strictEqual(engine.revalidateDeal(deal.dealId, { ...facts, bundlePriceInr: 0 }).valid, false);
});
check('expires a deal and blocks it during revalidation', () => {
  let now = 0;
  const { engine, negotiation } = active({ now: () => now, dealExpiresInMs: 10 });
  engine.createOffer(negotiation.negotiationId, { productId: product.id, basePriceInr: 80000 });
  const deal = engine.acceptOffer(negotiation.negotiationId);
  now = 11;
  const validation = engine.revalidateDeal(deal.dealId, {
    mandateVersion: 7, buyerMaxInr: 80000, productId: product.id,
    merchantAgentId: merchant.agentId, finalAmountInr: 80000, bundlePriceInr: 0
  });
  assert.strictEqual(validation.valid, false);
  assert.strictEqual(validation.checks.find(c => c.id === 'expiry').ok, false);
});

group('Authority boundary');
check('has no payment capability and acceptance does not execute payment', () => {
  const { engine, negotiation } = active();
  engine.createOffer(negotiation.negotiationId, { productId: product.id, basePriceInr: 80000 });
  const deal = engine.acceptOffer(negotiation.negotiationId);
  assert.strictEqual(deal.status, 'PENDING_MANDATE_VALIDATION');
  assert.strictEqual(typeof engine.executePayment, 'undefined');
  assert.strictEqual(typeof engine.authorizePayment, 'undefined');
});
check('buyer and merchant identities explicitly deny financial authority', () => {
  assert.ok(buyer.permissions.denied.includes('Modify mandate'));
  assert.ok(buyer.permissions.denied.includes('Approve payment'));
  assert.ok(merchant.permissions.denied.includes('Authorize buyer payment'));
  assert.ok(merchant.permissions.denied.includes('Bypass trust/policy checks'));
});

console.log(`\n${'─'.repeat(58)}\nNegotiation verification: ${passed} checks passed${failed ? `, ${failed} failed` : ''}.\n${'─'.repeat(58)}`);
if (failed) process.exitCode = 1;
