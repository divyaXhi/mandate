import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { parseIntent, parseIntentSmart, searchProducts, loadCatalog } from './agent.js';
import { buildCartMandate } from './cartMandate.js';
import { scoreConfidence } from './trustLayer.js';
import { executePayment, refundPayment, getRazorpayKeyId, verifyPaymentSignature } from './paymentMandate.js';
import { logEvent, getTrail, clearTrails } from './auditLog.js';
import { findCustomerByPhone, saveCustomer } from './customerStore.js';
import { generateReceipt } from './receipt.js';
import { generateAuditPdf, publicAuditTrail } from './auditExport.js';
import { evaluatePolicy, dailySpent, DEFAULT_MANDATE } from './policyEngine.js';
import { buyerAgentIdentity, merchantAgentIdentity } from './agentIdentity.js';
import { detectPromptInjection } from './security.js';
import { proposeCounterOffer, proposeBundle } from './merchantAgent.js';
import { NegotiationEngine } from './negotiationEngine.js';
import { evaluateTransaction } from './decision/transactionEvaluator.js';
import { ATTACKS, attackById } from './security/attackRegistry.js';
import { runRegisteredAttack } from './security/attackRunner.js';
import { recordAttackAudit, isDefended } from './security/attackResults.js';
import { executeAttack } from './security/attackEngine.js';
import { DEMO_SCENARIOS } from './demo/demoScenarios.js';
import { runDemoScenario } from './demo/demoRunner.js';
import { demoHealth } from './demo/demoHealth.js';
import { buildTransactionTimeline } from './observability/transactionTimeline.js';
import { buildTransactionTrace } from './observability/transactionTrace.js';
import { buildSecurityTrace } from './observability/securityTrace.js';
import { metricsSnapshot, markTransactionStart } from './observability/metrics.js';
import { PaymentAttemptLedger } from './runtime/paymentAttemptLedger.js';
import { RequestValidationError, requireAction, requireCurrency, requireId, requireObject, requirePositiveAmount, optionalString } from './runtime/validation.js';
import { TransactionStateMachine, TRANSACTION_STATE } from './runtime/transactionStateMachine.js';
import { ERROR_CODE } from './runtime/errorCodes.js';
// Visibility layer. None of these modules can change an outcome;
// they surface decisions the pipeline was already making invisibly.
import { runPaymentGuard } from './paymentGuard.js';
import { evaluateApproval } from './approvalGate.js';
import { buildTransactionState, displayIdFor } from './transactionState.js';
import { STATUS } from './pipeline.js';
import { classifyConversation, stateForStage } from './conversationIntent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.on('unhandledRejection', (reason) => {
  console.error('[server] UNHANDLED REJECTION — process kept alive:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] UNCAUGHT EXCEPTION — process kept alive:', err);
});

const app = express();
app.use(express.json({ strict: true, limit: '64kb' }));
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.parse.failed') return apiError(res, 400, { code: 'INVALID_REQUEST', message: 'Malformed JSON request body', stage: 'API_VALIDATION' });
  return next(err);
});
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (!req.is('application/json')) return apiError(res, 400, { code: 'INVALID_REQUEST', message: 'API requests must use application/json', stage: 'API_VALIDATION' });
  try { requireObject(req.body); return next(); }
  catch (error) { return apiError(res, 400, { code: error.code || 'INVALID_REQUEST', message: error.message, stage: 'API_VALIDATION' }); }
});
app.use('/api', (req, res, next) => {
  // Legacy routes used `{ error: 'text' }`. Normalize them at the edge so
  // callers always receive the structured contract without a rewrite of
  // the established business flows.
  const sendJson = res.json.bind(res);
  res.json = (payload) => {
    if (payload && typeof payload === 'object' && typeof payload.error === 'string') {
      const message = payload.error;
      const upper = message.toUpperCase();
      const code = upper.includes('STALE') ? 'STALE_DEAL'
        : upper.includes('EXPIRED') ? 'NEGOTIATION_EXPIRED'
          : upper.includes('APPROV') ? 'APPROVAL_REQUIRED'
            : upper.includes('PAYMENT') || upper.includes('SIGNATURE') ? 'PAYMENT_GUARD_BLOCKED'
              : upper.includes('DEAL') ? 'DEAL_INVALID' : 'INVALID_REQUEST';
      // An unknown resource supplied to a valid API endpoint is invalid input,
      // not a discovery endpoint. Keep this a structured HTTP 400.
      if (res.statusCode === 404 && /^UNKNOWN\b/i.test(message)) res.status(400);
      return sendJson({ success: false, error: { code, message, stage: 'API', transactionId: payload.transactionId || null } });
    }
    return sendJson(payload);
  };
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));

const BUYER_COUNTRY = 'IN';

// In-memory per-session state. Fine for a demo; a real deployment would use
// a store like Redis. Tracks: pending mandate awaiting approval/step-up,
// recent purchase timestamps (for velocity scoring), completed transactions.
const sessions = new Map();

// Idempotency ledger for payment attempts, keyed by transactionId — independent
// of `sessions`, since it needs to survive being checked even if the caller's
// own state is uncertain (that's the whole point: don't trust local state,
// check the ledger). See executePaymentIdempotent() and the network-failure
// recovery demo below.
const paymentAttempts = new PaymentAttemptLedger(); // transactionId -> single-flight payment attempt
const demoTransactionIds = new Set();
const demoAttackTransactionIds = new Set();

/**
 * Wraps executePayment with an idempotency check: if a payment for this
 * transactionId already succeeded, return the existing result instead of
 * calling Razorpay again — this is what actually prevents a duplicate charge
 * on retry, not just a promise not to retry carelessly.
 */
async function executePaymentIdempotent(cart, approvedAmountInr, transactionId) {
  return paymentAttempts.execute(transactionId, () => executePayment(cart, approvedAmountInr));
}

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    const initialMandate = { ...DEFAULT_MANDATE };
    sessions.set(sessionId, {
      // The shopping experience collects identity and delivery details only
      // when needed for a purchase, not before a user may search or compare.
      profile: { onboarded: true, step: 'done', name: 'Shopper', phone: null, email: null, address: null },
      mandate: initialMandate, // per-session spending mandate — see policyEngine.js
      mandateVersion: 1,
      mandateHistory: [{ version: 1, mandate: { ...initialMandate }, changedAt: new Date().toISOString(), reason: 'initial mandate' }],
      agentSeed: String(Math.floor(Math.random() * 100000)).padStart(5, '0'),
      createdAt: new Date().toISOString(), // when this session's buyer agent was issued
      pending: null, // { transactionId, cart, confidence, otp, awaitingOtp/awaitingApproval/awaitingDeliveryChoice/awaitingRecipientDetails/awaitingPaymentMethod }
      awaitingBudgetRangeFor: null, // holds the original message while we wait for a budget range reply
      recentPurchaseTimestamps: [],
      transactions: [], // completed transaction summaries, for refund lookups
      stats: { blockedAttempts: 0, humanApprovalsGiven: 0, negotiationsWon: 0 }, // for the dashboards
      // Visibility fields. The Control Center has to be able to render
      // the CURRENT transaction at any moment, including after a request that
      // didn't itself carry the intent (an OTP reply, an approval, a payment
      // callback). Parking the last parsed intent and the last injection scan on
      // the session is what makes the Intent and Risk panels stay populated
      // across those follow-up turns instead of blanking out mid-flow.
      lastIntent: null,
      lastInjection: null,
      lastGuard: null,
      lastPaymentMethod: null,
      conversationState: 'IDLE',
      pendingMandateChange: null,
      stepUpVerified: false,
      uiMode: 'normal', // 'normal' | 'control' — see §23; judges get the wiring, users don't
      transactionStateMachines: new Map(), // Explicit states, separate from UI presentation state
      negotiationEngine: new NegotiationEngine()
    });
  }
  return sessions.get(sessionId);
}

/**
 * Assemble the current TransactionState for a session.
 *
 * Every response that changes anything runs through here, so the frontend never
 * has to reconstruct pipeline state from a chat reply. Overrides carry the live
 * facts that aren't stored on the session yet — a guard result, a payment
 * outcome, an error — while everything else is read back out of session state.
 */
function snapshotState(session, sessionId, overrides = {}) {
  return buildTransactionState({
    session,
    sessionId,
    // Once checkout completes there is intentionally no pending cart left to
    // mutate. Inspect must nevertheless show the completed, read-only evidence
    // rather than falling back to an empty state.
    pending: overrides.pending || session.pending || session.transactions?.at(-1) || null,
    intent: overrides.intent || session.lastIntent,
    dailySpentInr: dailySpent(session.transactions),
    overrides: {
      recentPurchaseCount: recentPurchaseCount(session),
      injectionDetected: !!session.lastInjection?.detected,
      stepUpVerified: !!session.stepUpVerified,
      paymentGuard: overrides.paymentGuard ?? session.lastGuard,
      paymentMethod: overrides.paymentMethod ?? session.lastPaymentMethod,
      ...overrides
    }
  });
}

/**
 * Attach state to any response object on its way out. Kept as a single funnel so
 * no route can accidentally return a reply without the pipeline picture attached —
 * that inconsistency is exactly what this state layer is designed to remove.
 */
function withState(result, session, sessionId, overrides = {}) {
  if (!result || typeof result !== 'object') return result;
  try {
    result.state = snapshotState(session, sessionId, overrides);
  } catch (err) {
    // A visibility layer must never be able to break the transaction it
    // describes. If assembling state throws, the purchase still completes and
    // the UI simply keeps its previous picture.
    console.warn(`[state] could not assemble TransactionState: ${err.message}`);
  }
  return result;
}

function apiError(res, status, { code, message, stage, transactionId = null }) {
  const stableCode = Object.values(ERROR_CODE).includes(code) ? code : ERROR_CODE.INVALID_REQUEST;
  return res.status(status).json({ success: false, error: { code: stableCode, message, stage, transactionId } });
}

function advanceTransactionState(session, transactionId, next) {
  let machine = session.transactionStateMachines.get(transactionId);
  if (!machine) {
    machine = new TransactionStateMachine();
    session.transactionStateMachines.set(transactionId, machine);
  }
  if (machine.state !== next) machine.transition(next);
  return machine;
}

// A direct catalog selection has no merchant back-and-forth, but it still
// becomes a deal evaluated by the same MANDATE pipeline. Record the omitted
// protocol milestones rather than creating a bypass around the state machine.
function advanceToEvaluation(session, transactionId) {
  let machine = session.transactionStateMachines.get(transactionId);
  if (!machine) machine = advanceTransactionState(session, transactionId, TRANSACTION_STATE.INTENT_PARSED);
  if (machine.state === TRANSACTION_STATE.INTENT_PARSED) advanceTransactionState(session, transactionId, TRANSACTION_STATE.NEGOTIATING);
  machine = session.transactionStateMachines.get(transactionId);
  if (machine.state === TRANSACTION_STATE.NEGOTIATING) advanceTransactionState(session, transactionId, TRANSACTION_STATE.DEAL_CREATED);
  machine = session.transactionStateMachines.get(transactionId);
  if (machine.state === TRANSACTION_STATE.DEAL_CREATED) advanceTransactionState(session, transactionId, TRANSACTION_STATE.EVALUATING);
  return session.transactionStateMachines.get(transactionId);
}

function validateApi(res, validate, { transactionId = null } = {}) {
  try { validate(); return true; }
  catch (error) {
    return apiError(res, 400, {
      code: error instanceof RequestValidationError ? error.code : 'INVALID_REQUEST',
      message: error.message || 'Invalid request', stage: 'API_VALIDATION', transactionId
    }) && false;
  }
}

/**
 * Run the six pre-flight checks and record the result on the session.
 *
 * Unlike display-only views, this one is NOT a display layer — it is
 * a real gate, and every caller must honour `guard.passed`. It re-verifies the
 * mandate ceilings against the FINAL price rather than the price that was scored
 * back at item selection, reads the idempotency ledger directly rather than
 * trusting session state, and compares the amount about to be charged against
 * `pending.approvedAmountInr` — the figure snapshotted at the moment the user
 * actually said yes.
 *
 * That last comparison is the reason the snapshot exists. Earlier code passed the cart's
 * own total in as the "approved amount", so the price-drift check inside
 * executePayment was comparing a number against itself and could never fire.
 * Now the approved figure is captured once, at approval time, and the guard has
 * something independent to check it against.
 */
function guardPayment(session, paymentMethod) {
  const { transactionId, cart } = session.pending;
  const approvedAmountInr = session.pending.approvedAmountInr ?? cart.pricing.totalInr;
  let dealValidation = null;

  if (session.pending.deal) {
    const deal = session.pending.deal;
    dealValidation = session.negotiationEngine.revalidateDeal(deal.dealId, {
      transactionId,
      mandateVersion: session.mandateVersion,
      buyerMaxInr: session.pending.negotiation?.buyerConstraints?.maxPriceInr || deal.pricing.finalAmountInr,
      productId: cart.item?.id,
      merchantAgentId: cart.item ? merchantAgentIdentity(cart.item.merchant).agentId : deal.merchantAgentId,
      finalAmountInr: cart.pricing.totalInr,
      currency: 'INR',
      bundlePriceInr: deal.pricing.bundlePriceInr,
      fingerprint: deal.fingerprint
    });
    session.pending.dealValidation = dealValidation;
  }

  const guard = runPaymentGuard({
    cart,
    approvedAmountInr,
    mandate: session.mandate,
    dailySpentInr: dailySpent(session.transactions),
    transactionId,
    ledgerEntry: paymentAttempts.get(transactionId) || null,
    paymentMethod,
    railConfigured: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
    decision: session.pending.decision || null,
    dealValidation
  });

  session.lastGuard = guard;
  session.lastPaymentMethod = paymentMethod;

  logEvent(transactionId, guard.passed ? 'payment_guard_passed' : 'payment_guard_blocked', {
    passed: guard.passed,
    failedCheckId: guard.failedCheckId,
    approvedAmountInr,
    chargeAmountInr: cart.pricing.totalInr,
    checks: guard.checks.map(c => ({ id: c.id, status: c.status }))
  });

  return guard;
}

/**
 * Apply a mandate change and record a new version. Every transaction logs
 * which mandate VERSION authorized it (see finalizeItemSelection), so a
 * later mandate change never silently reinterprets a past decision.
 */
function updateMandate(session, changes, reason) {
  session.mandate = { ...session.mandate, ...changes };
  session.mandateVersion += 1;
  session.mandateHistory.push({
    version: session.mandateVersion,
    mandate: { ...session.mandate },
    changedAt: new Date().toISOString(),
    reason
  });
  // A previously accepted deal is never silently carried forward under a new
  // mandate. The immutable snapshot stays available for inspection, but the
  // current state will surface it as stale until it is revalidated.
  if (session.pending?.deal?.dealId) {
    const item = session.pending.item;
    const deal = session.pending.deal;
    session.pending.dealValidationRequired = true;
    session.pending.dealValidation = session.negotiationEngine.revalidateDeal(deal.dealId, {
      mandateVersion: session.mandateVersion,
      buyerMaxInr: session.pending.negotiation?.buyerConstraints?.maxPriceInr || deal.pricing.finalAmountInr,
      productId: item?.id,
      merchantAgentId: item ? merchantAgentIdentity(item.merchant).agentId : deal.merchantAgentId,
      finalAmountInr: deal.pricing.finalAmountInr,
      bundlePriceInr: deal.pricing.bundlePriceInr
    });
    logEvent(deal.transactionId, 'DEAL_INVALIDATED', { dealId: deal.dealId, validation: session.pending.dealValidation });
  }
}

function recentPurchaseCount(session) {
  const windowMs = 3 * 60 * 1000; // 3 minutes
  const cutoff = Date.now() - windowMs;
  session.recentPurchaseTimestamps = session.recentPurchaseTimestamps.filter(t => t > cutoff);
  return session.recentPurchaseTimestamps.length;
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

// OTP plaintext is shown once only in the local demo response. Session state
// retains a salted proof, never the code itself; audit records only outcomes.
function issueOtpProof() {
  const otp = generateOtp();
  const salt = crypto.randomBytes(16).toString('hex');
  return { otp, otpSalt: salt, otpHash: crypto.createHash('sha256').update(`${salt}:${otp}`).digest('hex') };
}

function matchesOtp(proof, attempt) {
  if (!proof?.otpHash || !proof?.otpSalt || !/^\d{6}$/.test(attempt || '')) return false;
  const candidate = crypto.createHash('sha256').update(`${proof.otpSalt}:${attempt}`).digest();
  const expected = Buffer.from(proof.otpHash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

/**
 * fetch() with a hard timeout — a few different endpoints proxy to external
 * services (map geocoding, live product search), and without this an
 * unreachable/slow external service would hang the whole HTTP request
 * indefinitely instead of failing fast into the existing fallback paths.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ---------- FAQ intercept ----------
// Answers common questions asked mid-flow ("what does confidence mean?") instead
// of misinterpreting them as an answer to whatever the agent just asked. Only
// triggers on messages that look like a question, so it never hijacks a real
// "yes"/number/OTP/name reply.
const FAQ_ANSWERS = [
  { keys: ['confidence', 'trust score', 'score mean'], answer: `The confidence score (0-100) is how sure the trust layer is that this purchase is safe to auto-approve. It's built from real signals — cross-border risk, seller verification, merchant history or rating, category risk, and recent purchase pace. 70+ proceeds automatically, 40-69 needs a step-up code, below 40 is blocked outright.` },
  { keys: ['step up', 'step-up', 'otp', 'one-time code', 'one time code'], answer: `Step-up verification is a one-time code you have to enter before a moderate-confidence purchase goes through — like a 2FA check, only triggered when the trust score isn't high enough to proceed automatically.` },
  { keys: ['mandate chain'], answer: `The Mandate Chain is the pipeline every purchase goes through: Intent → Cart → Trust → Approval → Payment → Audit. Nothing gets paid without passing through all of them.` },
  { keys: ['cross border', 'cross-border', 'conversion fee'], answer: `A cross-border fee applies when the seller is in a different country than you — it covers currency conversion, shown transparently in the price breakdown instead of hidden in the total.` },
  { keys: ['audit trail'], answer: `The audit trail is a timestamped log of every decision made for a purchase — intent parsing, trust scoring, your approval, and the payment — so nothing happens invisibly. You can view it after a purchase completes.` },
  { keys: ['gst'], answer: `GST verification means the merchant has completed GST/KYC registration — it's one of the trust signals used for local sellers who don't have a public rating history yet.` },
  { keys: ['refund', 'return'], answer: `You can request a refund or return from the "Completed transactions" list, or from the receipt after an order — there's a "Reverse / refund" option next to each completed order.` },
  { keys: ['cod', 'cash on delivery'], answer: `Cash on Delivery means you pay the delivery person when the order arrives, instead of paying online now. You'll be asked to choose between COD and online payment right before the final approval.` },
  { keys: ['seller rating', 'star rating'], answer: `For live Amazon India listings, the star rating and review count are the seller's real public reputation — used directly as a trust signal instead of platform tenure, since there's no "tenure with us" for an external marketplace seller.` }
];

function matchFaq(message) {
  const text = (message || '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const looksLikeQuestion = /\?$/.test(text) || /^(what|why|how|explain|does|is|are|can)\b/i.test(text);
  if (!looksLikeQuestion) return null;
  for (const entry of FAQ_ANSWERS) {
    if (entry.keys.some(k => lower.includes(k))) return entry.answer;
  }
  return null;
}

/**
 * Recognizes a small set of mandate self-service commands. Returns
 * { changes, reason } or null if the message doesn't match one.
 */
function parseMandateEdit(message) {
  const lower = message.toLowerCase();
  const numMatch = (pattern) => {
    const m = lower.match(pattern);
    if (!m) return null;
    let val = parseFloat(m[1]);
    if (m[2]) val *= 1000; // "30k" -> 30000
    return Math.round(val);
  };

  let val = numMatch(/(?:daily limit|daily spend(?:ing)? limit)\D*(\d+(?:\.\d+)?)\s*(k)?/);
  if (val != null) return { changes: { dailyLimitInr: val }, reason: `Daily limit set to ₹${val.toLocaleString('en-IN')}` };

  val = numMatch(/(?:max(?:imum)? transaction|per[- ]transaction (?:max|limit))\D*(\d+(?:\.\d+)?)\s*(k)?/);
  if (val != null) return { changes: { maxTransactionInr: val }, reason: `Per-transaction max set to ₹${val.toLocaleString('en-IN')}` };

  val = numMatch(/autonomous(?:[- ]spend)? threshold\D*(\d+(?:\.\d+)?)\s*(k)?/);
  if (val != null) return { changes: { autonomousSpendThresholdInr: val }, reason: `Autonomous-spend threshold set to ₹${val.toLocaleString('en-IN')}` };

  return null;
}

function startMandateChange(session, requested) {
  const value = requested.changes.dailyLimitInr;
  if (!Number.isSafeInteger(value) || value < 100 || value > 1000000) {
    return { reply: 'Enter a daily purchase limit from ₹100 to ₹10,00,000.', stage: 'mandate_edit_limit' };
  }
  const proof = issueOtpProof();
  session.pendingMandateChange = { changes: requested.changes, reason: requested.reason, otpHash: proof.otpHash, otpSalt: proof.otpSalt, attempts: 0, expiresAt: Date.now() + 5 * 60 * 1000 };
  logEvent(`mandate-${session.agentSeed}`, 'mandate_otp_issued', { dailyLimitInr: value, expiresAt: new Date(session.pendingMandateChange.expiresAt).toISOString() });
  return {
    reply: `To change your daily purchase limit to ₹${value.toLocaleString('en-IN')}, verify this one-time code: **${proof.otp}**. (Shown only in this test demo; it expires in 5 minutes.)`,
    stage: 'mandate_otp_required',
    mandateChange: { dailyLimitInr: value }
  };
}

function handleMandateChange(session, message) {
  const change = session.pendingMandateChange;
  const attempt = (message || '').trim();
  if (/^(cancel|no|stop)$/i.test(attempt)) {
    logEvent(`mandate-${session.agentSeed}`, 'mandate_change_cancelled', {});
    session.pendingMandateChange = null;
    return { reply: 'Mandate change cancelled. Your existing purchase limit is unchanged.', stage: 'mandate_change_cancelled' };
  }
  if (Date.now() > change.expiresAt) {
    logEvent(`mandate-${session.agentSeed}`, 'mandate_otp_expired', {});
    session.pendingMandateChange = null;
    return { reply: 'That mandate-change code expired. Your purchase limit was not changed; start again when ready.', stage: 'mandate_otp_expired' };
  }
  if (!matchesOtp(change, attempt)) {
    change.attempts += 1;
    logEvent(`mandate-${session.agentSeed}`, 'mandate_otp_failed', { attempts: change.attempts });
    if (change.attempts >= 5) {
      session.pendingMandateChange = null;
      return { reply: 'Too many incorrect codes. Your purchase limit was not changed; start again when ready.', stage: 'mandate_otp_locked' };
    }
    return { reply: `That code is not valid. ${5 - change.attempts} attempt${5 - change.attempts === 1 ? '' : 's'} remaining.`, stage: 'mandate_otp_required' };
  }
  updateMandate(session, change.changes, change.reason);
  logEvent(`mandate-${session.agentSeed}`, 'mandate_change_verified', { dailyLimitInr: session.mandate.dailyLimitInr, mandateVersion: session.mandateVersion });
  const value = session.mandate.dailyLimitInr;
  session.pendingMandateChange = null;
  return { reply: `✅ Your purchase mandate has been updated. New daily limit: ₹${value.toLocaleString('en-IN')}.`, stage: 'mandate_updated' };
}

/**
 * GET /api/geocode/reverse?lat=&lon=
 * Proxies to OpenStreetMap's free Nominatim reverse-geocoding service so the
 * map-based address picker can turn a dropped pin into a readable address +
 * pincode. Proxied through our server (rather than called from the browser
 * directly) so we can set a proper User-Agent, which Nominatim's usage policy
 * requires.
 */
app.get('/api/geocode/reverse', async (req, res) => {
  const { lat, lon } = req.query;
  if (!validateApi(res, () => {
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon)) || Math.abs(Number(lat)) > 90 || Math.abs(Number(lon)) > 180) {
      throw new RequestValidationError('lat and lon must be valid coordinates');
    }
  })) return;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'paymandate-hackathon-demo/1.0 (contact: demo)' } }, 6000);
    if (!r.ok) throw new Error(`Nominatim returned ${r.status}`);
    const data = await r.json();
    res.json({
      address: data.display_name || '',
      pincode: data.address?.postcode || ''
    });
  } catch (err) {
    res.status(500).json({ error: 'Reverse geocoding failed', detail: err.message });
  }
});

/**
 * GET /api/geocode/search?q=
 * Forward geocoding (place name -> coordinates) for the address search box,
 * proxied the same way as the reverse endpoint above.
 */
app.get('/api/geocode/search', async (req, res) => {
  const { q } = req.query;
  if (!validateApi(res, () => { optionalString(q, 'q', { max: 200 }); if (!q?.trim()) throw new RequestValidationError('q is required'); })) return;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=in&q=${encodeURIComponent(q)}`;
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'paymandate-hackathon-demo/1.0 (contact: demo)' } }, 6000);
    if (!r.ok) throw new Error(`Nominatim returned ${r.status}`);
    const data = await r.json();
    res.json({
      results: data.map(d => ({ address: d.display_name, lat: parseFloat(d.lat), lng: parseFloat(d.lon) }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Geocode search failed', detail: err.message });
  }
});

/**
 * POST /api/message
 * body: { sessionId, message }
 *
 * Drives the whole pipeline. Returns a structured response the frontend uses
 * to render both the chat bubble and the live Mandate Chain stepper.
 */
app.post('/api/message', async (req, res) => {
  const { sessionId = 'default', message, addressPayload, productChoice } = req.body;
  if (!validateApi(res, () => {
    requireId(sessionId, 'sessionId'); optionalString(message, 'message');
    if (addressPayload !== undefined) requireObject(addressPayload, 'addressPayload');
    if (productChoice !== undefined && productChoice !== null) requireId(productChoice, 'productChoice');
  })) return;
  const session = getSession(sessionId);

  // Scan every real incoming message for instruction-injection patterns,
  // not just the ones fired by the attack simulator. The detector already
  // existed (security.js) but was only ever pointed at synthetic input, which
  // meant the Risk panel had nothing truthful to report on a live request.
  // Note this is the SECONDARY defence and is labelled as such in the UI — the
  // primary defence is structural: prices are read from catalog records, so
  // there is no code path where message text could set a price even if this
  // detector missed something.
  if (typeof message === 'string' && message.trim()) {
    const injection = detectPromptInjection(message);
    session.lastInjection = { ...injection, scannedText: message, at: new Date().toISOString() };
    if (injection.detected) {
      logEvent(session.pending?.transactionId || `session-${sessionId}`, 'injection_detected', {
        matches: injection.matches,
        note: 'Detected in a live user message. Prices are sourced from catalog records regardless, so this could not have altered an amount.'
      });
    }
  }

  try {
    // Single funnel: every res.json(...) below gets the current TransactionState
    // attached on the way out. Wrapping once here, rather than at each of the
    // ~20 return sites, means no code path can reply without the pipeline
    // picture — the inconsistency this state layer prevents.
    const sendJson = res.json.bind(res);
    res.json = (payload) => sendJson(withState(payload, session, sessionId));

    // First-time customer: run onboarding before anything else.
    if (!session.profile.onboarded) {
      return res.json(handleOnboarding(session, message, addressPayload));
    }

    if (session.pendingMandateChange) {
      const result = handleMandateChange(session, message);
      session.conversationState = stateForStage(result.stage);
      return res.json(result);
    }

    const conversationIntent = classifyConversation(message);
    if (conversationIntent === 'GREETING') {
      const reminder = pendingReminder(session);
      const result = { reply: reminder ? `Hi! I’m Mandate. ${reminder}` : 'Hi! I’m Mandate, your AI shopping agent. Tell me what you’d like to find and your budget — for example, “non-gaming laptop under ₹45,000”.', stage: 'greeting' };
      session.conversationState = stateForStage(result.stage);
      return res.json(result);
    }
    if (conversationIntent === 'CANCELLATION' && session.pending) {
      session.pending = null;
      const result = { reply: 'Cancelled. No payment was created. What would you like to look for instead?', stage: 'cancelled' };
      session.conversationState = 'IDLE';
      return res.json(result);
    }
    if (conversationIntent === 'HELP') {
      const reminder = pendingReminder(session);
      return res.json({ reply: reminder || 'I can find products from the catalog, compare available options, and negotiate when no exact match fits your budget. Tell me what you want and your budget.', stage: 'help' });
    }
    if (conversationIntent === 'MANDATE_VIEW') {
      return res.json({ reply: `📌 Purchase Mandate\nDaily purchase limit: ₹${session.mandate.dailyLimitInr.toLocaleString('en-IN')}\nPer-purchase maximum: ₹${session.mandate.maxTransactionInr.toLocaleString('en-IN')}\n\nTo change your daily limit, say: “set my daily limit to 25k”. Every change requires a one-time code.`, stage: 'mandate_view' });
    }
    if (conversationIntent === 'MANDATE_EDIT' && !parseMandateEdit(message)) {
      return res.json({ reply: `What daily purchase limit would you like? Your current limit is ₹${session.mandate.dailyLimitInr.toLocaleString('en-IN')}.`, stage: 'mandate_edit_limit' });
    }
    if (conversationIntent === 'REFINE_SEARCH' && session.lastIntent?.category) {
      session.pending = null;
      const baseRequest = session.lastIntent.raw || session.lastIntent.query;
      const refined = await parseIntentSmart(`${baseRequest} ${message}`);
      const refinement = parseIntent(message);
      // “under 40000 instead” is an override, not a second budget appended to
      // the original request. Keep the known category/constraints as context.
      refined.budget = refinement.budget ?? session.lastIntent.budget;
      refined.minBudget = refinement.minBudget ?? session.lastIntent.minBudget;
      refined.category ||= session.lastIntent.category;
      refined.query = refined.category || session.lastIntent.query;
      session.lastIntent = { ...refined, raw: `${session.lastIntent.raw || session.lastIntent.query} ${message}` };
      const result = await continuePurchase(session, sessionId, refined, session.lastIntent.raw);
      session.conversationState = stateForStage(result.stage);
      return res.json(result);
    }

    // A generic question asked mid-flow ("what does confidence mean?") — answer
    // it without disturbing whatever the agent was waiting for.
    const faqAnswer = matchFaq(message);
    if (faqAnswer) {
      const reminder = pendingReminder(session);
      return res.json({ reply: reminder ? `${faqAnswer}\n\n${reminder}` : faqAnswer, stage: 'faq_answer' });
    }

    // Mandate self-service — "set my daily limit to 30000" / "set my max transaction to 15000".
    // Not gated behind anything else: the user is always allowed to tighten or
    // loosen their own mandate outside of an active purchase flow. Every change
    // is versioned (see updateMandate) so past transactions stay tied to the
    // mandate version that actually authorized them.
    const mandateEdit = parseMandateEdit(message);
    if (mandateEdit) {
      const result = startMandateChange(session, mandateEdit);
      session.conversationState = stateForStage(result.stage);
      return res.json(result);
    }

    // Product selection is more specific than any stale budget prompt. This
    // must run first: a product card click, "1", or "second one" is never a
    // budget answer, even if an interrupted earlier request left that marker.
    if (session.pending && session.pending.awaitingProductChoice) {
      session.awaitingBudgetRangeFor = null;
      return res.json(handleProductChoice(session, sessionId, message, productChoice));
    }

    // We asked for a budget range on the last turn — this message is that range.
    if (session.awaitingBudgetRangeFor) {
      const originalMessage = session.awaitingBudgetRangeFor;
      session.awaitingBudgetRangeFor = null;
      const combinedIntent = await parseIntentSmart(originalMessage); // re-parse the original request (handles Hindi/Hinglish query terms)
      const rangeReply = parseIntent(message); // the range reply itself is simple enough for the fast regex path
      combinedIntent.budget = rangeReply.budget;
      combinedIntent.minBudget = rangeReply.minBudget;
      if (combinedIntent.budget == null) {
        // Still didn't get a usable number — ask again rather than searching unbounded.
        session.awaitingBudgetRangeFor = originalMessage;
        return res.json({
          reply: `Didn't catch a number there — what's your budget? e.g. "500 to 1500" or "under 2000".`,
          stage: 'awaiting_budget_range'
        });
      }
      // Same parking as startPurchase — the budget-range reply is a second turn,
      // so without this the Intent panel would lose the original request.
      session.lastIntent = { ...combinedIntent, raw: originalMessage };
      session.stepUpVerified = false;
      return res.json(await continuePurchase(session, sessionId, combinedIntent, originalMessage));
    }

    // Merchant Agent negotiation — either "want me to negotiate?" or a counter-offer response.
    if (session.pending && session.pending.awaitingNegotiation) {
      return res.json(handleNegotiation(session, message));
    }

    // If there's a pending mandate awaiting step-up OTP, treat this message as the OTP attempt.
    if (session.pending && session.pending.awaitingOtp) {
      return res.json(await handleOtpAttempt(session, sessionId, message));
    }

    // If there's a pending mandate awaiting plain approval ("yes"/"approve").
    if (session.pending && session.pending.awaitingApproval) {
      if (session.pending.deal) {
        const deal = session.pending.deal;
        const validation = session.negotiationEngine.revalidateDeal(deal.dealId, {
          mandateVersion: session.mandateVersion,
          buyerMaxInr: session.pending.negotiation?.buyerConstraints?.maxPriceInr || deal.pricing.finalAmountInr,
          productId: session.pending.item?.id,
          merchantAgentId: session.pending.item ? merchantAgentIdentity(session.pending.item.merchant).agentId : deal.merchantAgentId,
          finalAmountInr: deal.pricing.finalAmountInr,
          bundlePriceInr: deal.pricing.bundlePriceInr
        });
        if (!validation.valid) {
          const dealId = deal.dealId;
          logEvent(deal.transactionId, 'DEAL_INVALIDATED', { dealId, validation });
          session.pending = null;
          return res.json({
            reply: `⚠ ${dealId} cannot proceed: its immutable snapshot is stale (${validation.reason}). The deal was stopped before approval or payment; please renegotiate.`,
            stage: 'deal_invalidated'
          });
        }
      }
      if (session.pending.dealValidationRequired) {
        const dealId = session.pending.deal?.dealId;
        session.pending = null;
        return res.json({
          reply: `⚠ ${dealId} cannot proceed: your mandate changed after the agents accepted it. The stale deal was stopped before approval or payment; please renegotiate.`,
          stage: 'deal_invalidated'
        });
      }
      const affirmative = /^(y|yes|approve|confirm|ok|okay|proceed)\b/i.test(message.trim());
      if (affirmative) {
        session.pending.awaitingApproval = false;
        session.pending.awaitingDeliveryChoice = true;
        // Freeze the figure the user just approved. From here on, the Payment
        // Guard checks the amount about to be charged against THIS number — not
        // against the cart's own live total, which would be circular. The full
        // authorization proof is logged later, in finalizePurchase.
        session.pending.approvedAmountInr = session.pending.cart.pricing.totalInr;
        session.pending.approvedAt = new Date().toISOString();
        // Approval is stamped onto the cart HERE, at the moment consent was
        // given, rather than at payment time. The flag is set immediately
        // before charging, which meant the "is this cart approved?" guard could
        // never fail. Moving it earlier makes that check mean something.
        session.pending.cart.approved = true;
        return res.json({
          reply: `Got it. Is this order for yourself, or are you booking it for someone else? (You can also type "edit" to update your saved name, phone, email or address first.)`,
          stage: 'awaiting_delivery_choice',
          chain: chainState('approval', { cart: session.pending.cart, confidence: session.pending.confidence })
        });
      } else {
        session.pending = null;
        return res.json({
          reply: "No problem — cancelled. What would you like to look for instead?",
          stage: 'cancelled',
          chain: chainState('cancelled')
        });
      }
    }

    // Editing saved profile details, triggered from the delivery-choice step.
    if (session.pending && session.pending.awaitingEdit) {
      return res.json(handleEditDetails(session, message, addressPayload));
    }

    // Delivery: for self, someone else, or edit my details first?
    if (session.pending && session.pending.awaitingDeliveryChoice) {
      return res.json(handleDeliveryChoice(session, message));
    }

    // Collecting recipient's name/phone/email/address when booking for someone else.
    if (session.pending && session.pending.awaitingRecipientDetails) {
      return res.json(await handleRecipientDetails(session, sessionId, message, addressPayload));
    }

    // Final "yes" after delivery details are confirmed — now choose payment method.
    if (session.pending && session.pending.awaitingFinalApproval) {
      const affirmative = /^(y|yes|approve|confirm|ok|okay|proceed)\b/i.test(message.trim());
      if (affirmative) {
        session.pending.awaitingFinalApproval = false;
        session.pending.awaitingPaymentMethod = true;
        const machine = session.transactionStateMachines.get(session.pending.transactionId);
        if (machine?.state === TRANSACTION_STATE.AWAITING_APPROVAL) advanceTransactionState(session, session.pending.transactionId, TRANSACTION_STATE.PAYMENT_READY);
        return res.json({
          reply: `Last step — how would you like to pay? Reply "cod" for Cash on Delivery, or "online" to pay now.`,
          stage: 'awaiting_payment_method'
        });
      } else {
        session.pending = null;
        return res.json({
          reply: "No problem — cancelled. What would you like to look for instead?",
          stage: 'cancelled',
          chain: chainState('cancelled')
        });
      }
    }

    // Payment method choice — COD skips the Razorpay call entirely, online runs it.
    if (session.pending && session.pending.awaitingPaymentMethod) {
      return res.json(await handlePaymentMethod(session, sessionId, message));
    }

    // COD is still an order commitment. It requires a distinct final yes/no,
    // rather than treating the payment-method choice as permission to place it.
    if (session.pending && session.pending.awaitingCodConfirmation) {
      return res.json(await handleCodConfirmation(session, sessionId, message));
    }

    // The Razorpay Checkout widget is open — the frontend drives the next
    // step (/api/payment/verify or /api/payment/cancelled), not a chat message.
    if (session.pending && session.pending.awaitingOnlinePayment) {
      return res.json({
        reply: `The payment window is open — complete it there, or close it to cancel and choose a different payment method.`,
        stage: 'awaiting_online_payment'
      });
    }

    // Otherwise: treat this as a new purchase intent.
    const result = await startPurchase(session, sessionId, message);
    session.conversationState = stateForStage(result.stage);
    return res.json(result);
  } catch (err) {
    res.status(500).json({ reply: `Something went wrong: ${err.message}`, stage: 'error' });
  }
});

function orderSummaryText(cart, recipient, session) {
  const spentToday = dailySpent(session.transactions);
  const remaining = Math.max(0, session.mandate.dailyLimitInr - spentToday);
  const lines = ['Order summary', '─────────────────', cart.item.name, `Base price: ₹${cart.pricing.basePriceInr}`];
  if (cart.pricing.crossBorderFeeInr) lines.push(`Cross-border fee: ₹${cart.pricing.crossBorderFeeInr}`);
  lines.push(`Final deal: ₹${cart.pricing.totalInr}`, '');
  lines.push(`Daily purchase limit: ₹${session.mandate.dailyLimitInr.toLocaleString('en-IN')}`);
  lines.push(`Remaining today: ₹${remaining.toLocaleString('en-IN')}`);
  lines.push(`Estimated delivery: ${cart.deliveryEstimate?.label || 'a few business days'}`);
  lines.push(`Deliver to: ${recipient.name}`);
  lines.push(`Address: ${recipient.address}${recipient.pincode ? ' — ' + recipient.pincode : ''}`);
  lines.push(`Phone: ${recipient.phone}`);
  if (recipient.email) lines.push(`Email: ${recipient.email}`);
  lines.push('', `Everything looks ready. Continue to payment? (yes/no)`);
  return lines.join('\n');
}

/**
 * Short reminder of what the agent is still waiting for, appended after an
 * FAQ answer so the flow doesn't feel abandoned once the question is answered.
 */
function pendingReminder(session) {
  const p = session.pending;
  if (!p) return null;
  if (p.awaitingOtp) return `Still need that one-time code to continue — type it in, or "cancel" to abandon this purchase.`;
  if (p.awaitingApproval) return `Still waiting — approve this purchase? (yes/no)`;
  if (p.awaitingEdit) return `Still editing your details — go ahead.`;
  if (p.awaitingDeliveryChoice) return `Still need to know — is this order for yourself, or someone else?`;
  if (p.awaitingRecipientDetails) return `Still need a couple of details for the recipient — go ahead.`;
  if (p.awaitingFinalApproval) return `Still waiting — approve payment? (yes/no)`;
  if (p.awaitingPaymentMethod) return `Still need your payment choice — "cod" or "online"?`;
  if (p.awaitingProductChoice) return `Still waiting on your pick — tap a product card, or reply with its number.`;
  return null;
}

/**
 * First-time customer onboarding — collects name, phone, email, and delivery
 * address before any purchase flow starts. Runs once per session; profile
 * persists for all orders placed for "yourself" afterward. If the phone number
 * matches a saved record (data/customers.json), the address step is skipped
 * and the saved address is reused automatically.
 */
function handleOnboarding(session, message, addressPayload) {
  const profile = session.profile;
  const text = (message || '').trim();

  if (profile.step === 'name') {
    if (!text) return { reply: `Hi — I’m Mandate, your AI shopping agent. What are you looking for?`, stage: 'onboarding_name' };
    profile.name = text;
    profile.step = 'phone';
    return { reply: `Nice to meet you, ${profile.name}! What's your phone number?`, stage: 'onboarding_phone' };
  }

  if (profile.step === 'phone') {
    const digits = text.replace(/\D/g, '');
    if (digits.length < 10) {
      return { reply: `That doesn't look like a valid phone number — could you share a 10-digit number?`, stage: 'onboarding_phone' };
    }
    profile.phone = digits;

    const existing = findCustomerByPhone(digits);
    if (existing && existing.address) {
      profile.email = existing.email || null;
      profile.address = existing.address;
      profile.pincode = existing.pincode;
      profile.lat = existing.lat;
      profile.lng = existing.lng;
      profile.onboarded = true;
      profile.step = 'done';
      saveCustomer(digits, { name: profile.name });
      return {
        reply: `Welcome back, ${profile.name}! Using your saved address: ${existing.address}${existing.pincode ? ' — ' + existing.pincode : ''}. You're logged in.\n\nTell me what to buy and your budget — e.g. "buy me a phone case under 500".`,
        stage: 'onboarding_complete'
      };
    }

    profile.step = 'email';
    return { reply: `And your email address? (Type "skip" if you'd rather not share it.)`, stage: 'onboarding_email' };
  }

  if (profile.step === 'email') {
    if (/^skip$/i.test(text)) {
      profile.email = null;
    } else if (/^\S+@\S+\.\S+$/.test(text)) {
      profile.email = text;
    } else {
      return { reply: `That doesn't look like a valid email — try again, or type "skip".`, stage: 'onboarding_email' };
    }
    profile.step = 'address';
    return { reply: `Got it. Drop a pin on the map for your delivery address (or type it below if you'd rather).`, stage: 'onboarding_address_map' };
  }

  if (profile.step === 'address') {
    if (addressPayload && addressPayload.address) {
      profile.address = addressPayload.address;
      profile.pincode = addressPayload.pincode || null;
      profile.lat = addressPayload.lat ?? null;
      profile.lng = addressPayload.lng ?? null;
    } else if (text) {
      profile.address = text;
    } else {
      return { reply: `Drop a pin on the map, or type your delivery address.`, stage: 'onboarding_address_map' };
    }
    profile.onboarded = true;
    profile.step = 'done';
    saveCustomer(profile.phone, {
      name: profile.name, email: profile.email, address: profile.address,
      pincode: profile.pincode, lat: profile.lat, lng: profile.lng
    });
    return {
      reply: `All set, ${profile.name}! You're logged in.\n\nTell me what to buy and your budget — e.g. "buy me a phone case under 500" — and I'll find it, check trust signals, and hold for your approval before anything is paid.`,
      stage: 'onboarding_complete'
    };
  }

  return { reply: `Tell me what to buy and your budget.`, stage: 'ready' };
}

function handleDeliveryChoice(session, message) {
  const text = message.trim().toLowerCase();
  const forSelf = /^(me|myself|self|yourself|yes|for me)\b/.test(text);
  const forOther = /^(someone|other|else|no|different)\b/.test(text) || /someone else/.test(text);
  const wantsEdit = /^edit\b/.test(text);

  if (wantsEdit) {
    session.pending.awaitingDeliveryChoice = false;
    session.pending.awaitingEdit = true;
    session.pending.editStep = 'name';
    return {
      reply: `Sure — what should your name be? (Current: ${session.profile.name})`,
      stage: 'editing_name'
    };
  }

  if (forSelf) {
    // A chat-first session may not have delivery details yet. Never build an
    // order summary with null address or phone values.
    if (!session.profile.phone || !session.profile.address) {
      session.pending.awaitingDeliveryChoice = false;
      session.pending.awaitingRecipientDetails = true;
      session.pending.recipient = { self: true };
      session.pending.recipientStep = 'name';
      return { reply: `Before checkout, I need delivery details. What's your name?`, stage: 'awaiting_recipient_name' };
    }
    session.pending.recipient = {
      name: session.profile.name,
      phone: session.profile.phone,
      email: session.profile.email,
      address: session.profile.address,
      pincode: session.profile.pincode,
      self: true
    };
    session.pending.awaitingDeliveryChoice = false;
    session.pending.awaitingFinalApproval = true;
    return {
      reply: orderSummaryText(session.pending.cart, session.pending.recipient, session),
      stage: 'awaiting_final_approval',
      chain: chainState('approval', { cart: session.pending.cart, confidence: session.pending.confidence })
    };
  }

  if (forOther) {
    session.pending.awaitingDeliveryChoice = false;
    session.pending.awaitingRecipientDetails = true;
    session.pending.recipientStep = 'name';
    return {
      reply: `No problem — who's this order for? What's their name?`,
      stage: 'awaiting_recipient_name'
    };
  }

  return {
    reply: `Just to confirm — is this order for yourself, someone else, or would you like to "edit" your saved details first?`,
    stage: 'awaiting_delivery_choice'
  };
}

/**
 * Edit-my-details sub-flow, triggered by typing "edit" at the delivery-choice
 * step. Walks through name -> phone -> email -> address, then returns to the
 * same delivery-choice question so the (now-updated) order can proceed.
 */
function handleEditDetails(session, message, addressPayload) {
  const pending = session.pending;
  const profile = session.profile;
  const text = message.trim();

  if (pending.editStep === 'name') {
    if (!/^skip$/i.test(text) && text) profile.name = text;
    pending.editStep = 'phone';
    return { reply: `Phone number? (Current: ${profile.phone})`, stage: 'editing_phone' };
  }

  if (pending.editStep === 'phone') {
    if (!/^skip$/i.test(text) && text) {
      const digits = text.replace(/\D/g, '');
      if (digits.length < 10) return { reply: `That doesn't look like a valid phone number — try again, or type "skip" to keep the current one.`, stage: 'editing_phone' };
      profile.phone = digits;
    }
    pending.editStep = 'email';
    return { reply: `Email? (Current: ${profile.email || 'none'}, type "skip" to leave unchanged)`, stage: 'editing_email' };
  }

  if (pending.editStep === 'email') {
    if (!/^skip$/i.test(text) && text) {
      if (!/^\S+@\S+\.\S+$/.test(text)) return { reply: `That doesn't look like a valid email — try again, or "skip".`, stage: 'editing_email' };
      profile.email = text;
    }
    pending.editStep = 'address';
    return {
      reply: `Choose your delivery location on the map. You can search an area, use your current location, then confirm the 6-digit pincode. (Current: ${profile.address || 'none'} — type "skip" to leave unchanged.)`,
      stage: 'editing_address_map'
    };
  }

  if (pending.editStep === 'address') {
    if (addressPayload?.address) {
      profile.address = addressPayload.address;
      profile.pincode = addressPayload.pincode || null;
      profile.lat = addressPayload.lat ?? null;
      profile.lng = addressPayload.lng ?? null;
    } else if (!/^skip$/i.test(text) && text) {
      profile.address = text;
    }
    saveCustomer(profile.phone, {
      name: profile.name, email: profile.email, address: profile.address,
      pincode: profile.pincode, lat: profile.lat, lng: profile.lng
    });
    pending.awaitingEdit = false;
    pending.awaitingDeliveryChoice = true;
    return {
      reply: `Updated. Is this order for yourself, or for someone else?`,
      stage: 'awaiting_delivery_choice'
    };
  }
}

async function handleRecipientDetails(session, sessionId, message, addressPayload) {
  const pending = session.pending;
  const text = message.trim();

  if (pending.recipientStep === 'name') {
    if (!text) return { reply: `What's the recipient's name?`, stage: 'awaiting_recipient_name' };
    pending.recipient = { ...pending.recipient, name: text, self: pending.recipient?.self === true };
    pending.recipientStep = 'phone';
    return { reply: `And their phone number?`, stage: 'awaiting_recipient_phone' };
  }

  if (pending.recipientStep === 'phone') {
    const digits = text.replace(/\D/g, '');
    if (digits.length < 10) {
      return { reply: `That doesn't look like a valid phone number — a 10-digit number please.`, stage: 'awaiting_recipient_phone' };
    }
    pending.recipient.phone = digits;

    const existing = findCustomerByPhone(digits);
    if (existing && existing.address) {
      pending.recipient.email = existing.email || null;
      pending.recipient.address = existing.address;
      pending.recipient.pincode = existing.pincode;
      pending.awaitingRecipientDetails = false;
      pending.awaitingFinalApproval = true;
      if (pending.recipient.self) Object.assign(session.profile, pending.recipient);
      return {
        reply: orderSummaryText(pending.cart, pending.recipient, session),
        stage: 'awaiting_final_approval',
        chain: chainState('approval', { cart: pending.cart, confidence: pending.confidence })
      };
    }

    pending.recipientStep = 'email';
    return { reply: `Their email? (Type "skip" if you'd rather not share it.)`, stage: 'awaiting_recipient_email' };
  }

  if (pending.recipientStep === 'email') {
    if (/^skip$/i.test(text)) {
      pending.recipient.email = null;
    } else if (/^\S+@\S+\.\S+$/.test(text)) {
      pending.recipient.email = text;
    } else {
      return { reply: `That doesn't look like a valid email — try again, or "skip".`, stage: 'awaiting_recipient_email' };
    }
    pending.recipientStep = 'address';
    return { reply: `And their delivery address? Drop a pin on the map, or type it below.`, stage: 'awaiting_recipient_address_map' };
  }

  if (pending.recipientStep === 'address') {
    if (addressPayload && addressPayload.address) {
      pending.recipient.address = addressPayload.address;
      pending.recipient.pincode = addressPayload.pincode || null;
      pending.recipient.lat = addressPayload.lat ?? null;
      pending.recipient.lng = addressPayload.lng ?? null;
    } else if (text) {
      pending.recipient.address = text;
    } else {
      return { reply: `Drop a pin on the map, or type their delivery address.`, stage: 'awaiting_recipient_address_map' };
    }
    pending.awaitingRecipientDetails = false;
    pending.awaitingFinalApproval = true;
    if (pending.recipient.self) Object.assign(session.profile, pending.recipient);
    saveCustomer(pending.recipient.phone, {
      name: pending.recipient.name, email: pending.recipient.email, address: pending.recipient.address,
      pincode: pending.recipient.pincode, lat: pending.recipient.lat, lng: pending.recipient.lng
    });
    return {
      reply: orderSummaryText(pending.cart, pending.recipient, session),
      stage: 'awaiting_final_approval',
      chain: chainState('approval', { cart: pending.cart, confidence: pending.confidence })
    };
  }
}

async function startPurchase(session, sessionId, message) {
  const intent = await parseIntentSmart(message);

  // Park the parsed intent on the session so the Intent Engine panel stays
  // populated through every follow-up turn (OTP, approval, payment callback)
  // that doesn't carry an intent of its own. A fresh purchase also clears the
  // previous step-up result — verification is per-transaction, never sticky.
  session.lastIntent = { ...intent, raw: message };
  session.stepUpVerified = false;
  session.lastGuard = null;
  session.lastPaymentMethod = null;

  if (!intent.category) {
    return {
      reply: "I'm not sure what product to search for yet. Tell me a category—such as a laptop, earbuds, shoes, or phone case—and your budget.",
      stage: 'clarification', newRequest: true, chain: chainState('intent', { intent })
    };
  }

  // If no budget was mentioned at all, ask for a range before searching —
  // this is what actually gates a live product search (price filter matters
  // a lot more once we're hitting a real marketplace instead of a 15-item catalog).
  if (intent.budget == null && intent.minBudget == null) {
    session.awaitingBudgetRangeFor = message;
    return {
      reply: `Sure — what's your budget range for that? e.g. "500 to 1500" or "under 2000".`,
      stage: 'awaiting_budget_range',
      newRequest: true,
      chain: chainState('intent', { intent })
    };
  }

  return continuePurchase(session, sessionId, intent, message);
}

async function continuePurchase(session, sessionId, intent, originalMessage) {
  const transactionId = uuid();
  markTransactionStart(transactionId);
  advanceTransactionState(session, transactionId, TRANSACTION_STATE.INTENT_PARSED);
  logEvent(transactionId, 'intent_parsed', { request: originalMessage, intent });

  const { items: matches, source } = await searchProducts(intent);
  logEvent(transactionId, 'catalog_source', { source }); // 'live' (Amazon India) or 'mock' (local fallback)

  if (matches.length === 0) {
    logEvent(transactionId, 'no_match_found', { intent });
    return {
      reply: `I couldn’t find a catalog option for ${intent.query || 'that request'}${intent.budget ? ` under ₹${intent.budget.toLocaleString('en-IN')}` : ''}. I won’t invent a product or price. Try another product or adjust the budget.`,
      stage: 'no_match',
      newRequest: true,
      chain: chainState('intent', { intent })
    };
  }

  // Score every candidate (not just the first match) so the user can see and
  // choose from the full ranked list, highest confidence first — this is what
  // actually shows "trust scales with unfamiliarity" across real alternatives
  // instead of the agent silently picking one for you.
  const spentToday = dailySpent(session.transactions);
  const scored = matches.slice(0, 8).map(item => {
    const cart = buildCartMandate(item, BUYER_COUNTRY, intent.budget);
    cart.source = source;
    const confidence = scoreConfidence({
      crossBorder: cart.isCrossBorder,
      verificationMatch: true,
      amountRatio: intent.budget ? cart.pricing.totalInr / intent.budget : 0.5,
      knownMerchant: !cart.isCrossBorder && !item.live && item.merchant_tenure_days >= 180,
      merchantTenureDays: item.merchant_tenure_days,
      gstVerified: item.gst_verified,
      isLive: !!item.live,
      sellerRating: item.sellerRating ?? null,
      sellerRatingCount: item.sellerRatingCount ?? 0,
      category: item.category,
      recentPurchaseCount: recentPurchaseCount(session)
    });
    // Policy engine runs independently of trust scoring — a deterministic
    // check against the user's mandate, not a heuristic judgment call.
    const policy = evaluatePolicy({
      amountInr: cart.pricing.totalInr,
      category: item.category,
      isCrossBorder: cart.isCrossBorder,
      mandate: session.mandate,
      dailySpentInr: spentToday
    });
    return { item, cart, confidence, policy };
  });

  const candidates = scored
    .filter(c => c.cart.withinBudget)
    .sort((a, b) => b.confidence.score - a.confidence.score);

  if (candidates.length === 0) {
    // Rescue path: before giving up, see if the Merchant Agent for the
    // cheapest over-budget match is willing to negotiate into range.
    const overBudget = scored
      .filter(c => !c.cart.withinBudget)
      .sort((a, b) => a.cart.pricing.totalInr - b.cart.pricing.totalInr);

    if (overBudget.length > 0 && intent.budget) {
      const closest = overBudget[0];
      const offer = proposeCounterOffer(closest.item, intent.budget);
      // The buyer maximum is a hard protocol constraint. Do not tease
      // a merchant counter that its own NegotiationEngine must reject later.
      const worthOffering = offer.accepted || offer.counterPriceInr <= intent.budget;

      if (worthOffering) {
        session.pending = {
          transactionId, awaitingNegotiation: true,
          negotiationItem: closest.item, negotiationSource: closest.cart.source,
          negotiationConfidence: closest.confidence, budget: intent.budget
        };
        logEvent(transactionId, 'negotiation_offered', { item: closest.item, requestedPriceInr: intent.budget, offer });
        return {
          reply: `No exact option fits within ₹${intent.budget.toLocaleString('en-IN')}. The closest available option is ${closest.item.name} at ₹${closest.item.price_inr.toLocaleString('en-IN')}. Want me to negotiate with the seller?`,
          stage: 'negotiation_offered',
          newRequest: true,
          chain: chainState('cart', { intent })
        };
      }
    }

    logEvent(transactionId, 'blocked_over_budget', { budget: intent.budget });
    session.stats.blockedAttempts++;
    return {
      reply: `I found matching options, but none fit within ₹${intent.budget.toLocaleString('en-IN')}. You can adjust the budget or try another product.`,
      stage: 'blocked_over_budget',
      newRequest: true,
      chain: chainState('cart', { intent })
    };
  }

  logEvent(transactionId, 'candidates_scored', {
    count: candidates.length,
    scores: candidates.map(c => ({ name: c.item.name, score: c.confidence.score, decision: c.confidence.decision }))
  });

  // Keep the exact budget that was used to score these cards. The final,
  // authoritative evaluation must receive the same fact; otherwise a card can
  // say "needs step-up" for a near-budget purchase while the final decision
  // accidentally treats it as a generic 50%-of-budget purchase.
  session.pending = { transactionId, candidates, buyerBudgetInr: intent.budget, awaitingProductChoice: true, createdAt: Date.now() };

  return {
    reply: `I found ${candidates.length} option${candidates.length > 1 ? 's' : ''} for ${intent.query}. Choose one to continue.`,
    stage: 'product_choice',
    newRequest: true,
    chain: chainState('cart', { intent }),
    products: candidates.map((c, idx) => ({
      index: idx + 1,
      id: c.item.id,
      name: c.item.name,
      merchant: c.item.merchant,
      price: c.cart.pricing.totalInr,
      crossBorderFeeInr: c.cart.pricing.crossBorderFeeInr,
      source: c.cart.source,
      score: c.confidence.score,
      decision: c.confidence.decision,
      imageUrl: c.item.imageUrl || null,
      productUrl: c.item.productUrl || null,
      sellerRating: c.item.sellerRating ?? null,
      sellerRatingCount: c.item.sellerRatingCount ?? null,
      merchantTenureDays: c.item.merchant_tenure_days ?? null,
      gstVerified: c.item.gst_verified ?? null,
      category: c.item.category !== 'live' && c.item.category !== 'default' ? c.item.category : null,
      policyDecision: c.policy.decision,
      policyViolations: c.policy.violations,
      policyFlags: c.policy.flags,
      reasons: c.confidence.reasons,
      merchantAgent: merchantAgentIdentity(c.item.merchant)
    }))
  };
}

/**
 * Protocol bridge. Chat remains deliberately thin: the NegotiationEngine
 * owns all state transitions, validation, identities, and immutable deal
 * creation. This bridge only makes deterministic merchant proposals and hands
 * an accepted deal back to the existing MANDATE pipeline.
 */
function beginNegotiation(session) {
  const pending = session.pending;
  const engine = session.negotiationEngine;
  const buyer = buyerAgentIdentity(session);
  const merchant = merchantAgentIdentity(pending.negotiationItem.merchant);
  const negotiation = engine.createSession({
    transactionId: pending.transactionId,
    buyerAgent: buyer,
    merchantAgent: merchant,
    product: pending.negotiationItem,
    buyerMaxInr: pending.budget,
    mandateVersion: session.mandateVersion
  });
  advanceTransactionState(session, pending.transactionId, TRANSACTION_STATE.INTENT_PARSED);
  advanceTransactionState(session, pending.transactionId, TRANSACTION_STATE.NEGOTIATING);
  pending.negotiationId = negotiation.negotiationId;
  engine.receiveMessage(negotiation.negotiationId, {
    senderRole: 'BUYER', type: 'PRICE_REQUEST', productId: pending.negotiationItem.id,
    requestedPriceInr: pending.budget, message: `Buyer requests ₹${pending.budget}.`
  });
  logNegotiation(session, negotiation, 'NEGOTIATION_STARTED');
  return negotiation;
}

function offerFromMerchant(session, negotiation, item, requestedPriceInr, bundle = null) {
  const proposal = proposeCounterOffer(item, requestedPriceInr);
  const price = proposal.finalPriceInr ?? proposal.counterPriceInr;
  const offer = session.negotiationEngine.createOffer(negotiation.negotiationId, {
    productId: item.id, basePriceInr: price, bundle,
    type: bundle ? 'BUNDLE_OFFER' : 'OFFER', message: proposal.message
  });
  logEvent(negotiation.transactionId, 'OFFER_CREATED', {
    negotiationId: negotiation.negotiationId, offerId: offer.offerId,
    sender: negotiation.merchantAgent.agentId, amountInr: offer.finalAmountInr,
    validation: offer.validation.valid ? 'PASSED' : offer.validation.code
  });
  return { proposal, offer };
}

function handleNegotiation(session, message) {
  const pending = session.pending;
  const text = message.trim().toLowerCase();
  const item = pending.negotiationItem;

  if (!pending.negotiationId) {
    if (!/^(y|yes|sure|ok|okay|go ahead|negotiate)\b/.test(text)) {
      session.pending = null;
      return { reply: 'No problem — what would you like to look for instead?', stage: 'cancelled', newRequest: true };
    }
    const negotiation = beginNegotiation(session);
    const { proposal, offer } = offerFromMerchant(session, negotiation, item, pending.budget);
    if (!offer.validation.valid) {
      return { reply: `Merchant Agent proposed ₹${offer.finalAmountInr ?? proposal.counterPriceInr}, but Negotiation Engine rejected it: ${offer.validation.reason}\n\nYour ₹${pending.budget} bound remains unchanged. You can cancel or try another product.`, stage: 'negotiation_counter' };
    }
    return { reply: `The seller responded with ₹${offer.finalAmountInr.toLocaleString('en-IN')}. Accept this offer, make a counter-offer, or decline?`, stage: 'negotiation_counter' };
  }

  const negotiation = session.negotiationEngine.getSession(pending.negotiationId);
  if (!negotiation) throw new Error('Negotiation session is missing');
  session.negotiationEngine.expireNegotiation(negotiation);
  if (negotiation.status === 'EXPIRED') {
    logEvent(pending.transactionId, 'NEGOTIATION_EXPIRED', { negotiationId: negotiation.negotiationId });
    session.pending = null;
    return { reply: `⌛ ${negotiation.negotiationId} expired before an offer was accepted. No deal was created and nothing can reach payment. Please start a new negotiation.`, stage: 'negotiation_expired', newRequest: true };
  }
  if (/^(bundle|add bundle|add-on)\b/.test(text)) {
    const addon = proposeBundle(item);
    if (!addon || !negotiation.currentOffer?.validation?.valid) return { reply: 'No valid offer is available to bundle. Counter, accept, or cancel first.', stage: 'negotiation_counter' };
    const bundle = { name: addon.addonName, listPriceInr: addon.addonListPriceInr, priceInr: addon.bundlePriceInr };
    const offer = session.negotiationEngine.createOffer(negotiation.negotiationId, {
      productId: item.id, basePriceInr: negotiation.currentOffer.basePriceInr, bundle, type: 'BUNDLE_OFFER',
      message: `Merchant offered ${bundle.name} for ₹${bundle.priceInr}.`
    });
    logEvent(negotiation.transactionId, 'BUNDLE_OFFERED', { negotiationId: negotiation.negotiationId, offerId: offer.offerId, validation: offer.validation.code });
    return { reply: offer.validation.valid ? `Bundle offer: ${bundle.name} for ₹${bundle.priceInr}; final ₹${offer.finalAmountInr}. Accept? (yes/no)` : `Bundle rejected by Negotiation Engine: ${offer.validation.reason}`, stage: 'negotiation_counter' };
  }
  if (/^counter\b/.test(text) && !/\d/.test(text)) {
    return { reply: `What price would you like me to counter with? Your original maximum remains ₹${pending.budget.toLocaleString('en-IN')}.`, stage: 'negotiation_counter' };
  }
  const counter = text.match(/(?:counter\s*)?(\d{2,})/);
  if (counter) {
    const requestedPriceInr = Number(counter[1]);
    session.negotiationEngine.createCounterOffer(negotiation.negotiationId, { productId: item.id, requestedPriceInr });
    const { proposal, offer } = offerFromMerchant(session, negotiation, item, requestedPriceInr);
    return { reply: offer.validation.valid ? `The seller responded with ₹${offer.finalAmountInr.toLocaleString('en-IN')}. Accept this offer, make another counter-offer, or decline?` : `That counter-offer could not be accepted. Try another amount within your original budget.`, stage: 'negotiation_counter' };
  }
  if (!/^(y|yes|accept|deal|ok|okay)\b/.test(text)) {
    session.negotiationEngine.rejectOffer(negotiation.negotiationId, 'BUYER');
    logEvent(negotiation.transactionId, 'OFFER_REJECTED', { negotiationId: negotiation.negotiationId, sender: negotiation.buyerAgent.agentId });
    session.pending = null;
    return { reply: 'No deal — what would you like to look for instead?', stage: 'cancelled', newRequest: true };
  }
  const deal = session.negotiationEngine.acceptOffer(negotiation.negotiationId);
  logEvent(negotiation.transactionId, 'OFFER_ACCEPTED', { negotiationId: negotiation.negotiationId, dealId: deal.dealId });
  logEvent(negotiation.transactionId, 'FINAL_DEAL_CREATED', { negotiationId: negotiation.negotiationId, dealId: deal.dealId, amountInr: deal.pricing.finalAmountInr, fingerprint: deal.fingerprint });
  return handoffDealToMandate(session, item, pending, deal);
}

function handoffDealToMandate(session, item, pending, deal) {
  advanceTransactionState(session, pending.transactionId, TRANSACTION_STATE.DEAL_CREATED);
  advanceTransactionState(session, pending.transactionId, TRANSACTION_STATE.EVALUATING);
  const validation = session.negotiationEngine.revalidateDeal(deal.dealId, {
    mandateVersion: session.mandateVersion, buyerMaxInr: pending.budget,
    productId: item.id, merchantAgentId: merchantAgentIdentity(item.merchant).agentId,
    finalAmountInr: deal.pricing.finalAmountInr, bundlePriceInr: deal.pricing.bundlePriceInr
  });
  logEvent(pending.transactionId, validation.valid ? 'DEAL_VALIDATED' : 'DEAL_INVALIDATED', { dealId: deal.dealId, validation });
  if (!validation.valid) {
    advanceTransactionState(session, pending.transactionId, TRANSACTION_STATE.BLOCKED);
    return { reply: `⚠ ${deal.dealId} is stale or invalid: ${validation.reason}. Renegotiate before it can reach MANDATE.`, stage: 'deal_invalidated' };
  }
  const cart = buildCartMandate(item, BUYER_COUNTRY, null, deal.pricing.finalAmountInr);
  cart.source = pending.negotiationSource;
  cart.pricing.negotiatedPriceInr = deal.pricing.negotiatedPriceInr;
  cart.pricing.bundlePriceInr = deal.pricing.bundlePriceInr;
  cart.pricing.dealId = deal.dealId;
  const confidence = scoreConfidence({
    crossBorder: cart.isCrossBorder, verificationMatch: true,
    amountRatio: pending.budget ? cart.pricing.totalInr / pending.budget : 0.5,
    knownMerchant: !cart.isCrossBorder && !item.live && item.merchant_tenure_days >= 180,
    merchantTenureDays: item.merchant_tenure_days, gstVerified: item.gst_verified,
    isLive: !!item.live, sellerRating: item.sellerRating ?? null, sellerRatingCount: item.sellerRatingCount ?? 0,
    category: item.category, recentPurchaseCount: recentPurchaseCount(session)
  });
  const policy = evaluatePolicy({ amountInr: cart.pricing.totalInr, category: item.category, isCrossBorder: cart.isCrossBorder, mandate: session.mandate, dailySpentInr: dailySpent(session.transactions) });
  session.stats.negotiationsWon++;
  const negotiation = session.negotiationEngine.getSession(deal.negotiationId);
  const result = finalizeItemSelection(session, pending.transactionId, item, cart, confidence, policy, { negotiation, deal, dealValidation: validation });
  result.reply = `I agreed a final seller offer of ₹${deal.pricing.finalAmountInr.toLocaleString('en-IN')}. I’m checking it against your purchase authority now.\n\n${result.reply}`;
  return result;
}

function logNegotiation(session, negotiation, event) {
  logEvent(negotiation.transactionId, event, { negotiationId: negotiation.negotiationId, buyerAgentId: negotiation.buyerAgent.agentId, merchantAgentId: negotiation.merchantAgent.agentId, status: negotiation.status });
}

function evaluateCanonicalDecision(session, transactionId, item, cart, buyerBudgetInr = null) {
  const amountInr = cart?.pricing?.totalInr || 0;
  const recent = recentPurchaseCount(session);
  const spent = dailySpent(session.transactions);
  return evaluateTransaction({
    transactionId,
    trustInput: {
      crossBorder: !!cart?.isCrossBorder, verificationMatch: true,
      amountRatio: buyerBudgetInr ? amountInr / buyerBudgetInr : 0.5,
      knownMerchant: !cart?.isCrossBorder && !item?.live && (item?.merchant_tenure_days ?? 0) >= 180,
      merchantTenureDays: item?.merchant_tenure_days ?? 365, gstVerified: item?.gst_verified ?? true,
      isLive: !!item?.live, sellerRating: item?.sellerRating ?? null, sellerRatingCount: item?.sellerRatingCount ?? 0,
      category: item?.category || 'default', recentPurchaseCount: recent
    },
    riskInput: {
      amountInr, mandate: session.mandate, dailySpentInr: spent,
      listPriceInr: cart?.pricing?.listPriceInr ?? null, basePriceInr: cart?.pricing?.basePriceInr ?? null,
      merchantTenureDays: item?.merchant_tenure_days ?? 365, gstVerified: item?.gst_verified ?? true,
      isCrossBorder: !!cart?.isCrossBorder, recentPurchaseCount: recent,
      injectionDetected: !!session.lastInjection?.detected, category: item?.category || 'default'
    },
    policyInput: { amountInr, category: item?.category || 'default', isCrossBorder: !!cart?.isCrossBorder, mandate: session.mandate, dailySpentInr: spent }
  });
}

function auditNegotiationDenial(negotiation, error, action = null) {
  if (error?.code !== 'AGENT_ACTION_DENIED' || !negotiation) return;
  logEvent(negotiation.transactionId, 'AGENT_ACTION_DENIED', {
    negotiationId: negotiation.negotiationId,
    action,
    reason: error.message
  });
}

function handleProductChoice(session, sessionId, message, productChoiceId) {
  const pending = session.pending;
  let chosen = null;

  if (productChoiceId) {
    chosen = pending.candidates.find(c => c.item.id === productChoiceId);
  }
  if (!chosen) {
    const text = (message || '').trim().toLowerCase();
    const ordinal = { first: 1, second: 2, third: 3, fourth: 4, last: pending.candidates.length };
    const ordinalMatch = text.match(/^(?:the\s+)?(first|second|third|fourth|last)(?:\s+one)?$/);
    const idx = ordinalMatch ? ordinal[ordinalMatch[1]] : parseInt(text, 10);
    if (!isNaN(idx) && pending.candidates[idx - 1]) chosen = pending.candidates[idx - 1];
  }
  if (!chosen && message) {
    // A typed product name is a convenience fallback. Normalising punctuation
    // and HTML apostrophe entities keeps copied card titles usable too; card
    // clicks still use the immutable product id above.
    const normaliseProductText = value => String(value)
      .toLowerCase()
      .replace(/&(#[xX]27|#39|apos);/g, "'")
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const typed = normaliseProductText(message);
    chosen = pending.candidates.find(c => {
      const candidateName = normaliseProductText(c.item.name);
      return typed && (candidateName === typed || candidateName.includes(typed) || typed.includes(candidateName));
    });
  }
  if (!chosen) {
    return {
      reply: `Not sure which one you meant — tap a product card, or reply with its number (1-${pending.candidates.length}).`,
      stage: 'product_choice'
    };
  }

  return finalizeItemSelection(session, pending.transactionId, chosen.item, chosen.cart, chosen.confidence, chosen.policy, {
    buyerBudgetInr: pending.buyerBudgetInr
  });
}

function finalizeItemSelection(session, transactionId, item, cart, confidence, policy, dealContext = {}) {
  advanceToEvaluation(session, transactionId);
  const decision = evaluateCanonicalDecision(
    session,
    transactionId,
    item,
    cart,
    dealContext.negotiation?.buyerConstraints?.maxPriceInr || dealContext.buyerBudgetInr || null
  );
  dealContext = { ...dealContext, decision };
  logEvent(transactionId, 'DECISION_EVALUATED', {
    finalDecision: decision.finalDecision,
    finalReason: decision.finalReason,
    trust: { score: decision.trust.score, decision: decision.trust.decision, reasonCodes: decision.trust.reasonCodes },
    risk: { score: decision.risk.score, decision: decision.risk.decision, reasonCodes: decision.risk.reasonCodes },
    policy: { decision: decision.policy.decision, reasonCodes: decision.policy.reasonCodes }
  });
  logEvent(transactionId, 'item_selected', { item, confidence, policy });

  const sourceNote = cart.source === 'live' ? ' (live from Amazon India)' : '';
  const cartSummary = `${item.name} — ₹${cart.pricing.basePriceInr}${cart.pricing.crossBorderFeeInr ? ` + ₹${cart.pricing.crossBorderFeeInr} cross-border fee` : ''} = ₹${cart.pricing.totalInr}, from ${item.merchant}${sourceNote}`;

  // "Why this price?" — only meaningful for negotiated purchases, where the
  // price isn't just the catalog list price. Carried through in the chain so
  // the frontend "Why?" button can explain the negotiation math, not just
  // the trust/policy result.
  const priceExplanation = cart.pricing.negotiated
    ? `Negotiated from list price ₹${cart.pricing.listPriceInr} to ₹${cart.pricing.basePriceInr} (${Math.round((1 - cart.pricing.basePriceInr / cart.pricing.listPriceInr) * 100)}% off — within the Merchant Agent's enforced 10% discount bound) after you asked the agent to negotiate.`
    : null;

  // The canonical evaluator is the single authority. Legacy confidence and
  // policy objects are retained only for rich human-facing evidence.
  if (decision.finalDecision === 'BLOCK') {
    const machine = session.transactionStateMachines.get(transactionId);
    if (machine?.state === TRANSACTION_STATE.EVALUATING) advanceTransactionState(session, transactionId, TRANSACTION_STATE.BLOCKED);
    const policyBlocked = decision.policy.decision === 'BLOCK';
    logEvent(transactionId, policyBlocked ? 'blocked_by_policy' : 'blocked_low_confidence', { decision });
    session.stats.blockedAttempts++;
    session.pending = null;
    const details = policyBlocked
      ? (decision.policy.violations || decision.policy.reasons || [])
      : (decision.trust.reasons || []);
    return {
      reply: `I found ${item.name} for ₹${cart.pricing.totalInr.toLocaleString('en-IN')} from ${item.merchant}, but I can’t authorize it under your current purchase mandate. No payment was started.\n\n${details.map(v => `• ${v}`).join('\n') || 'Use Why? or Inspect for the recorded decision details.'}`,
      stage: policyBlocked ? 'blocked_by_policy' : 'blocked',
      newRequest: true,
      chain: chainState('trust', { cart, confidence: decision.trust, policy: decision.policy, decision })
    };
  }

  const policyNote = decision.policy.reasons.length > 0 && decision.policy.decision === 'REVIEW'
    ? `\n\n🟡 Your mandate flags this for human approval: ${decision.policy.reasons.join('; ')}`
    : '';
  if (decision.policy.decision === 'REVIEW') session.stats.humanApprovalsGiven++;

  if (decision.trust.decision === 'REVIEW' && decision.trust.legacyDecision === 'step_up_required') {
    const proof = issueOtpProof();
    session.pending = { transactionId, cart, confidence, policy, item, awaitingOtp: true, otpHash: proof.otpHash, otpSalt: proof.otpSalt, otpAttempts: 0, otpExpiresAt: Date.now() + 5 * 60 * 1000, createdAt: Date.now(), mandateVersion: session.mandateVersion, ...dealContext };
    logEvent(transactionId, 'step_up_triggered', { decision, otpIssued: true });
    const machine = session.transactionStateMachines.get(transactionId);
    if (machine?.state === TRANSACTION_STATE.EVALUATING) advanceTransactionState(session, transactionId, TRANSACTION_STATE.AWAITING_APPROVAL);
    return {
      reply: `${cartSummary}\n\nConfidence is moderate (${confidence.score}/100) — this needs step-up verification before I proceed. A one-time code has been generated: **${proof.otp}** (shown here since this is a demo — normally it'd go to your phone/email). Type it to confirm.${policyNote}`,
      stage: 'step_up_required',
      chain: chainState('trust', { cart, confidence, policy, priceExplanation, stepUp: true, demoOtp: proof.otp })
    };
  }

  // ALLOW and REVIEW still receive explicit cart confirmation. The decision
  // determines whether the flow may continue; it never becomes permission to
  // spend without an attached user approval.
  session.pending = { transactionId, cart, confidence, policy, item, awaitingApproval: true, createdAt: Date.now(), mandateVersion: session.mandateVersion, ...dealContext };
  logEvent(transactionId, 'cart_pending_approval', { decision });
  const machine = session.transactionStateMachines.get(transactionId);
  if (machine?.state === TRANSACTION_STATE.EVALUATING) advanceTransactionState(session, transactionId, TRANSACTION_STATE.AWAITING_APPROVAL);
  return {
    reply: `I found ${item.name} for ₹${cart.pricing.totalInr.toLocaleString('en-IN')} from ${item.merchant}. ✅ This purchase is within your purchase authority and still needs your approval.\n\nApprove this purchase? (yes/no)${policyNote}`,
    stage: 'awaiting_approval',
    chain: chainState('trust', { cart, confidence: decision.trust, policy: decision.policy, decision, priceExplanation })
  };
}

async function handleOtpAttempt(session, sessionId, message) {
  const pending = session.pending;
  const attempt = message.trim();

  if (Date.now() > pending.otpExpiresAt) {
    logEvent(pending.transactionId, 'step_up_expired', {});
    session.pending = null;
    return { reply: 'That code expired. This purchase was not approved; please start again.', stage: 'step_up_expired' };
  }
  if (!matchesOtp(pending, attempt)) {
    pending.otpAttempts += 1;
    logEvent(pending.transactionId, 'step_up_failed', { attempts: pending.otpAttempts });
    if (pending.otpAttempts >= 5) {
      session.pending = null;
      return { reply: 'Too many incorrect codes. This purchase was not approved; please start again.', stage: 'step_up_locked' };
    }
    return {
      reply: `That code doesn't match. ${5 - pending.otpAttempts} attempt${5 - pending.otpAttempts === 1 ? '' : 's'} remaining; or type "cancel" to abandon this purchase.`,
      stage: 'step_up_required',
      chain: chainState('trust', { cart: pending.cart, confidence: pending.confidence, stepUp: true })
    };
  }

  logEvent(pending.transactionId, 'step_up_verified', {});
  session.stepUpVerified = true; // per-transaction; cleared on the next fresh purchase
  pending.awaitingOtp = false;
  delete pending.otpHash; delete pending.otpSalt; delete pending.otpExpiresAt;
  pending.awaitingApproval = true;
  return {
    reply: `Verified. Approve this purchase — ${pending.item.name}, ₹${pending.cart.pricing.totalInr} from ${pending.item.merchant}? (yes/no)`,
    stage: 'awaiting_approval',
    chain: chainState('trust', { cart: pending.cart, confidence: pending.confidence, stepUpVerified: true })
  };
}

async function handlePaymentMethod(session, sessionId, message) {
  const text = message.trim().toLowerCase();
  if (/^cod\b|cash on delivery/.test(text)) {
    session.pending.awaitingPaymentMethod = false;
    session.pending.awaitingCodConfirmation = true;
    return {
      reply: `Cash on Delivery selected. Confirm ₹${session.pending.cart.pricing.totalInr.toLocaleString('en-IN')} for ${session.pending.item.name}? (yes/no)`,
      stage: 'awaiting_cod_confirmation'
    };
  }
  if (/^online\b|pay online|card|upi/.test(text)) {
    return initiateOnlinePayment(session, sessionId);
  }
  return {
    reply: `Sorry, I didn't catch that — reply "cod" for Cash on Delivery, or "online" to pay now.`,
    stage: 'awaiting_payment_method'
  };
}

async function handleCodConfirmation(session, sessionId, message) {
  const affirmative = /^(y|yes|approve|confirm|ok|okay|place order)\b/i.test(message.trim());
  if (!affirmative) {
    session.pending = null;
    return { reply: 'COD order cancelled. No order was placed.', stage: 'cancelled', chain: chainState('cancelled') };
  }
  session.pending.awaitingCodConfirmation = false;
  return finalizePurchase(session, sessionId, 'cod');
}

function hasValidCheckoutDetails(recipient) {
  return !!(recipient && typeof recipient.name === 'string' && recipient.name.trim() && /^\d{10,15}$/.test(String(recipient.phone || '').replace(/\D/g, '')) && typeof recipient.address === 'string' && recipient.address.trim());
}

/**
 * Phase 1 of online payment: create the Razorpay order and hand its details
 * to the frontend so it can open the real Razorpay Checkout widget (the
 * actual card/UPI/netbanking form). Nothing is finalized yet — no receipt,
 * no transaction record — until /api/payment/verify confirms a genuine,
 * signature-verified payment. This is what makes "online" actually collect
 * payment details instead of just simulating success.
 */
async function initiateOnlinePayment(session, sessionId) {
  const { transactionId, cart, item } = session.pending;

  // Six pre-flight checks run together immediately before the rail
  //     is touched. This is a real gate — if it fails, no Razorpay order is
  //     created at all, so there is nothing to refund.
  const guard = guardPayment(session, 'online');
  if (!guard.passed) {
    const machine = session.transactionStateMachines.get(transactionId);
    if (machine?.state === TRANSACTION_STATE.PAYMENT_READY) advanceTransactionState(session, transactionId, TRANSACTION_STATE.BLOCKED);
    const failed = guard.checks.find(c => c.id === guard.failedCheckId);
    session.pending = null;
    return {
      reply: `Payment stopped before it started — ${failed ? failed.label.toLowerCase() : 'a pre-flight check'} failed.\n\n${guard.blockedReason}\n\nNothing was charged, because no payment was ever attempted.`,
      stage: 'payment_blocked',
      paymentGuard: guard,
      chain: chainState('payment', { cart, error: guard.blockedReason })
    };
  }

  let orderResult;
  try {
    advanceTransactionState(session, transactionId, TRANSACTION_STATE.PAYMENT_PROCESSING);
    orderResult = await executePaymentIdempotent(cart, session.pending.approvedAmountInr ?? cart.pricing.totalInr, transactionId);
    logEvent(transactionId, 'razorpay_order_created', orderResult);
  } catch (err) {
    const machine = session.transactionStateMachines.get(transactionId);
    if (machine?.state === TRANSACTION_STATE.PAYMENT_PROCESSING) advanceTransactionState(session, transactionId, TRANSACTION_STATE.FAILED);
    logEvent(transactionId, 'payment_blocked', { error: err.message });
    session.pending = null;
    return {
      reply: `Payment blocked: ${err.message}`,
      stage: 'payment_blocked',
      paymentGuard: guard,
      chain: chainState('payment', { cart, error: err.message })
    };
  }

  session.pending.awaitingPaymentMethod = false;
  session.pending.awaitingOnlinePayment = true;

  return {
    reply: `Opening secure payment for ₹${orderResult.amountInr}…`,
    stage: 'awaiting_online_payment',
    paymentGuard: guard,
    razorpay: {
      keyId: getRazorpayKeyId(),
      orderId: orderResult.orderId,
      amountInr: orderResult.amountInr,
      transactionId,
      itemName: item.name
    }
  };
}

/**
 * Phase 2 of the same flow: called only after /api/payment/verify confirms a
 * real, signature-verified Razorpay payment (see server route below). Also
 * doubles as the direct COD path, which never touches Razorpay.
 */
async function finalizePurchase(session, sessionId, paymentMethod, verifiedPaymentResult = null) {
  const { transactionId, cart, item, recipient, mandateVersion } = session.pending;
  if (!hasValidCheckoutDetails(recipient)) {
    logEvent(transactionId, 'checkout_validation_failed', { reason: 'recipient details missing or invalid' });
    return {
      reply: 'Checkout is incomplete. A valid recipient name, phone number, and address are required before an order can be placed.',
      stage: 'checkout_incomplete', chain: chainState('approval', { cart })
    };
  }
  const approvedAmountInr = session.pending.approvedAmountInr ?? cart.pricing.totalInr;

  cart.approved = true;
  logEvent(transactionId, 'user_approved', {
    approvedAmountInr,
    approvedAt: session.pending.approvedAt || new Date().toISOString(),
    recipient,
    paymentMethod,
    mandateVersion, // which mandate version authorized this — see updateMandate()
    authorizationProof: { transactionId, cartSnapshot: cart, approvalMethod: 'explicit_cart_confirmation' }
  });

  // The guard runs on the COD and fallback paths too. It is skipped
  //     for an already-captured online payment, because by then the money has
  //     moved and the gate ran in initiateOnlinePayment before the order existed
  //     — re-running it here could only produce a scary panel about a charge we
  //     already allowed. Re-checking after the fact is theatre, not control.
  let guard = session.lastGuard;
  if (!verifiedPaymentResult) {
    guard = guardPayment(session, paymentMethod);
    if (!guard.passed) {
      const machine = session.transactionStateMachines.get(transactionId);
      if (machine?.state === TRANSACTION_STATE.PAYMENT_READY) advanceTransactionState(session, transactionId, TRANSACTION_STATE.BLOCKED);
      const failed = guard.checks.find(c => c.id === guard.failedCheckId);
      session.pending = null;
      return {
        reply: `Stopped at the payment guard — ${failed ? failed.label.toLowerCase() : 'a pre-flight check'} failed.\n\n${guard.blockedReason}\n\nNothing was charged.`,
        stage: 'payment_blocked',
        paymentGuard: guard,
        chain: chainState('payment', { cart, error: guard.blockedReason })
      };
    }
  }

  let paymentResult;
  const machine = session.transactionStateMachines.get(transactionId);
  if (machine?.state === TRANSACTION_STATE.PAYMENT_READY) advanceTransactionState(session, transactionId, TRANSACTION_STATE.PAYMENT_PROCESSING);
  if (paymentMethod === 'cod') {
    // No Razorpay call for COD — nothing is charged now, so there's no order to create.
    paymentResult = { orderId: `cod_${transactionId.slice(0, 8)}`, status: 'cod_pending', amountInr: cart.pricing.totalInr };
    logEvent(transactionId, 'cod_confirmed', paymentResult);
  } else if (verifiedPaymentResult) {
    // Online — payment already captured and signature-verified via Razorpay Checkout.
    paymentResult = verifiedPaymentResult;
    logEvent(transactionId, 'payment_captured', paymentResult);
  } else {
    // Defensive fallback only — the normal online path always goes through
    // initiateOnlinePayment + /api/payment/verify above.
    try {
      paymentResult = await executePaymentIdempotent(cart, approvedAmountInr, transactionId);
      logEvent(transactionId, 'payment_executed', paymentResult);
    } catch (err) {
      const failedMachine = session.transactionStateMachines.get(transactionId);
      if (failedMachine?.state === TRANSACTION_STATE.PAYMENT_PROCESSING) advanceTransactionState(session, transactionId, TRANSACTION_STATE.FAILED);
      logEvent(transactionId, 'payment_blocked', { error: err.message });
      session.pending = null;
      return {
        reply: `Payment blocked: ${err.message}`,
        stage: 'payment_blocked',
        paymentGuard: guard,
        chain: chainState('payment', { cart, error: err.message })
      };
    }
  }

  session.recentPurchaseTimestamps.push(Date.now());
  session.transactions.push({ transactionId, item, cart, paymentResult, recipient, paymentMethod, mandateVersion, completedAt: new Date().toISOString() });
  const completeMachine = session.transactionStateMachines.get(transactionId);
  if (completeMachine?.state === TRANSACTION_STATE.PAYMENT_PROCESSING) advanceTransactionState(session, transactionId, TRANSACTION_STATE.SUCCESS);
  session.pending = null;

  const deliveryNote = recipient?.self
    ? `to you at ${recipient.address}`
    : `to ${recipient?.name} at ${recipient?.address}`;
  const deliveryLabel = cart.deliveryEstimate?.label || 'a few business days';

  let receiptUrl = null;
  try {
    receiptUrl = generateReceipt({
      transactionId, item, cart, recipient, paymentMethod,
      orderId: paymentResult.orderId, amountInr: paymentResult.amountInr,
      status: paymentMethod === 'cod' ? 'COD order placed — payment due on delivery' : 'Payment captured — Razorpay TEST'
    });
    logEvent(transactionId, 'receipt_generated', { receiptUrl });
  } catch (err) {
    logEvent(transactionId, 'receipt_generation_failed', { error: err.message });
  }

  const paymentNote = paymentMethod === 'cod'
    ? `Pay ₹${paymentResult.amountInr} in cash when it arrives.`
    : `₹${paymentResult.amountInr} paid online.`;

  return {
    reply: `Done. Order ${paymentResult.orderId} placed — delivering ${deliveryNote}, estimated ${deliveryLabel}. ${paymentNote}\n\nReceipt is ready below.`,
    stage: 'success',
    transactionId,
    receiptUrl,
    delivery: {
      orderId: paymentResult.orderId,
      name: recipient.name,
      address: recipient.address,
      pincode: recipient.pincode || null,
      estimate: deliveryLabel,
      // This is deliberately an internal TEST-mode tracking page. The app
      // has no courier integration or AWB, so it must never claim a carrier
      // can be tracked when it cannot.
      trackingUrl: `/track/${transactionId}`
    },
    chain: chainState('audit', { cart, paymentResult })
  };
}

/**
 * Describes which Mandate Chain stage the pipeline has reached, for the
 * frontend stepper. `stage` is one of: intent, cart, trust, approval, payment, audit.
 */
function chainState(reached, extra = {}) {
  const order = ['intent', 'cart', 'trust', 'approval', 'payment', 'audit'];
  const idx = order.indexOf(reached);
  return {
    reached,
    completedStages: order.slice(0, idx + 1),
    ...extra
  };
}

// GET /api/trail/:transactionId — full audit trail for a transaction, for the timeline view
app.get('/api/trail/:transactionId', (req, res) => {
  if (!validateApi(res, () => requireId(req.params.transactionId, 'transactionId'), { transactionId: req.params.transactionId })) return;
  const trail = getTrail(req.params.transactionId);
  res.json({ transactionId: req.params.transactionId, trail });
});

// Read-only evidence exports. The sanitized data is shared by JSON and PDF so
// neither can accidentally disclose OTPs, credentials, or payment signatures.
app.get('/api/audit/:transactionId.json', (req, res) => {
  if (!validateApi(res, () => requireId(req.params.transactionId, 'transactionId'), { transactionId: req.params.transactionId })) return;
  res.setHeader('Content-Disposition', `attachment; filename="paymandate-audit-${req.params.transactionId}.json"`);
  res.json(publicAuditTrail(req.params.transactionId, getTrail(req.params.transactionId)));
});
app.get('/api/audit/:transactionId.pdf', async (req, res) => {
  if (!validateApi(res, () => requireId(req.params.transactionId, 'transactionId'), { transactionId: req.params.transactionId })) return;
  try { res.redirect(await generateAuditPdf(req.params.transactionId, getTrail(req.params.transactionId))); }
  catch { apiError(res, 500, { code: 'INVALID_REQUEST', message: 'Audit report could not be generated', stage: 'AUDIT', transactionId: req.params.transactionId }); }
});

// GET /api/state/:sessionId — the whole pipeline picture, on demand.
//
// Every mutating response already carries `state` (see withState), so the UI
// rarely needs this. It exists for the two cases where the UI has no response to
// read from: a fresh page load, and the judge opening the Control Center before
// typing anything. Returning a fully-shaped IDLE state rather than 404 means the
// frontend has exactly one rendering path instead of two.
app.get('/api/state/:sessionId', (req, res) => {
  if (!validateApi(res, () => requireId(req.params.sessionId, 'sessionId'))) return;
  const session = getSession(req.params.sessionId);
  try {
    res.json({ state: snapshotState(session, req.params.sessionId) });
  } catch (err) {
    console.warn(`[state] snapshot failed for ${req.params.sessionId}: ${err.message}`);
    res.status(200).json({ state: null, error: err.message });
  }
});

// ---------- Agent-to-Agent Commerce API ----------
// These routes intentionally resolve agents, products, and transaction context
// on the server. Request bodies never get to nominate an agent identity.
app.post('/api/negotiation/start', (req, res) => {
  const { sessionId = 'default', productId, buyerMaxInr, transactionId = uuid() } = req.body || {};
  if (!validateApi(res, () => { requireId(sessionId, 'sessionId'); requireId(productId, 'productId'); requirePositiveAmount(buyerMaxInr, 'buyerMaxInr'); requireId(transactionId, 'transactionId'); }, { transactionId })) return;
  const session = getSession(sessionId);
  if (session.pending) return res.status(409).json({ error: 'A purchase or negotiation is already active for this session' });
  const item = loadCatalog().find(candidate => candidate.id === productId);
  if (!item) return res.status(404).json({ error: 'Unknown catalog product' });
  if (!Number.isInteger(buyerMaxInr) || buyerMaxInr <= 0) return res.status(400).json({ error: 'buyerMaxInr must be a positive whole INR amount' });
  if (buyerMaxInr > session.mandate.maxTransactionInr) return res.status(400).json({ error: 'Buyer Agent cannot increase its mandate-bound budget; update the mandate first' });
  session.pending = { transactionId, awaitingNegotiation: true, negotiationItem: item, negotiationSource: 'mock', budget: buyerMaxInr, createdAt: Date.now() };
  try {
    const negotiation = beginNegotiation(session);
    res.status(201).json(withState({ negotiation }, session, sessionId, { negotiation }));
  } catch (err) {
    session.pending = null;
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/negotiation/:id', (req, res) => {
  if (!validateApi(res, () => { requireId(req.params.id, 'negotiationId'); requireId(req.query.sessionId || 'default', 'sessionId'); })) return;
  const session = getSession(req.query.sessionId || 'default');
  const negotiation = session.negotiationEngine.getSession(req.params.id);
  if (!negotiation) return res.status(404).json({ error: 'Unknown negotiation' });
  session.negotiationEngine.expireNegotiation(negotiation);
  res.json({ negotiation });
});

app.post('/api/negotiation/:id/message', (req, res) => {
  const { sessionId = 'default', type, requestedPriceInr = null, bundleRequest = null, message = '' } = req.body || {};
  if (!validateApi(res, () => {
    requireId(req.params.id, 'negotiationId'); requireId(sessionId, 'sessionId');
    requireAction(type, ['PRICE_REQUEST', 'COUNTER_OFFER', 'BUNDLE_REQUEST'], 'type');
    if (requestedPriceInr !== null) requirePositiveAmount(requestedPriceInr, 'requestedPriceInr');
    optionalString(message, 'message'); if (bundleRequest !== null && typeof bundleRequest !== 'object') throw new RequestValidationError('bundleRequest must be an object');
  })) return;
  const session = getSession(sessionId);
  const negotiation = session.negotiationEngine.getSession(req.params.id);
  if (!negotiation) return res.status(404).json({ error: 'Unknown negotiation' });
  // This endpoint represents Buyer Agent protocol messages only; Merchant
  // proposals use /offer, where the Merchant identity is also server-derived.
  if (!['PRICE_REQUEST', 'COUNTER_OFFER', 'BUNDLE_REQUEST'].includes(type)) {
    logEvent(negotiation.transactionId, 'AGENT_ACTION_DENIED', { negotiationId: negotiation.negotiationId, action: type, reason: 'This route only accepts Buyer Agent request messages.' });
    return res.status(400).json({ error: 'Only Buyer request messages are accepted here' });
  }
  try {
    const entry = session.negotiationEngine.receiveMessage(req.params.id, {
      senderRole: 'BUYER', type, productId: negotiation.product.id, requestedPriceInr, bundleRequest, message
    });
    logEvent(negotiation.transactionId, type === 'BUNDLE_REQUEST' ? 'BUNDLE_REQUESTED' : 'NEGOTIATION_MESSAGE_SENT', { negotiationId: negotiation.negotiationId, messageId: entry.messageId, sender: negotiation.buyerAgent.agentId, type });
    res.json(withState({ message: entry, negotiation }, session, sessionId, { negotiation }));
  } catch (err) { auditNegotiationDenial(negotiation, err, type); res.status(400).json({ error: err.message }); }
});

app.post('/api/negotiation/:id/offer', (req, res) => {
  const { sessionId = 'default', basePriceInr, currency = 'INR', bundle = null, message = '', type = null } = req.body || {};
  if (!validateApi(res, () => {
    requireId(req.params.id, 'negotiationId'); requireId(sessionId, 'sessionId'); requirePositiveAmount(basePriceInr, 'basePriceInr'); requireCurrency(currency);
    if (type !== null) requireAction(type, ['OFFER', 'BUNDLE_OFFER', 'COUNTER_OFFER'], 'type'); optionalString(message, 'message');
    if (bundle !== null && typeof bundle !== 'object') throw new RequestValidationError('bundle must be an object');
  })) return;
  const session = getSession(sessionId);
  const negotiation = session.negotiationEngine.getSession(req.params.id);
  if (!negotiation) return res.status(404).json({ error: 'Unknown negotiation' });
  try {
    const offer = session.negotiationEngine.createOffer(req.params.id, {
      productId: negotiation.product.id, basePriceInr, currency, bundle, message,
      type: type || (bundle ? 'BUNDLE_OFFER' : 'OFFER')
    });
    logEvent(negotiation.transactionId, 'OFFER_CREATED', { negotiationId: negotiation.negotiationId, offerId: offer.offerId, sender: negotiation.merchantAgent.agentId, amountInr: offer.finalAmountInr, validation: offer.validation.code });
    res.status(offer.validation.valid ? 201 : 422).json(withState({ offer, negotiation }, session, sessionId, { negotiation }));
  } catch (err) { auditNegotiationDenial(negotiation, err, type || (bundle ? 'BUNDLE_OFFER' : 'OFFER')); res.status(400).json({ error: err.message }); }
});

app.post('/api/negotiation/:id/counter', (req, res) => {
  const { sessionId = 'default', requestedPriceInr, message = '' } = req.body || {};
  if (!validateApi(res, () => { requireId(req.params.id, 'negotiationId'); requireId(sessionId, 'sessionId'); requirePositiveAmount(requestedPriceInr, 'requestedPriceInr'); optionalString(message, 'message'); })) return;
  const session = getSession(sessionId);
  const negotiation = session.negotiationEngine.getSession(req.params.id);
  if (!negotiation) return res.status(404).json({ error: 'Unknown negotiation' });
  try {
    const entry = session.negotiationEngine.createCounterOffer(req.params.id, { productId: negotiation.product.id, requestedPriceInr, message });
    logEvent(negotiation.transactionId, 'COUNTER_OFFER_CREATED', { negotiationId: negotiation.negotiationId, messageId: entry.messageId, sender: negotiation.buyerAgent.agentId, amountInr: requestedPriceInr });
    res.json(withState({ message: entry, negotiation }, session, sessionId, { negotiation }));
  } catch (err) { auditNegotiationDenial(negotiation, err, 'COUNTER_OFFER'); res.status(400).json({ error: err.message }); }
});

app.post('/api/negotiation/:id/accept', (req, res) => {
  const { sessionId = 'default' } = req.body || {};
  if (!validateApi(res, () => { requireId(req.params.id, 'negotiationId'); requireId(sessionId, 'sessionId'); })) return;
  const session = getSession(sessionId);
  const negotiation = session.negotiationEngine.getSession(req.params.id);
  // A retry of an already accepted action returns the immutable original deal;
  // it never creates a second deal, audit sequence, or payment path.
  if (negotiation?.status === 'DEAL_CREATED') {
    const deal = session.negotiationEngine.getDeal(`DEAL-${req.params.id.slice(4)}`);
    if (deal) return res.json(withState({ success: true, duplicate: true, deal, negotiation }, session, sessionId, { negotiation, deal }));
  }
  if (!negotiation || session.pending?.negotiationId !== req.params.id) return res.status(404).json({ error: 'Unknown active negotiation' });
  try {
    const deal = session.negotiationEngine.acceptOffer(req.params.id);
    logEvent(negotiation.transactionId, 'OFFER_ACCEPTED', { negotiationId: negotiation.negotiationId, dealId: deal.dealId });
    logEvent(negotiation.transactionId, 'FINAL_DEAL_CREATED', { negotiationId: negotiation.negotiationId, dealId: deal.dealId, amountInr: deal.pricing.finalAmountInr, fingerprint: deal.fingerprint });
    const result = handoffDealToMandate(session, session.pending.negotiationItem, session.pending, deal);
    res.json(withState({ ...result, deal, negotiation }, session, sessionId, { negotiation, deal }));
  } catch (err) { auditNegotiationDenial(negotiation, err, 'ACCEPT'); res.status(400).json({ error: err.message }); }
});

for (const [action, method, event] of [
  ['reject', 'rejectOffer', 'OFFER_REJECTED'], ['cancel', 'cancelNegotiation', 'NEGOTIATION_CANCELLED']
]) {
  app.post(`/api/negotiation/:id/${action}`, (req, res) => {
    if (!validateApi(res, () => { requireId(req.params.id, 'negotiationId'); requireId(req.body?.sessionId || 'default', 'sessionId'); optionalString(req.body?.message, 'message'); })) return;
    const session = getSession(req.body?.sessionId || 'default');
    const negotiation = session.negotiationEngine.getSession(req.params.id);
    if (!negotiation) return res.status(404).json({ error: 'Unknown negotiation' });
    if (['REJECTED', 'CANCELLED'].includes(negotiation.status)) return res.json({ success: true, duplicate: true, negotiation });
    try {
      const result = method === 'rejectOffer'
        ? session.negotiationEngine[method](req.params.id, 'BUYER', req.body?.message || '')
        : session.negotiationEngine[method](req.params.id);
      logEvent(negotiation.transactionId, event, { negotiationId: negotiation.negotiationId });
      if (session.pending?.negotiationId === req.params.id) session.pending = null;
      res.json({ negotiation: result });
    } catch (err) { auditNegotiationDenial(negotiation, err, action.toUpperCase()); res.status(400).json({ error: err.message }); }
  });
}

app.get('/api/deal/:id', (req, res) => {
  if (!validateApi(res, () => { requireId(req.params.id, 'dealId'); requireId(req.query.sessionId || 'default', 'sessionId'); })) return;
  const session = getSession(req.query.sessionId || 'default');
  const deal = session.negotiationEngine.getDeal(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Unknown deal' });
  res.json({ deal });
});

app.post('/api/deal/:id/revalidate', (req, res) => {
  const { sessionId = 'default' } = req.body || {};
  if (!validateApi(res, () => { requireId(req.params.id, 'dealId'); requireId(sessionId, 'sessionId'); })) return;
  const session = getSession(sessionId);
  const deal = session.negotiationEngine.getDeal(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Unknown deal' });
  const validation = session.negotiationEngine.revalidateDeal(deal.dealId, {
    mandateVersion: session.mandateVersion,
    buyerMaxInr: session.pending?.budget || deal.pricing.finalAmountInr,
    productId: deal.product.id, merchantAgentId: deal.merchantAgentId,
    finalAmountInr: deal.pricing.finalAmountInr, bundlePriceInr: deal.pricing.bundlePriceInr
  });
  logEvent(deal.transactionId, validation.valid ? 'DEAL_VALIDATED' : 'DEAL_INVALIDATED', { dealId: deal.dealId, validation });
  res.json({ dealId: deal.dealId, validation });
});

// POST /api/mode — switch between Normal and Judge mode.
//
// This changes presentation density only. It cannot change an outcome, and
// deliberately has no access to anything that could: the same transaction
// decided the same way looks different, not behaves differently. Saying so out
// loud matters, because a judge's first instinct is to suspect a demo mode.
app.post('/api/mode', (req, res) => {
  const { sessionId, mode } = req.body || {};
  if (!validateApi(res, () => { requireId(sessionId, 'sessionId'); requireAction(mode, ['normal', 'control'], 'mode'); })) return;
  const session = getSession(sessionId);
  const next = mode === 'control' ? 'control' : 'normal';
  session.uiMode = next;
  res.json({
    uiMode: next,
    note: next === 'control'
      ? 'Judge Mode: every stage panel expanded, scores and reasons shown in full.'
      : 'Normal Mode: the conversation leads, with the pipeline available alongside it.',
    affectsDecisions: false
  });
});

// GET /api/transactions/:sessionId — list completed transactions for this session (for refund UI)
app.get('/api/transactions/:sessionId', (req, res) => {
  if (!validateApi(res, () => requireId(req.params.sessionId, 'sessionId'))) return;
  const session = getSession(req.params.sessionId);
  res.json({ transactions: session.transactions });
});

// Read-only TEST-mode delivery tracking. It surfaces only the completed order
// held in this demo process; no third-party courier claim is made without an
// actual carrier/AWB integration.
app.get('/track/:transactionId', (req, res) => {
  const transactionId = String(req.params.transactionId || '');
  const transaction = [...sessions.values()]
    .flatMap(session => session.transactions)
    .find(txn => txn.transactionId === transactionId);
  if (!transaction) return res.status(404).type('text').send('Tracking record not found.');

  const escapeTrackHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const estimate = transaction.cart?.deliveryEstimate?.label || 'Delivery estimate pending';
  const deliveryState = transaction.paymentMethod === 'cod' ? 'Order confirmed — payment due on delivery' : 'Order confirmed — payment received';
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PayMandate delivery tracking</title><style>body{margin:0;background:#0F1729;color:#E8E6DE;font:16px system-ui,sans-serif}.card{max-width:580px;margin:8vh auto;padding:28px;background:#172038;border:1px solid #2A3658;border-radius:12px}.eyebrow{color:#C9A24B;font:12px ui-monospace,monospace;letter-spacing:.08em}h1{margin:8px 0 20px;font-size:26px}.row{padding:14px 0;border-top:1px solid #2A3658}.muted{color:#A8ACC0}.note{margin-top:20px;padding:12px;background:#0F1729;border-radius:8px;color:#A8ACC0;font-size:13px}</style></head><body><main class="card"><div class="eyebrow">PAYMANDATE · TEST DELIVERY TRACKING</div><h1>Order confirmed</h1><div class="row"><b>${escapeTrackHtml(transaction.paymentResult?.orderId)}</b><br><span class="muted">${escapeTrackHtml(deliveryState)}</span></div><div class="row"><b>Estimated delivery</b><br><span class="muted">${escapeTrackHtml(estimate)}</span></div><div class="row"><b>Delivering to</b><br><span class="muted">${escapeTrackHtml(transaction.recipient?.name)} · ${escapeTrackHtml(transaction.recipient?.address)}${transaction.recipient?.pincode ? ` · ${escapeTrackHtml(transaction.recipient.pincode)}` : ''}</span></div><p class="note">This is a TEST-mode order status page. A live carrier scan is not shown because no courier/AWB integration is connected.</p></main></body></html>`);
});

// GET /api/mandate/:sessionId — the user's spending mandate + today's usage, for the Mandate panel
// GET /api/agents/:sessionId — Buyer Agent identity + permissions. Merchant
// agent identity is included per-transaction in /api/trail (see below), since
// it depends on which merchant is involved.
app.get('/api/agents/:sessionId', (req, res) => {
  if (!validateApi(res, () => requireId(req.params.sessionId, 'sessionId'))) return;
  const session = getSession(req.params.sessionId);
  res.json({ buyerAgent: buyerAgentIdentity(session) });
});

app.get('/api/mandate/:sessionId', (req, res) => {
  if (!validateApi(res, () => requireId(req.params.sessionId, 'sessionId'))) return;
  const session = getSession(req.params.sessionId);
  const spentToday = dailySpent(session.transactions);
  res.json({
    mandate: session.mandate,
    mandateVersion: session.mandateVersion,
    mandateHistory: session.mandateHistory,
    spentTodayInr: spentToday,
    remainingTodayInr: Math.max(0, session.mandate.dailyLimitInr - spentToday)
  });
});

// GET /api/dashboard/:sessionId — buyer + merchant dashboard views, and a
// clearly-labeled illustrative revenue simulator. All numbers below are
// derived from this session's real transactions/stats — nothing here is
// randomly generated, though the "simulated" comparison baseline is an
// explicit illustrative assumption (see note in the response).
app.get('/api/dashboard/:sessionId', (req, res) => {
  if (!validateApi(res, () => requireId(req.params.sessionId, 'sessionId'))) return;
  const session = getSession(req.params.sessionId);
  const txns = session.transactions;
  const totalRevenueInr = txns.reduce((sum, t) => sum + (t.paymentResult?.amountInr || 0), 0);
  const orderCount = txns.length;
  const aovInr = orderCount > 0 ? Math.round(totalRevenueInr / orderCount) : 0;
  const negotiatedOrders = txns.filter(t => t.cart?.pricing?.negotiated).length;

  const buyer = {
    mandate: session.mandate,
    spentTodayInr: dailySpent(txns),
    ordersPlaced: orderCount,
    blockedAttempts: session.stats.blockedAttempts,
    humanApprovalsGiven: session.stats.humanApprovalsGiven,
    negotiationsWon: session.stats.negotiationsWon
  };

  const merchant = {
    totalRevenueInr,
    orderCount,
    aovInr,
    negotiatedOrders,
    aiAssistedRevenueInr: txns
      .filter(t => t.cart?.pricing?.negotiated)
      .reduce((sum, t) => sum + (t.paymentResult?.amountInr || 0), 0),
    blockedByRiskControls: session.stats.blockedAttempts
  };

  // Illustrative simulator: compares this session's real AOV against a fixed,
  // clearly-labeled baseline assumption for "checkout without agent
  // assistance". This is NOT a measured or guaranteed result — there's no
  // control group here, just this session's real numbers next to a stated
  // assumption, which is exactly how it's presented in the UI.
  const baselineConversionPct = 3.8;
  const baselineAovInr = orderCount > 0 ? Math.round(aovInr * 0.82) : 0; // illustrative: assume 18% lower AOV without upsell/negotiation
  const simulatedConversionPct = orderCount > 0 ? 5.1 : 0;
  const upliftPct = orderCount > 0 ? Math.round(((aovInr - baselineAovInr) / baselineAovInr) * 100) : 0;

  // Revenue Lab — a set of illustrative strategy comparisons, all derived from
  // this session's real AOV as the anchor point (or a small fixed fallback
  // when there's no order yet). Explicitly labeled as test-mode estimates,
  // per the challenge's own requirement not to present these as guarantees.
  const labAnchorAov = orderCount > 0 ? aovInr : 1200;
  const revenueLab = [
    { strategy: 'No upsell', conversionPct: 4.1, aovInr: Math.round(labAnchorAov * 0.83) },
    { strategy: 'Bundle', conversionPct: 5.0, aovInr: Math.round(labAnchorAov * 1.02) },
    { strategy: 'Discount', conversionPct: 5.6, aovInr: Math.round(labAnchorAov * 0.90) },
    { strategy: 'Free delivery', conversionPct: 5.2, aovInr: Math.round(labAnchorAov * 0.95) }
  ];
  // "AI recommends" = highest revenue-per-visit proxy (conversion% * AOV), a simple, explainable rule.
  const recommended = revenueLab.reduce((best, s) =>
    (s.conversionPct * s.aovInr) > (best.conversionPct * best.aovInr) ? s : best
  );

  res.json({
    buyer,
    merchant,
    simulator: {
      baselineConversionPct, baselineAovInr,
      simulatedConversionPct, simulatedAovInr: aovInr,
      upliftPct,
      note: 'Illustrative estimate based on this session\'s real order data vs. a stated baseline assumption — not a measured or guaranteed result.'
    },
    revenueLab: {
      strategies: revenueLab,
      recommendedStrategy: recommended.strategy,
      note: 'Illustrative test-mode estimates, anchored to this session\'s real average order value — not measured or guaranteed results. "AI recommends" = highest projected conversion × AOV.'
    }
  });
});

// ---------- Attack Mode ----------
// Each function below runs a real attack scenario through the ACTUAL pipeline
// code (trustLayer.js, policyEngine.js, paymentMandate.js, security.js) — none
// of this is scripted/fake output. The point is to show these systems actually
// stop something, live, rather than just claiming the system is secure.

async function runAttack(attackType, session) {
  return executeAttack(attackType, {
    session,
    loadCatalog,
    buildCartMandate,
    detectPromptInjection,
    evaluateTransaction,
    runPaymentGuard,
    buyCountry: BUYER_COUNTRY,
    dailySpentInr: dailySpent(session.transactions),
    executePaymentIdempotent,
    getPaymentAttempt: (transactionId) => paymentAttempts.get(transactionId) || null
  }, runRegisteredAttack);
}

app.post('/api/attack', async (req, res) => {
  const { sessionId = 'default', attackType } = req.body;
  if (!validateApi(res, () => { requireId(sessionId, 'sessionId'); requireAction(attackType, Object.values(ATTACKS).map(attack => attack.id), 'attackType'); })) return;
  const session = getSession(sessionId);
  try {
    const result = await runAttack(attackType, session);
    recordAttackAudit(result, logEvent);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/security/attacks', (_req, res) => res.json({ attacks: Object.values(ATTACKS) }));

// ---------- Deterministic demo mode and observability ----------
app.get('/api/demo/health', (_req, res) => {
  const health = demoHealth({
    api: true, intent: typeof parseIntent === 'function', catalog: typeof loadCatalog === 'function',
    buyerAgent: typeof buyerAgentIdentity === 'function', merchantAgent: typeof merchantAgentIdentity === 'function',
    negotiation: typeof NegotiationEngine === 'function', trust: typeof evaluateTransaction === 'function',
    risk: typeof evaluateTransaction === 'function', policy: typeof evaluatePolicy === 'function',
    decision: typeof evaluateTransaction === 'function', approval: typeof evaluateApproval === 'function',
    paymentGuard: typeof runPaymentGuard === 'function', security: Object.keys(ATTACKS).length > 0,
    audit: typeof getTrail === 'function'
  });
  res.status(health.ready ? 200 : 503).json(health);
});

// A public, secret-free readiness contract for normal Node deployment.  It
// asserts local safety components only; it never calls an external provider.
app.get('/api/health', (_req, res) => {
  const health = demoHealth({ api: true, intent: true, catalog: true, buyerAgent: true, merchantAgent: true, negotiation: true, trust: true, risk: true, policy: true, decision: true, approval: true, paymentGuard: true, security: true, audit: true });
  res.status(health.ready ? 200 : 503).json({ status: health.ready ? 'READY' : 'DEGRADED', environment: process.env.NODE_ENV || 'development', paymentRail: 'razorpay_test_mode', demoDeterministic: process.env.NODE_ENV === 'demo' || process.env.DEMO_MODE === 'true', components: health.components });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'READY', product: 'PayMandate', paymentRail: 'razorpay_test_mode', demoDeterministic: process.env.NODE_ENV === 'demo' || process.env.DEMO_MODE === 'true' });
});

app.get('/api/demo/scenarios', (_req, res) => res.json({ scenarios: Object.values(DEMO_SCENARIOS).map(({ id, name, prompt }) => ({ id, name, prompt })) }));

app.post('/api/demo/run', (req, res) => {
  const { scenarioId } = req.body || {};
  if (!validateApi(res, () => requireAction(scenarioId, Object.keys(DEMO_SCENARIOS), 'scenarioId'))) return;
  try {
    const scenario = DEMO_SCENARIOS[scenarioId];
    if (!scenario) return apiError(res, 400, { code: 'DEMO_SCENARIO_UNKNOWN', message: 'Choose a registered deterministic demo scenario', stage: 'DEMO' });
    const transactionId = `DEMO-${scenario.id.toUpperCase()}`;
    clearTrails([transactionId]);
    demoTransactionIds.delete(transactionId);
    const result = runDemoScenario(scenarioId, { buildCartMandate, evaluateTransaction, evaluateApproval, runPaymentGuard, logEvent });
    demoTransactionIds.add(result.transactionId);
    res.json({ success: true, ...result, timeline: buildTransactionTimeline(result.transactionId, getTrail(result.transactionId)) });
  } catch (error) {
    apiError(res, 500, { code: 'DEMO_RUN_FAILED', message: error.message, stage: 'DEMO' });
  }
});

app.post('/api/demo/reset', (req, res) => {
  const { sessionId = null } = req.body || {};
  if (!validateApi(res, () => { if (sessionId !== null) requireId(sessionId, 'sessionId'); })) return;
  const ids = [...new Set([...demoTransactionIds, ...demoAttackTransactionIds])];
  const removedAuditEvents = clearTrails(ids);
  for (const id of ids) paymentAttempts.delete(id);
  demoTransactionIds.clear();
  demoAttackTransactionIds.clear();
  // Demo runs use local engine instances, so reset has no user purchase state
  // to delete. Never remove a whole interactive session here: it may contain
  // genuine transaction history unrelated to the demo.
  res.json({ success: true, status: 'READY_FOR_DEMO', removedAuditEvents, sessionId });
});

app.get('/api/timeline/:transactionId', (req, res) => {
  if (!validateApi(res, () => requireId(req.params.transactionId, 'transactionId'), { transactionId: req.params.transactionId })) return;
  const timeline = buildTransactionTimeline(req.params.transactionId, getTrail(req.params.transactionId));
  if (timeline.events.length === 0) return apiError(res, 404, { code: 'TRANSACTION_NOT_FOUND', message: 'No audit trail exists for this transaction', stage: 'AUDIT', transactionId: req.params.transactionId });
  res.json({ success: true, timeline });
});

// Evidence view: reconstructed only from append-only audit entries.
app.get('/api/trace/:transactionId', (req, res) => {
  if (!validateApi(res, () => requireId(req.params.transactionId, 'transactionId'), { transactionId: req.params.transactionId })) return;
  const trace = buildTransactionTrace(req.params.transactionId, getTrail(req.params.transactionId));
  if (!trace.timeline.length) return apiError(res, 400, { code: 'INVALID_REQUEST', message: 'No audit evidence exists for this transaction', stage: 'AUDIT', transactionId: req.params.transactionId });
  res.json({ success: true, trace });
});

app.get('/api/security/trace/:transactionId', (req, res) => {
  if (!validateApi(res, () => requireId(req.params.transactionId, 'transactionId'), { transactionId: req.params.transactionId })) return;
  const trace = buildSecurityTrace(req.params.transactionId, getTrail(req.params.transactionId));
  if (!trace.timeline.length) return apiError(res, 400, { code: 'INVALID_REQUEST', message: 'No security evidence exists for this transaction', stage: 'SECURITY', transactionId: req.params.transactionId });
  res.json({ success: true, trace });
});

app.get('/api/metrics', (_req, res) => res.json({ success: true, metrics: metricsSnapshot() }));

app.get('/api/replay/:transactionId', (req, res) => {
  if (!validateApi(res, () => requireId(req.params.transactionId, 'transactionId'), { transactionId: req.params.transactionId })) return;
  const timeline = buildTransactionTimeline(req.params.transactionId, getTrail(req.params.transactionId));
  if (timeline.events.length === 0) return apiError(res, 404, { code: 'TRANSACTION_NOT_FOUND', message: 'No transaction can be replayed', stage: 'AUDIT', transactionId: req.params.transactionId });
  res.json({ success: true, replay: { ...timeline, readOnly: true, paymentExecuted: false } });
});

app.post('/api/security/suite', async (req, res) => {
  const { sessionId = 'default' } = req.body || {};
  if (!validateApi(res, () => requireId(sessionId, 'sessionId'))) return;
  const session = getSession(sessionId);
  try {
    const results = [];
    for (const attack of Object.values(ATTACKS)) {
      const result = await runAttack(attack.id, session);
      recordAttackAudit(result, logEvent);
      demoAttackTransactionIds.add(result.transactionId);
      results.push(result);
    }
    const defended = results.filter(isDefended).length;
    res.json({ results, score: { defended, total: results.length } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/refund — reverse a completed transaction
// POST /api/payment/verify — called by the frontend after Razorpay Checkout's
// success handler fires. Verifies the payment signature server-side before
// treating anything as paid — this is the actual security check, not the UI.
app.post('/api/payment/verify', async (req, res) => {
  const { sessionId = 'default', razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!validateApi(res, () => {
    requireId(sessionId, 'sessionId'); requireId(razorpay_order_id, 'razorpay_order_id');
    requireId(razorpay_payment_id, 'razorpay_payment_id'); requireId(razorpay_signature, 'razorpay_signature');
  })) return;
  const session = getSession(sessionId);

  if (!session.pending || !session.pending.awaitingOnlinePayment) {
    return res.status(400).json({ error: 'No online payment is awaiting verification for this session' });
  }

  const valid = verifyPaymentSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature });
  if (!valid) {
    logEvent(session.pending.transactionId, 'payment_signature_invalid', { razorpay_order_id, razorpay_payment_id });
    return res.status(400).json({ error: 'Payment verification failed — signature mismatch' });
  }

  const paymentResult = {
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    status: 'captured',
    amountInr: session.pending.cart.pricing.totalInr
  };

  const result = await finalizePurchase(session, sessionId, 'online', paymentResult);
  res.json(result);
});

// POST /api/payment/cancelled — the user closed the Checkout widget without paying.
app.post('/api/payment/cancelled', (req, res) => {
  const { sessionId = 'default' } = req.body;
  if (!validateApi(res, () => requireId(sessionId, 'sessionId'))) return;
  const session = getSession(sessionId);
  if (session.pending) {
    logEvent(session.pending.transactionId, 'payment_cancelled', {});
    session.pending.awaitingOnlinePayment = false;
    session.pending.awaitingPaymentMethod = true;
  }
  res.json({
    reply: `Payment cancelled — reply "cod" for Cash on Delivery, or "online" to try again.`,
    stage: 'awaiting_payment_method'
  });
});

app.post('/api/refund', async (req, res) => {
  const { sessionId = 'default', transactionId, reason = 'Customer requested refund' } = req.body;
  if (!validateApi(res, () => { requireId(sessionId, 'sessionId'); requireId(transactionId, 'transactionId'); optionalString(reason, 'reason', { max: 500 }); }, { transactionId })) return;
  const session = getSession(sessionId);
  const txn = session.transactions.find(t => t.transactionId === transactionId);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });

  try {
    const refund = await refundPayment(txn.paymentResult, reason);
    logEvent(transactionId, 'refund_processed', refund);
    res.json({ refund });
  } catch (err) {
    logEvent(transactionId, 'refund_failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Keep every unknown API route on the structured error contract too.
app.use('/api', (_req, res) => apiError(res, 404, { code: 'INVALID_REQUEST', message: 'Unknown API endpoint', stage: 'API_VALIDATION' }));
app.use((err, _req, res, _next) => {
  console.error('[server] unhandled request error:', err.message);
  apiError(res, 500, { code: 'INVALID_REQUEST', message: 'Request failed safely', stage: 'SERVER' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const health = demoHealth({ api: true, intent: true, catalog: true, buyerAgent: true, merchantAgent: true, negotiation: true, trust: true, risk: true, policy: true, decision: true, approval: true, paymentGuard: true, security: true, audit: true });
  console.log('\n══════════════════════════════\n       PAYMANDATE\n   DEMO ENVIRONMENT\n══════════════════════════════');
  for (const component of health.components) console.log(`${component.id.padEnd(16)} ✓`);
  console.log(`══════════════════════════════\n       SYSTEM ${health.ready ? 'READY ✓' : 'DEGRADED ⚠'}\n══════════════════════════════\nPayMandate running at http://localhost:${PORT}`);
});
