/**
 * Pipeline verification harness.
 *
 * Run with:  npm run check:pipeline
 *
 * This exists because the pipeline modules are the ones a judge looks at directly,
 * so a blank panel or a wrong-direction score bar is a demo-losing bug rather
 * than a cosmetic one. Every assertion below checks something that would show up
 * on screen: that all fourteen stages assemble, that a blocked pipeline visibly
 * stops at the stage that blocked it, that the Trust-vs-Policy contrast picks the
 * right framing, that risk runs opposite to trust, and that the Payment Guard
 * genuinely refuses a drifted price rather than reporting six green ticks.
 *
 * It deliberately imports nothing that needs the network or express, so it runs
 * anywhere the project is checked out — including before `npm install`.
 */

import assert from 'assert';
import { STAGE_IDS, STAGES, STATUS, haltedAt, progress } from '../src/pipeline.js';
import { scoreRisk } from '../src/riskEngine.js';
import { evaluateApproval, APPROVAL } from '../src/approvalGate.js';
import { runPaymentGuard } from '../src/paymentGuard.js';
import { buildTransactionState } from '../src/transactionState.js';
import { DEFAULT_MANDATE, evaluatePolicy } from '../src/policyEngine.js';
import { scoreConfidence } from '../src/trustLayer.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, message: err.message });
    console.log(`  ✕ ${name}`);
    console.log(`      ${err.message}`);
  }
}

function group(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------- fixtures

function makeSession(mandateOverrides = {}) {
  const mandate = { ...DEFAULT_MANDATE, ...mandateOverrides };
  return {
    profile: { onboarded: true, name: 'Divyanshi', phone: '9999999999', email: 'd@example.com', address: 'Mysuru' },
    mandate,
    mandateVersion: 1,
    mandateHistory: [],
    agentSeed: '04242',
    createdAt: new Date().toISOString(),
    pending: null,
    recentPurchaseTimestamps: [],
    transactions: [],
    stats: { blockedAttempts: 0, humanApprovalsGiven: 0, negotiationsWon: 0 },
    lastIntent: null, lastInjection: null, lastGuard: null,
    lastPaymentMethod: null, stepUpVerified: false, uiMode: 'normal'
  };
}

/** An established, credible merchant — the one that makes the §15 screen bite. */
function trustedItem(priceInr, overrides = {}) {
  return {
    id: 'itm-001',
    name: 'Wireless Earbuds Pro',
    merchant: 'Sound Systems India',
    category: 'electronics',
    price_inr: priceInr,
    merchant_tenure_days: 1200,
    gst_verified: true,
    origin_country: 'IN',
    merchant_rating: 4.8,
    merchant_order_count: 5400,
    dispute_rate: 0.004,
    ...overrides
  };
}

function makeCart(item, totalInr, opts = {}) {
  return {
    item,
    pricing: {
      listPriceInr: opts.listPriceInr ?? item.price_inr,
      basePriceInr: opts.basePriceInr ?? totalInr,
      crossBorderFeeInr: opts.crossBorderFeeInr ?? 0,
      totalInr,
      negotiated: !!opts.negotiated
    },
    deliveryEstimate: { label: '3–5 business days' },
    isCrossBorder: !!opts.isCrossBorder,
    withinBudget: opts.withinBudget ?? true,
    approved: !!opts.approved,
    source: 'mock'
  };
}

function makePending(item, cart, extra = {}) {
  // Scored exactly the way server.js scores it (see the scoreConfidence call in
  // startPurchase). Passing a convenient shorthand here instead would make the
  // fixture score a merchant the running system never sees, which is the fastest
  // way to write tests that pass while the demo is broken.
  const budget = extra.budgetInr ?? 3000;
  const trust = scoreConfidence({
    crossBorder: cart.isCrossBorder,
    verificationMatch: true,
    amountRatio: budget ? cart.pricing.totalInr / budget : 0.5,
    knownMerchant: !cart.isCrossBorder && !item.live && item.merchant_tenure_days >= 180,
    merchantTenureDays: item.merchant_tenure_days,
    gstVerified: item.gst_verified,
    isLive: !!item.live,
    sellerRating: item.sellerRating ?? null,
    sellerRatingCount: item.sellerRatingCount ?? 0,
    category: item.category,
    recentPurchaseCount: extra.recentPurchaseCount ?? 0
  });
  const policy = evaluatePolicy({
    amountInr: cart.pricing.totalInr,
    category: item.category,
    isCrossBorder: cart.isCrossBorder,
    mandate: extra.mandate || DEFAULT_MANDATE,
    dailySpentInr: extra.dailySpentInr || 0
  });
  return {
    transactionId: 'txn-verify-0001',
    item, cart, confidence: trust, policy,
    mandateVersion: 1,
    intent: { query: 'wireless earbuds', budget, rawTerms: ['wireless', 'earbuds'], source: 'llm', raw: 'buy wireless earbuds under 3000' },
    createdAt: new Date().toISOString(),
    ...extra
  };
}

function build(session, pending, overrides = {}) {
  return buildTransactionState({
    session,
    sessionId: 'verify-session',
    pending,
    intent: pending?.intent || null,
    dailySpentInr: overrides.dailySpentInr || 0,
    overrides
  });
}

// ================================================================ 1. Pipeline

group('Pipeline definition');

check('exactly 14 stages are defined', () => {
  assert.strictEqual(STAGE_IDS.length, 14, `expected 14 stages, found ${STAGE_IDS.length}`);
});

check('stage ids are unique', () => {
  assert.strictEqual(new Set(STAGE_IDS).size, STAGE_IDS.length, 'duplicate stage id');
});

check('every stage carries a label, icon, layer and owner', () => {
  for (const s of STAGES) {
    for (const f of ['id', 'label', 'icon', 'layer', 'owner', 'blurb']) {
      assert.ok(s[f], `stage ${s.id} is missing "${f}"`);
    }
  }
});

check('every stage has a matching panel renderer in public/control.js', () => {
  // A stage with no renderer renders as an empty box in front of a judge, so
  // this is checked mechanically rather than by eye.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'control.js'), 'utf8');
  const panelBlock = src.slice(src.indexOf('const PANELS = {'));
  const missing = STAGE_IDS.filter(id => !new RegExp(`\\n\\s*${id}\\s*\\(`).test(panelBlock));
  assert.strictEqual(missing.length, 0, `stages with no panel renderer: ${missing.join(', ')}`);
});

// ================================================================ 2. Risk

group('Risk engine — the second axis');

check('a benign purchase scores low', () => {
  const r = scoreRisk({ amountInr: 500, mandate: DEFAULT_MANDATE, merchantTenureDays: 1200, category: 'groceries' });
  assert.ok(r.score < 30, `expected < 30, got ${r.score}`);
  assert.strictEqual(r.band, 'low');
});

check('risk runs OPPOSITE to trust — a credible merchant can still score high risk', () => {
  const r = scoreRisk({
    amountInr: 9800, mandate: DEFAULT_MANDATE, dailySpentInr: 9000,
    merchantTenureDays: 1200, gstVerified: true,   // impeccable merchant
    recentPurchaseCount: 4, category: 'electronics'
  });
  assert.ok(r.score >= 30, `a near-ceiling 4th rapid purchase should not read as low risk, got ${r.score}`);
});

check('injection detection dominates the score', () => {
  const clean = scoreRisk({ amountInr: 500, mandate: DEFAULT_MANDATE, injectionDetected: false });
  const dirty = scoreRisk({ amountInr: 500, mandate: DEFAULT_MANDATE, injectionDetected: true });
  assert.ok(dirty.score - clean.score >= 25, `injection should add >= 25, added ${dirty.score - clean.score}`);
});

check('score is always clamped to 0–100', () => {
  const worst = scoreRisk({
    amountInr: 100000, mandate: DEFAULT_MANDATE, dailySpentInr: 100000,
    listPriceInr: 1000, basePriceInr: 100, merchantTenureDays: 1,
    gstVerified: false, isCrossBorder: true, recentPurchaseCount: 9,
    injectionDetected: true, category: 'electronics'
  });
  assert.ok(worst.score >= 0 && worst.score <= 100, `out of range: ${worst.score}`);
  assert.strictEqual(worst.band, 'high');
});

check('every signal reports a detail string, fired or not', () => {
  const r = scoreRisk({ amountInr: 500, mandate: DEFAULT_MANDATE });
  assert.ok(r.signals.length >= 10, `expected >= 10 signals, got ${r.signals.length}`);
  for (const s of r.signals) {
    assert.ok(s.label && s.detail, `signal ${s.label} has no detail`);
  }
});

// ================================================================ 3. Approval

group('Approval gate');

check('a small clean purchase is autonomous', () => {
  const a = evaluateApproval({
    amountInr: 900, mandate: DEFAULT_MANDATE,
    trust: { score: 88, decision: 'proceed', reasons: [], thresholds: { proceed: 70 } },
    risk: { score: 10, band: 'low' },
    policy: { decision: 'approved', violations: [], flags: [] }
  });
  assert.strictEqual(a.mode, APPROVAL.AUTONOMOUS);
  assert.strictEqual(a.autonomous, true);
});

check('crossing the autonomous threshold removes autonomy and shows the arithmetic', () => {
  const a = evaluateApproval({
    amountInr: 2400, mandate: DEFAULT_MANDATE,
    trust: { score: 88, decision: 'proceed', reasons: [], thresholds: { proceed: 70 } },
    risk: { score: 10, band: 'low' },
    policy: { decision: 'approved', violations: [], flags: [] }
  });
  assert.strictEqual(a.mode, APPROVAL.HUMAN);
  assert.ok(a.comparison.text.includes('2,400'), `comparison should show the amount: ${a.comparison.text}`);
  assert.ok(a.comparison.text.includes('2,000'), `comparison should show the limit: ${a.comparison.text}`);
  assert.ok(a.comparison.text.includes('>'), `comparison should show the operator: ${a.comparison.text}`);
});

check('a policy block cannot be talked round by perfect trust', () => {
  const a = evaluateApproval({
    amountInr: 50000, mandate: DEFAULT_MANDATE,
    trust: { score: 100, decision: 'proceed', reasons: [], thresholds: { proceed: 70 } },
    risk: { score: 0, band: 'low' },
    policy: { decision: 'blocked', violations: ['exceeds ceiling'], flags: [] }
  });
  assert.strictEqual(a.mode, APPROVAL.BLOCKED);
  assert.strictEqual(a.allowed, false);
  assert.strictEqual(a.humanActionLabel, null, 'a blocked transaction must offer no approve button');
});

check('high risk alone escalates but never blocks', () => {
  const a = evaluateApproval({
    amountInr: 900, mandate: DEFAULT_MANDATE,
    trust: { score: 88, decision: 'proceed', reasons: [], thresholds: { proceed: 70 } },
    risk: { score: 75, band: 'high' },
    policy: { decision: 'approved', violations: [], flags: [] }
  });
  assert.strictEqual(a.mode, APPROVAL.HUMAN, 'risk should escalate to human, not block');
  assert.strictEqual(a.allowed, true);
});

check('step-up outranks plain human approval, and clears once verified', () => {
  const args = {
    amountInr: 900, mandate: DEFAULT_MANDATE,
    trust: { score: 55, decision: 'step_up_required', reasons: ['thin history'], thresholds: { proceed: 70 } },
    risk: { score: 10, band: 'low' },
    policy: { decision: 'approved', violations: [], flags: [] }
  };
  assert.strictEqual(evaluateApproval({ ...args, stepUpVerified: false }).mode, APPROVAL.STEP_UP);
  assert.strictEqual(evaluateApproval({ ...args, stepUpVerified: true }).mode, APPROVAL.AUTONOMOUS);
});

// ================================================================ 4. Guard

group('Payment guard — a real gate');

const guardBase = () => {
  const item = trustedItem(1500);
  return {
    cart: makeCart(item, 1500, { approved: true }),
    approvedAmountInr: 1500,
    mandate: DEFAULT_MANDATE,
    dailySpentInr: 0,
    transactionId: 'txn-guard-01',
    ledgerEntry: null,
    paymentMethod: 'online',
    railConfigured: true
  };
};

check('a clean charge passes all six checks', () => {
  const g = runPaymentGuard(guardBase());
  assert.strictEqual(g.passed, true, `blocked by: ${g.blockedReason}`);
  assert.strictEqual(g.totalCount, 6, `expected 6 checks, got ${g.totalCount}`);
});

check('price drift after approval is refused', () => {
  const base = guardBase();
  base.cart.pricing.totalInr = 1700;   // merchant raised it after the yes
  const g = runPaymentGuard(base);
  assert.strictEqual(g.passed, false, 'a ₹200 post-approval increase must not go through');
  assert.strictEqual(g.failedCheckId, 'price_integrity');
  assert.ok(/1,700/.test(g.blockedReason) && /1,500/.test(g.blockedReason),
    `the reason must name both figures: ${g.blockedReason}`);
});

check('an unapproved cart is refused', () => {
  const base = guardBase();
  base.cart.approved = false;
  const g = runPaymentGuard(base);
  assert.strictEqual(g.passed, false);
  assert.strictEqual(g.failedCheckId, 'cart_approved');
});

check('a second charge on an already-succeeded transaction is refused', () => {
  const base = guardBase();
  base.ledgerEntry = { status: 'succeeded', orderId: 'order_abc123' };
  const g = runPaymentGuard(base);
  assert.strictEqual(g.passed, false, 'retry must not become a second charge');
  assert.strictEqual(g.failedCheckId, 'idempotency');
});

check('an in-flight attempt is continued, not refused', () => {
  const base = guardBase();
  base.ledgerEntry = { status: 'pending', orderId: 'order_abc123' };
  assert.strictEqual(runPaymentGuard(base).passed, true);
});

check('the per-transaction ceiling is re-checked against the final price', () => {
  const item = trustedItem(50000);
  const g = runPaymentGuard({
    ...guardBase(),
    cart: makeCart(item, 50000, { approved: true }),
    approvedAmountInr: 50000
  });
  assert.strictEqual(g.passed, false);
  assert.strictEqual(g.failedCheckId, 'transaction_ceiling');
});

check('the daily ceiling counts this charge too', () => {
  const g = runPaymentGuard({ ...guardBase(), dailySpentInr: 19500 });
  assert.strictEqual(g.passed, false, '19,500 + 1,500 exceeds the 20,000 daily limit');
  assert.strictEqual(g.failedCheckId, 'daily_ceiling');
});

check('COD skips the card rail rather than failing on it', () => {
  const g = runPaymentGuard({ ...guardBase(), paymentMethod: 'cod', railConfigured: false });
  assert.strictEqual(g.passed, true, 'COD must not require Razorpay credentials');
  const rail = g.checks.find(c => c.id === 'rail_integrity');
  assert.strictEqual(rail.status, 'skip');
});

check('missing credentials fail before the charge, not during it', () => {
  const g = runPaymentGuard({ ...guardBase(), railConfigured: false });
  assert.strictEqual(g.passed, false);
  assert.strictEqual(g.failedCheckId, 'rail_integrity');
});

// ================================================================ 5. State

group('TransactionState assembly');

check('an empty session still produces a fully-shaped IDLE state', () => {
  // The Control Center must render before anything happens — that is exactly
  // when a judge first clicks it.
  const st = build(makeSession(), null);
  assert.strictEqual(st.status.code, 'IDLE');
  assert.strictEqual(Object.keys(st.stages).length, 14);
  assert.strictEqual(st.stageMeta.length, 14);
  for (const id of STAGE_IDS) {
    assert.ok(st.stages[id], `stage ${id} missing`);
    assert.strictEqual(st.stages[id].status, STATUS.PENDING);
  }
});

check('a normal in-flight purchase populates the agent and deal stages', () => {
  const session = makeSession();
  const item = trustedItem(1500);
  const cart = makeCart(item, 1500);
  const pending = makePending(item, cart);
  const st = build(session, pending);

  assert.strictEqual(st.stages.intent.status, STATUS.PASSED);
  assert.strictEqual(st.stages.buyer_agent.status, STATUS.PASSED);
  assert.strictEqual(st.stages.discovery.status, STATUS.PASSED);
  assert.strictEqual(st.stages.merchant_agent.status, STATUS.PASSED);
  assert.strictEqual(st.stages.deal.status, STATUS.PASSED);
  assert.strictEqual(st.stages.trust.status, STATUS.PASSED);
  assert.strictEqual(st.stages.payment_guard.status, STATUS.PENDING,
    'the Payment Guard must not appear to run before approval');
  assert.strictEqual(st.stages.razorpay.status, STATUS.PENDING,
    'Razorpay must remain unreachable until approval and the guard complete');
  assert.ok(st.risk, 'risk should be computed whenever there is a priced cart');
  assert.ok(st.approval, 'approval should be evaluated whenever there is a priced cart');
});

check('panels the UI reads are all present and non-empty on a live transaction', () => {
  const session = makeSession();
  const item = trustedItem(1500);
  const pending = makePending(item, makeCart(item, 1500, { approved: true }));
  const st = build(session, pending, { paymentGuard: runPaymentGuard(guardBase()) });

  for (const key of ['intent', 'buyerAgent', 'discovery', 'merchantAgent', 'negotiation',
                     'deal', 'trust', 'risk', 'policy', 'contrast', 'approval',
                     'paymentGuard', 'audit', 'mandate']) {
    assert.ok(st[key], `state.${key} is missing — its panel would render blank`);
  }
});

check('agent identity panels carry the fields control.js renders', () => {
  const session = makeSession();
  const item = trustedItem(1500);
  const st = build(session, makePending(item, makeCart(item, 1500)));
  for (const f of ['agentId', 'owner', 'role', 'permissions', 'mandateVersion']) {
    assert.ok(st.buyerAgent[f] !== undefined, `buyerAgent.${f} missing`);
  }
  for (const f of ['agentId', 'owner', 'role', 'permissions', 'maxDiscountPct']) {
    assert.ok(st.merchantAgent[f] !== undefined, `merchantAgent.${f} missing`);
  }
});

check('the deal fingerprint changes when the price changes', () => {
  const session = makeSession();
  const item = trustedItem(1500);
  const a = build(session, makePending(item, makeCart(item, 1500))).deal.fingerprint;
  const b = build(session, makePending(item, makeCart(item, 1700))).deal.fingerprint;
  assert.notStrictEqual(a, b, 'a price change must produce a different fingerprint');
  assert.match(a, /^[0-9a-f]{12}$/, `unexpected fingerprint shape: ${a}`);
});

check('the pipeline visibly STOPS at the stage that blocked it', () => {
  const session = makeSession();
  const item = trustedItem(50000);            // past the ₹10,000 ceiling
  const cart = makeCart(item, 50000);
  const pending = makePending(item, cart);
  const st = build(session, pending);

  assert.strictEqual(st.policy.decision, 'blocked');
  assert.strictEqual(st.stages.policy.status, STATUS.BLOCKED);
  assert.ok(st.halted, 'state.halted must be set so the UI can draw the stop line');
  assert.strictEqual(st.halted.stageId, 'policy');
  assert.strictEqual(st.status.code, 'BLOCKED');
  assert.ok(st.status.protectedClaim, 'a block must say it is the system working, not failing');
  // Nothing downstream of the block may claim to have run.
  for (const id of ['payment_guard', 'razorpay']) {
    assert.strictEqual(st.stages[id].status, STATUS.PENDING, `${id} must not report progress after a block`);
  }
});

check('THE §15 SCREEN: a trusted merchant blocked by the mandate reads as a contrast', () => {
  const session = makeSession();
  const item = trustedItem(50000);            // impeccable merchant, illegal amount
  const pending = makePending(item, makeCart(item, 50000));
  const st = build(session, pending);

  assert.ok(st.trust.score >= 70, `fixture needs a high-trust merchant, got ${st.trust.score}`);
  assert.strictEqual(st.contrast.tone, 'contrast',
    `expected the contrast framing, got "${st.contrast.tone}"`);
  assert.strictEqual(st.contrast.trust.verdict, 'TRUSTED');
  assert.strictEqual(st.contrast.policy.verdict, 'BLOCKED');
  assert.ok(st.contrast.policy.topReasons.length > 0, 'the block must be explained, not just asserted');
  assert.match(st.contrast.headline, /trusted merchant can still be blocked/i);
});

check('when both axes agree, the contrast says so rather than manufacturing drama', () => {
  const session = makeSession();
  const item = trustedItem(900);
  const pending = makePending(item, makeCart(item, 900));
  const st = build(session, pending);
  assert.strictEqual(st.contrast.tone, 'aligned');
  assert.strictEqual(st.contrast.policy.verdict, 'PERMITTED');
});

check('a blocked payment guard halts the pipeline at the guard, not at the rail', () => {
  const session = makeSession();
  const item = trustedItem(1500);
  const cart = makeCart(item, 1700, { approved: true });   // drifted
  const pending = makePending(item, cart);
  const guard = runPaymentGuard({ ...guardBase(), cart, approvedAmountInr: 1500 });
  const st = build(session, pending, { paymentGuard: guard });

  assert.strictEqual(st.stages.payment_guard.status, STATUS.BLOCKED);
  assert.strictEqual(st.halted.stageId, 'payment_guard');
  assert.strictEqual(st.stages.razorpay.status, STATUS.PENDING, 'no order should exist');
});

check('a completed purchase reports COMPLETED and fills the whole rail', () => {
  const session = makeSession();
  const item = trustedItem(900);
  const cart = makeCart(item, 900, { approved: true });
  const pending = makePending(item, cart);
  const st = build(session, pending, {
    paymentGuard: runPaymentGuard({ ...guardBase(), cart, approvedAmountInr: 900 }),
    paymentResult: { orderId: 'order_ok', paymentId: 'pay_ok', amountInr: 900, status: 'captured' },
    paymentMethod: 'online'
  });
  assert.strictEqual(st.status.code, 'COMPLETED');
  assert.strictEqual(st.razorpay.state, 'captured');
  assert.strictEqual(st.halted, null);
  assert.ok(progress(st.stages).done >= 12, `expected most stages done, got ${progress(st.stages).done}`);
});

check('risk and trust disagree on the same transaction, and both are exposed', () => {
  // The case the two-axis design exists for: an impeccable merchant selling you
  // something that eats almost all of your remaining headroom.
  //
  // Note what this fixture deliberately does NOT use: a velocity burst. Rapid
  // repeat purchases push trust down and risk up at the same time, so they are
  // the one signal that cannot demonstrate divergence. Limit proximity can —
  // it says nothing at all about the merchant.
  const session = makeSession();
  const item = trustedItem(9800);
  const cart = makeCart(item, 9800);
  const pending = makePending(item, cart, { budgetInr: 10000 });
  const st = build(session, pending, { dailySpentInr: 9000 });

  assert.ok(st.trust.score >= 70, `trust should stay high — the merchant is fine. Got ${st.trust.score}`);
  assert.ok(st.risk.score >= 60, `risk should read high — this eats the headroom. Got ${st.risk.score}`);
  assert.strictEqual(st.trust.decision, 'proceed');
  assert.strictEqual(st.risk.band, 'high');
  assert.ok(st.risk.scale.includes('opposite'), 'the risk panel must warn that its scale is inverted');
});

check('injection detected on the request raises risk through the state layer', () => {
  const session = makeSession();
  const item = trustedItem(1500);
  const pending = makePending(item, makeCart(item, 1500));
  const clean = build(session, pending, { injectionDetected: false });
  const dirty = build(session, pending, { injectionDetected: true });
  assert.ok(dirty.risk.score > clean.risk.score, 'an injection attempt must move the risk score');
});

check('every populated stage carries a human-readable summary', () => {
  const session = makeSession();
  const item = trustedItem(1500);
  const pending = makePending(item, makeCart(item, 1500, { approved: true }));
  const st = build(session, pending, { paymentGuard: runPaymentGuard(guardBase()) });
  for (const [id, s] of Object.entries(st.stages)) {
    if (s.status !== STATUS.PENDING) {
      assert.ok(s.summary && String(s.summary).trim().length > 0,
        `stage ${id} is ${s.status} but has no summary to show on the rail`);
    }
  }
});

check('no summary leaks raw engine vocabulary at the user', () => {
  // Spec rule: never show "policy engine returned false". Scores and reasons only.
  // Checked against the strings that actually reach the screen — stage summaries
  // and the contrast copy — rather than the whole JSON, which legitimately
  // contains nulls for fields that simply don't apply yet.
  const session = makeSession();
  const item = trustedItem(50000);
  const st = build(session, makePending(item, makeCart(item, 50000)));

  const visible = [
    ...Object.values(st.stages).map(s => s.summary).filter(Boolean),
    st.status.label, st.status.detail, st.status.protectedClaim,
    st.contrast.headline, st.contrast.explanation, st.contrast.rule,
    st.contrast.trust.verdict, st.contrast.policy.verdict,
    ...st.contrast.policy.topReasons, ...st.contrast.trust.topReasons
  ].filter(Boolean).map(String);

  for (const text of visible) {
    for (const bad of ['undefined', 'null', '[object Object]', 'NaN', 'returned false', 'false']) {
      assert.ok(!text.includes(bad), `visible text "${text}" contains "${bad}"`);
    }
  }
});

// ================================================== frontend wiring
//
// The backend can be perfect and the interface can still fail, because the whole
// claim is that the existing capability becomes VISIBLE. These checks read the
// three frontend files as text and verify the contract between them: that every
// element control.js reaches for exists in the markup, that every surface in the
// nav has somewhere to go, and — the one that matters most — that every CSS class
// control.js emits has a rule defined for it. An unstyled panel renders as an
// unreadable pile of text, which is indistinguishable from a broken feature when
// there are ninety seconds on the clock.

const PUB = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const controlJs = fs.readFileSync(path.join(PUB, 'control.js'), 'utf8');
const controlCss = fs.readFileSync(path.join(PUB, 'control.css'), 'utf8');
const appJs = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
// Both stylesheets as one string. Several checks below ask "is this styled
// anywhere", and which of the two files a rule lives in is not their business.
const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8') + '\n' + controlCss;

group('Frontend wiring — the visibility contract');

check('index.html loads control.css and control.js', () => {
  assert.ok(/href="control\.css"/.test(html), 'control.css is not linked');
  assert.ok(/src="control\.js"/.test(html), 'control.js is not loaded');
  assert.ok(html.indexOf('src="app.js"') < html.indexOf('src="control.js"'),
    'control.js must load after app.js — it reads window.MandateSession');
});

check('every element control.js looks up by id exists in the markup', () => {
  const ids = new Set();
  for (const m of controlJs.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)) ids.add(m[1]);
  assert.ok(ids.size >= 6, `expected several id lookups, found ${ids.size}`);
  const missing = [...ids].filter(id => !new RegExp(`id="${id}"`).test(html));
  // ccReplayBtn is created by the replay panel itself, not by index.html.
  const allowed = new Set(['ccReplayBtn']);
  const real = missing.filter(id => !allowed.has(id));
  assert.deepStrictEqual(real, [], `control.js reaches for missing ids: ${real.join(', ')}`);
});

check('all six surfaces exist and all six have a nav tab', () => {
  const surfaces = ['buy', 'control', 'security', 'payments', 'audit', 'business'];
  for (const s of surfaces) {
    assert.ok(new RegExp(`data-surface="${s}"`).test(html), `no [data-surface="${s}"] section`);
    const hasNav = new RegExp(`class="nav-tab[^"]*" data-goto="${s}"`).test(html);
    const hasBackToMandate = s === 'buy' && /id="backToChatBtn"/.test(html);
    assert.ok(hasNav || hasBackToMandate,
      `no navigation control pointing at "${s}"`);
  }
  // And the file control.js walks must agree on the same six.
  const listed = controlJs.match(/const SURFACES = \[([^\]]+)\]/);
  assert.ok(listed, 'SURFACES list not found in control.js');
  for (const s of surfaces) {
    assert.ok(listed[1].includes(`'${s}'`), `control.js SURFACES is missing "${s}"`);
  }
});

check('exactly one surface is visible on load, and it is BUY', () => {
  const sections = [...html.matchAll(/data-surface="(\w+)"([^>]*)>/g)];
  const visible = sections.filter(m => !/\bhidden\b/.test(m[2])).map(m => m[1]);
  assert.deepStrictEqual(visible, ['buy'],
    `expected only BUY visible before JS runs, got: ${visible.join(', ') || 'none'}`);
});

check('every CSS class control.js emits is styled in control.css or style.css', () => {
  const styleCss = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  const allCss = controlCss + '\n' + styleCss;

  // Strip `${ ... }` interpolations, brace-balanced, before splitting on
  // whitespace. Splitting first would shred a ternary into tokens like
  // `'tone-red'` and `?`, which is how this check quietly stopped meaning
  // anything the first time it was written.
  function stripInterpolations(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '$' && s[i + 1] === '{') {
        let depth = 1;
        i += 2;
        while (i < s.length && depth > 0) {
          if (s[i] === '{') depth++;
          else if (s[i] === '}') depth--;
          i++;
        }
        i--;
        out += ' ';
      } else {
        out += s[i];
      }
    }
    return out;
  }

  const classes = new Set();
  for (const m of controlJs.matchAll(/class="([^"]*)"/g)) {
    for (const token of stripInterpolations(m[1]).split(/\s+/)) {
      if (/^[a-z][a-z0-9-]*$/i.test(token)) classes.add(token);
    }
  }
  assert.ok(classes.size > 40, `expected many classes, extracted only ${classes.size}`);

  // Interpolated families, expanded to the values the backend can actually
  // produce. These are the dangerous ones: a new status or contrast tone lands
  // here unstyled and nobody notices until it is on a projector.
  const dynamic = [
    ...['pending', 'running', 'passed', 'blocked', 'failed', 'recovered'].map(s => 'st-' + s),
    ...['grey', 'blue', 'green', 'amber', 'orange', 'red'].map(t => 'cc-tone-' + t),
    ...['contrast', 'blocked', 'flagged', 'inverse', 'aligned'].map(t => 'cc-split-' + t),
    ...['ok', 'warn', 'bad'].map(t => 'cc-verdict-' + t),
    ...['pass', 'fail', 'skip'].map(s => 'cc-check-' + s),
    ...['buyer', 'merchant', 'system'].map(s => 'cc-turn-' + s),
    ...['allow', 'deny'].map(s => 'cc-perm-' + s),
    ...['green', 'amber', 'red', 'mute'].map(t => 'tone-' + t),
    'cc-split-trust', 'cc-split-policy', 'cc-reasons-bad', 'cc-reasons-warn',
    'cc-chosen', 'cc-line-total', 'cc-check-ok', 'cc-check-bad',
    'is-selected', 'is-halt', 'is-unreachable', 'fired', 'quiet'
  ];
  for (const c of dynamic) classes.add(c);

  const unstyled = [...classes].filter(c => !allCss.includes('.' + c));
  assert.deepStrictEqual(unstyled, [],
    `classes rendered but never styled: ${unstyled.join(', ')}`);
});

check('app.js hands the pipeline state to the Control Center', () => {
  assert.ok(/window\.MandateSession\s*=/.test(appJs),
    'app.js must publish window.MandateSession so control.js can find the session id');
  assert.ok(/data\.state[\s\S]{0,120}MandateControl\.push/.test(appJs),
    'applyServerResponse must push data.state into MandateControl');
  assert.ok(/window\.loadBusinessSurface\s*=/.test(appJs),
    'the BUSINESS surface has no loader, so its tab would open empty');
});

check('no duplicate ids in index.html', () => {
  // Restructuring the shell around six surfaces is exactly how a second
  // id="attackPanel" gets left behind. getElementById would then silently bind
  // to the wrong one and half the console would stop responding.
  const seen = new Map();
  const dupes = [];
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) {
    if (seen.has(m[1])) dupes.push(m[1]);
    seen.set(m[1], true);
  }
  assert.deepStrictEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
});

check('app.js binds no element that the markup does not have', () => {
  // app.js caches its elements in module-level consts and then uses them without
  // guards, so a single missing id throws and takes every listener after it down
  // with it — the chat box included. There is no boot test that catches this.
  //
  // Only module-scope `const x = getElementById(...)` counts. Lookups inside a
  // function are for elements created at runtime (the typing indicator) and are
  // guarded at their call site.
  const ids = new Set();
  for (const m of appJs.matchAll(/^const \w+ = document\.getElementById\('([^']+)'\)/gm)) {
    ids.add(m[1]);
  }
  assert.ok(ids.size > 15, `expected app.js to cache many elements, found ${ids.size}`);
  const missing = [...ids].filter(id => !new RegExp(`id="${id}"`).test(html));
  assert.deepStrictEqual(missing, [],
    `app.js will throw on load — missing ids: ${missing.join(', ')}`);
});

check('every nav target resolves to a surface that exists', () => {
  const targets = new Set([...html.matchAll(/data-goto="([^"]+)"/g)].map(m => m[1]));
  const surfaces = new Set([...html.matchAll(/data-surface="([^"]+)"/g)].map(m => m[1]));
  const dangling = [...targets].filter(t => !surfaces.has(t));
  assert.deepStrictEqual(dangling, [], `nav links point nowhere: ${dangling.join(', ')}`);
});

check('the six surface sections are balanced', () => {
  const opens = (html.match(/<section\b/g) || []).length;
  const closes = (html.match(/<\/section>/g) || []).length;
  assert.strictEqual(opens, closes,
    `unbalanced <section> tags (${opens} open, ${closes} close) — surfaces would nest wrongly`);
  const divOpens = (html.match(/<div\b/g) || []).length;
  const divCloses = (html.match(/<\/div>/g) || []).length;
  assert.strictEqual(divOpens, divCloses,
    `unbalanced <div> tags (${divOpens} open, ${divCloses} close)`);
});

check('the chat sidebar offers a route into the full pipeline', () => {
  // The six-stage sidebar is a summary. If it is a dead end, the fourteen-stage
  // Control Center only gets seen by a judge who happens to read the nav.
  assert.ok(/chain-deeplink/.test(html), 'no deep link from the chat sidebar to CONTROL');
});

check('Control Mode is styled as presentation-only and says so', () => {
  assert.ok(/body\[data-ui-mode="control"\]/.test(controlCss),
    'Control Mode has no styling, so toggling it would appear to do nothing');
  assert.ok(/cannot change an outcome|presentation only/i.test(html),
    'the mode toggle must state that it cannot change a decision');
});

// ============================================ first paint without a network
//
// Every check above passed while the page rendered as a flat navy rectangle with
// no text at all. The cause was two render-blocking <link>s to fonts.googleapis
// .com and unpkg.com: on a machine whose outbound requests hang, the browser
// paints the propagated body background and then blocks content paint until
// those time out. A hackathon venue's wifi is exactly that machine. These
// checks encode the rule that the demo must survive with the cable pulled.

const head = html.slice(0, html.indexOf('</head>'));

check('no render-blocking third-party stylesheet in <head>', () => {
  const links = head.match(/<link\b[^>]*>/gi) || [];
  const blocking = links.filter(tag => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return false;   // preconnect etc. do not block
    if (!/href\s*=\s*["']https?:\/\//i.test(tag)) return false;  // local files are instant
    // media="print" + onload flip is the documented way to load a sheet off the
    // critical path, so it is allowed.
    return !/media\s*=\s*["']print["']/i.test(tag);
  });
  assert.deepStrictEqual(blocking, [],
    'these stylesheets block the first paint on a hanging network:\n      ' +
    blocking.join('\n      ') +
    '\n      Serve them locally, or load them with media="print" onload="this.media=\'all\'".');
});

check('no webfont is on the critical path', () => {
  assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(head),
    'a webfont <link> in <head> blocks the first paint; use a system font stack');
  assert.ok(/ui-monospace|SFMono|system-ui|-apple-system/.test(css),
    '--font-display / --font-body must fall back to system fonts, not just "monospace"');
});

check('our own scripts boot before any third-party script', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi)];
  const firstThirdParty = scripts.findIndex(m => /^https?:\/\//i.test(m[1]));
  const lastOwn = scripts.reduce((acc, m, i) => /^https?:\/\//i.test(m[1]) ? acc : i, -1);
  assert.ok(lastOwn !== -1, 'app.js / control.js are not loaded at all');
  if (firstThirdParty !== -1) {
    assert.ok(firstThirdParty > lastOwn,
      `${scripts[firstThirdParty][1]} loads before our own scripts — if that CDN hangs, ` +
      'app.js never executes and every button on the page is dead');
  }
});

check('third-party scripts are deferred and their globals are guarded', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*src\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi)];
  for (const m of scripts) {
    assert.ok(/\bdefer\b|\basync\b/.test(m[0]),
      `${m[1]} is neither defer nor async, so it blocks parsing`);
  }
  // leaflet is the one we actually dereference during the demo
  if (scripts.some(m => /leaflet/i.test(m[1]))) {
    assert.ok(/typeof L === 'undefined'|typeof L === "undefined"/.test(appJs),
      'app.js dereferences L without ever checking it loaded — a dead CDN throws ' +
      'and takes the address modal down with it');
  }
});

check('the hidden attribute cannot be overridden by a class', () => {
  assert.ok(/\[hidden\]\s*{[^}]*display:\s*none\s*!important/.test(css),
    'without a global [hidden] { display: none !important } rule, any class that ' +
    'sets `display` silently defeats the hidden attribute');

  // Belt and braces: report any element that relies on `hidden` while its class
  // also sets display, so the global rule is doing visible work and we know where.
  const risky = new Set();
  for (const m of html.matchAll(/<(\w+)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
    const attrs = m[2];
    if (!/\bhidden\b(?!\s*=)/.test(attrs.replace(/aria-hidden\s*=\s*"[^"]*"/g, ''))) continue;
    const cls = /class\s*=\s*"([^"]+)"/.exec(attrs);
    if (cls) for (const c of cls[1].split(/\s+/)) risky.add(c);
  }
  for (const c of risky) {
    const own = new RegExp(`(^|,)\\s*\\.${c}\\s*{([^}]*)}`, 'm').exec(css);
    if (own && /(^|;)\s*display\s*:/.test(own[2])) {
      assert.ok(/\[hidden\]\s*{[^}]*display:\s*none\s*!important/.test(css),
        `.${c} sets display and is toggled via [hidden]`);
    }
  }
});

// ================================================================ report

console.log('\n' + '─'.repeat(58));
if (failed === 0) {
  console.log(`Pipeline verification: ${passed} checks passed.`);
} else {
  console.log(`Pipeline verification: ${passed} passed, ${failed} FAILED.`);
  for (const f of failures) console.log(`  ✕ ${f.name}\n      ${f.message}`);
}
console.log('─'.repeat(58));
process.exit(failed === 0 ? 0 : 1);
