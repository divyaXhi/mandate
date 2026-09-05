import crypto from 'crypto';
import { enforceNegotiationBound } from './agentIdentity.js';
import { assertNegotiationPermission } from './agentPermissions.js';

export const NEGOTIATION_STATUS = Object.freeze({
  CREATED: 'CREATED', ACTIVE: 'ACTIVE', OFFER_SENT: 'OFFER_SENT',
  COUNTER_OFFER: 'COUNTER_OFFER', ACCEPTED: 'ACCEPTED', DEAL_CREATED: 'DEAL_CREATED',
  REJECTED: 'REJECTED', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED', FAILED: 'FAILED'
});

export const MESSAGE_TYPES = Object.freeze([
  'PRICE_REQUEST', 'OFFER', 'COUNTER_OFFER', 'BUNDLE_REQUEST', 'BUNDLE_OFFER',
  'ACCEPT', 'REJECT', 'CANCEL', 'EXPIRE'
]);

const TERMINAL = new Set([
  NEGOTIATION_STATUS.DEAL_CREATED, NEGOTIATION_STATUS.REJECTED,
  NEGOTIATION_STATUS.CANCELLED, NEGOTIATION_STATUS.EXPIRED, NEGOTIATION_STATUS.FAILED
]);

function positiveInr(value) {
  return Number.isInteger(value) && value > 0;
}

function immutable(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(immutable);
  return value;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16).toUpperCase();
}

/**
 * The only owner of the Buyer Agent <-> Merchant Agent protocol. This class
 * deliberately has no mandate-mutation, approval, payment, or Razorpay API.
 * A deal it creates is only a proposal for MANDATE to validate.
 */
export class NegotiationEngine {
  constructor({ now = () => Date.now(), maxRounds = 6, expiresInMs = 5 * 60 * 1000, dealExpiresInMs = 15 * 60 * 1000 } = {}) {
    this.now = now;
    this.maxRounds = maxRounds;
    this.expiresInMs = expiresInMs;
    this.dealExpiresInMs = dealExpiresInMs;
    this.sessions = new Map();
    this.deals = new Map();
    this.sequence = 1041;
  }

  createSession({ transactionId, buyerAgent, merchantAgent, product, buyerMaxInr, mandateVersion }) {
    if (!transactionId || !buyerAgent?.agentId || !merchantAgent?.agentId || !product?.id || !positiveInr(product.price_inr) || !positiveInr(buyerMaxInr)) {
      throw new Error('Negotiation requires a transaction, identified agents, product, and positive buyer maximum');
    }
    const now = this.now();
    const floor = enforceNegotiationBound(product.price_inr, 0).enforcedPriceInr;
    const negotiation = {
      negotiationId: `NEG-${++this.sequence}`,
      transactionId,
      buyerAgent: immutable({ agentId: buyerAgent.agentId, role: 'BUYER', owner: buyerAgent.owner }),
      merchantAgent: immutable({ agentId: merchantAgent.agentId, role: 'MERCHANT', owner: merchantAgent.owner }),
      product: immutable({ id: product.id, name: product.name, merchant: product.merchant, category: product.category, listPriceInr: product.price_inr }),
      buyerConstraints: immutable({ maxPriceInr: buyerMaxInr, currency: 'INR' }),
      merchantConstraints: immutable({ listPriceInr: product.price_inr, maxDiscountPct: 10, floorInr: floor }),
      mandateVersion,
      status: NEGOTIATION_STATUS.ACTIVE,
      rounds: 0,
      messages: [],
      offers: [],
      currentOffer: null,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.expiresInMs).toISOString()
    };
    this.sessions.set(negotiation.negotiationId, negotiation);
    return negotiation;
  }

  getSession(id) { return this.sessions.get(id) || null; }
  getDeal(id) { return this.deals.get(id) || null; }

  expireNegotiation(negotiation) {
    if (!negotiation || TERMINAL.has(negotiation.status) || this.now() <= Date.parse(negotiation.expiresAt)) return negotiation;
    negotiation.status = NEGOTIATION_STATUS.EXPIRED;
    this._message(negotiation, 'SYSTEM', 'EXPIRE', { message: 'Negotiation expired before a deal was accepted.' });
    return negotiation;
  }

  receiveMessage(negotiationId, { senderRole, type, productId, requestedPriceInr = null, bundleRequest = null, message = '' } = {}) {
    const n = this._active(negotiationId);
    if (!MESSAGE_TYPES.includes(type)) throw new Error('Unsupported negotiation message type');
    if (!['BUYER', 'MERCHANT'].includes(senderRole)) throw new Error('Sender role is server-controlled');
    if (productId !== n.product.id) throw new Error('Cross-negotiation product mismatch');
    assertNegotiationPermission(senderRole, type);
    if (type === 'CANCEL') return this.cancelNegotiation(negotiationId);
    if (type === 'REJECT') return this.rejectOffer(negotiationId, senderRole, message);
    if (type === 'ACCEPT') return this.acceptOffer(negotiationId);
    if (type === 'COUNTER_OFFER' && senderRole === 'BUYER') return this.createCounterOffer(negotiationId, { productId, requestedPriceInr, message });
    return this._message(n, senderRole, type, { productId, requestedPriceInr, bundleRequest, message });
  }

  validateOffer(negotiation, offer) {
    if (!negotiation || negotiation.status === NEGOTIATION_STATUS.EXPIRED || TERMINAL.has(negotiation.status)) return invalid('NEGOTIATION_NOT_ACTIVE', 'Negotiation is not active.');
    if (offer.negotiationId !== negotiation.negotiationId) return invalid('NEGOTIATION_MISMATCH', 'Offer belongs to another negotiation.');
    if (offer.productId !== negotiation.product.id) return invalid('PRODUCT_MISMATCH', 'Offer product does not match the negotiated product.');
    if (offer.currency !== 'INR') return invalid('CURRENCY_INVALID', 'Only INR offers are accepted.');
    if (!positiveInr(offer.basePriceInr)) return invalid('AMOUNT_INVALID', 'Offer price must be a positive whole INR amount.');
    if (offer.bundle && (!offer.bundle.name || !positiveInr(offer.bundle.listPriceInr) || !Number.isInteger(offer.bundle.priceInr) || offer.bundle.priceInr < 0 || offer.bundle.priceInr > offer.bundle.listPriceInr)) {
      return invalid('BUNDLE_INVALID', 'Bundle must have a name and a valid price not above its list price.');
    }
    const merchant = enforceNegotiationBound(negotiation.product.listPriceInr, offer.basePriceInr);
    if (!merchant.allowed) return invalid('MERCHANT_BOUND', merchant.reason, { merchant });
    const finalAmountInr = offer.basePriceInr + (offer.bundle?.priceInr || 0);
    if (finalAmountInr > negotiation.buyerConstraints.maxPriceInr) return invalid('BUYER_BOUND', `Final ₹${finalAmountInr} exceeds Buyer Agent maximum ₹${negotiation.buyerConstraints.maxPriceInr}.`, { finalAmountInr });
    return { valid: true, code: 'VALID', reason: null, finalAmountInr, merchant };
  }

  createOffer(negotiationId, { productId, basePriceInr, currency = 'INR', bundle = null, message = '', type = 'OFFER' } = {}) {
    const n = this._active(negotiationId);
    if (!['OFFER', 'COUNTER_OFFER', 'BUNDLE_OFFER'].includes(type)) throw new Error('Invalid offer type');
    assertNegotiationPermission('MERCHANT', type);
    this._incrementRound(n);
    const offer = {
      offerId: `OFR-${n.negotiationId.slice(4)}-${String(n.offers.length + 1).padStart(3, '0')}`,
      negotiationId: n.negotiationId,
      productId,
      createdByAgent: immutable({ agentId: n.merchantAgent.agentId, role: 'MERCHANT' }),
      type,
      basePriceInr,
      currency,
      bundle: bundle ? immutable({ name: bundle.name, listPriceInr: bundle.listPriceInr, priceInr: bundle.priceInr }) : null,
      createdAt: new Date(this.now()).toISOString()
    };
    offer.validation = immutable(this.validateOffer(n, offer));
    offer.finalAmountInr = offer.validation.finalAmountInr ?? null;
    immutable(offer);
    n.offers.push(offer);
    n.currentOffer = offer;
    n.status = offer.validation.valid ? NEGOTIATION_STATUS.OFFER_SENT : NEGOTIATION_STATUS.ACTIVE;
    this._message(n, 'MERCHANT', type, { productId, requestedPriceInr: basePriceInr, bundleRequest: bundle, message, offerId: offer.offerId, validation: offer.validation });
    return offer;
  }

  createCounterOffer(negotiationId, { productId, requestedPriceInr, message = '' } = {}) {
    const n = this._active(negotiationId);
    assertNegotiationPermission('BUYER', 'COUNTER_OFFER');
    if (productId !== n.product.id) throw new Error('Cross-negotiation product mismatch');
    if (!positiveInr(requestedPriceInr) || requestedPriceInr > n.buyerConstraints.maxPriceInr) throw new Error('BUYER_BOUND');
    this._incrementRound(n);
    n.status = NEGOTIATION_STATUS.COUNTER_OFFER;
    return this._message(n, 'BUYER', 'COUNTER_OFFER', { productId, requestedPriceInr, message: message || `Buyer counters at ₹${requestedPriceInr}.` });
  }

  acceptOffer(negotiationId) {
    const n = this._active(negotiationId);
    assertNegotiationPermission('BUYER', 'ACCEPT');
    const offer = n.currentOffer;
    if (!offer || !offer.validation?.valid) throw new Error('No valid merchant offer is available to accept');
    n.status = NEGOTIATION_STATUS.ACCEPTED;
    this._message(n, 'BUYER', 'ACCEPT', { productId: n.product.id, requestedPriceInr: offer.finalAmountInr, offerId: offer.offerId, message: `Buyer Agent accepted ${offer.offerId}.` });
    return this.createDeal(n);
  }

  rejectOffer(negotiationId, senderRole = 'BUYER', message = '') {
    const n = this._active(negotiationId);
    assertNegotiationPermission(senderRole, 'REJECT');
    n.status = NEGOTIATION_STATUS.REJECTED;
    this._message(n, senderRole, 'REJECT', { productId: n.product.id, message: message || 'Offer rejected.' });
    return n;
  }

  cancelNegotiation(negotiationId) {
    const n = this._active(negotiationId);
    assertNegotiationPermission('BUYER', 'CANCEL');
    n.status = NEGOTIATION_STATUS.CANCELLED;
    this._message(n, 'BUYER', 'CANCEL', { productId: n.product.id, message: 'Buyer cancelled negotiation.' });
    return n;
  }

  createDeal(n) {
    if (n.status !== NEGOTIATION_STATUS.ACCEPTED || !n.currentOffer?.validation?.valid) throw new Error('Only an accepted valid offer can create a deal');
    const offer = n.currentOffer;
    const snapshot = {
      dealId: `DEAL-${n.negotiationId.slice(4)}`,
      negotiationId: n.negotiationId,
      transactionId: n.transactionId,
      buyerAgentId: n.buyerAgent.agentId,
      merchantAgentId: n.merchantAgent.agentId,
      product: immutable({ id: n.product.id, name: n.product.name, merchant: n.product.merchant, quantity: 1 }),
      pricing: immutable({ listPriceInr: n.product.listPriceInr, negotiatedPriceInr: offer.basePriceInr, bundlePriceInr: offer.bundle?.priceInr || 0, finalAmountInr: offer.finalAmountInr, currency: 'INR' }),
      bundle: offer.bundle,
      mandateVersion: n.mandateVersion,
      status: 'PENDING_MANDATE_VALIDATION',
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.dealExpiresInMs).toISOString()
    };
    snapshot.fingerprint = fingerprint({ negotiationId: snapshot.negotiationId, product: snapshot.product, pricing: snapshot.pricing, bundle: snapshot.bundle, mandateVersion: snapshot.mandateVersion });
    const deal = immutable(snapshot);
    this.deals.set(deal.dealId, deal);
    n.status = NEGOTIATION_STATUS.DEAL_CREATED;
    this._message(n, 'SYSTEM', 'ACCEPT', { productId: n.product.id, dealId: deal.dealId, message: `Immutable ${deal.dealId} created; it is pending MANDATE validation.` });
    return deal;
  }

  revalidateDeal(dealId, { mandateVersion, buyerMaxInr, transactionId, productId, merchantAgentId, finalAmountInr, currency, bundlePriceInr, fingerprint: suppliedFingerprint } = {}) {
    const deal = this.getDeal(dealId);
    if (!deal) throw new Error('Unknown deal');
    const checks = [
      check('expiry', this.now() <= Date.parse(deal.expiresAt), `Deal expires at ${deal.expiresAt}`),
      check('transaction', transactionId === undefined || transactionId === deal.transactionId, 'Transaction must not change'),
      check('mandateVersion', deal.mandateVersion === mandateVersion, `Deal v${deal.mandateVersion}; current mandate v${mandateVersion}`),
      check('buyerBudget', positiveInr(buyerMaxInr) && deal.pricing.finalAmountInr <= buyerMaxInr, `Final ₹${deal.pricing.finalAmountInr}; buyer maximum ₹${buyerMaxInr}`),
      check('product', !productId || productId === deal.product.id, 'Product must not change'),
      check('merchant', !merchantAgentId || merchantAgentId === deal.merchantAgentId, 'Merchant must not change'),
      check('amount', !finalAmountInr || finalAmountInr === deal.pricing.finalAmountInr, 'Final amount must not change'),
      check('currency', currency === undefined || currency === deal.pricing.currency, 'Currency must not change'),
      check('bundle', bundlePriceInr === undefined || bundlePriceInr === deal.pricing.bundlePriceInr, 'Bundle must not change'),
      check('fingerprint', suppliedFingerprint === undefined || suppliedFingerprint === deal.fingerprint, 'Deal fingerprint must not change')
    ];
    const valid = checks.every(item => item.ok);
    return { dealId, valid, status: valid ? 'VALID' : 'INVALIDATED', checks, reason: valid ? null : 'DEAL_STALE_OR_CHANGED' };
  }

  _incrementRound(n) {
    n.rounds += 1;
    if (n.rounds > this.maxRounds) {
      n.status = NEGOTIATION_STATUS.REJECTED;
      this._message(n, 'SYSTEM', 'REJECT', { message: 'Negotiation round limit reached.' });
      throw new Error('NEGOTIATION_LIMIT_REACHED');
    }
  }

  _active(id) {
    const n = this.getSession(id);
    if (!n) throw new Error('Unknown negotiation');
    this.expireNegotiation(n);
    if (n.status === NEGOTIATION_STATUS.EXPIRED) throw new Error('NEGOTIATION_EXPIRED');
    if (TERMINAL.has(n.status)) throw new Error(`Negotiation is ${n.status}`);
    return n;
  }

  _message(n, senderRole, type, fields = {}) {
    const sender = senderRole === 'BUYER' ? n.buyerAgent : senderRole === 'MERCHANT' ? n.merchantAgent : { agentId: 'MANDATE', role: 'SYSTEM' };
    const receiver = senderRole === 'BUYER' ? n.merchantAgent : senderRole === 'MERCHANT' ? n.buyerAgent : null;
    const entry = immutable({ negotiationId: n.negotiationId, messageId: `MSG-${n.negotiationId.slice(4)}-${String(n.messages.length + 1).padStart(3, '0')}`, sender: { agentId: sender.agentId, role: sender.role || senderRole }, receiver: receiver && { agentId: receiver.agentId, role: receiver.role }, type, timestamp: new Date(this.now()).toISOString(), ...fields });
    n.messages.push(entry);
    n.updatedAt = entry.timestamp;
    return entry;
  }
}

function invalid(code, reason, extra = {}) { return { valid: false, code, reason, ...extra }; }
function check(id, ok, detail) { return { id, ok, detail }; }
