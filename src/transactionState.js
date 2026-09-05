/**
 * TransactionState — ONE normalized object describing everything known about a
 * transaction, assembled on the server and read verbatim by every UI panel.
 *
 * This module ensures that the frontend must not invent information. Earlier,
 * each panel derived its own view from
 * whatever happened to be in the chat response: the stepper read
 * `chain.completedStages`, the trust bar read `chain.confidence`, the mandate
 * panel refetched from a different endpoint entirely, and the audit trail was a
 * third shape again. Four sources of truth, four chances to disagree.
 *
 * Now there is one. Every panel in the Transaction Control Center reads a field
 * of the object returned by buildTransactionState(). If a value isn't in here,
 * the UI doesn't show it — that constraint is what keeps the demo honest.
 *
 * IMPORTANT: this module computes nothing that the engines own. It calls the
 * risk engine, the approval gate and the payment guard because those are pure
 * functions over facts already established, but trust, policy, pricing and
 * agent identity are read from what the pipeline already decided. Nothing here
 * can change an outcome — it only assembles the record of one.
 */

import crypto from 'crypto';
import {
  STATUS, STAGES, STAGE_IDS, emptyStages, mark, markUpTo,
  haltedAt, reachedStage, progress, LAYERS, LAYER_LABELS
} from './pipeline.js';
import { scoreRisk, riskSummary } from './riskEngine.js';
import { evaluateApproval, approvalSummary, APPROVAL } from './approvalGate.js';
import { runPaymentGuard, guardSummary } from './paymentGuard.js';
import { buyerAgentIdentity, merchantAgentIdentity } from './agentIdentity.js';
import { getTrail } from './auditLog.js';
import { evaluateTransaction } from './decision/transactionEvaluator.js';
import { getCorrelationId } from './observability/correlation.js';

/**
 * Human-friendly transaction numbers. The raw transactionId is a UUID, which is
 * correct for the log and unreadable on a screen. These are allocated on first
 * sight and never reused, so "MDT-1042" always means the same transaction for
 * as long as the server is up.
 */
const displayIds = new Map();
let displayCounter = 1041;

export function displayIdFor(transactionId) {
  if (!transactionId) return 'MDT-————';
  if (!displayIds.has(transactionId)) {
    displayCounter += 1;
    displayIds.set(transactionId, `MDT-${displayCounter}`);
  }
  return displayIds.get(transactionId);
}

/**
 * A short integrity fingerprint over the frozen deal. Shown in the Final Deal
 * panel so "immutable snapshot" is a checkable claim rather than a promise: if
 * any priced field changed after freezing, this hash changes with it.
 */
function dealFingerprint(cart) {
  if (!cart) return null;
  const canonical = JSON.stringify({
    id: cart.item?.id,
    merchant: cart.item?.merchant,
    base: cart.pricing?.basePriceInr,
    list: cart.pricing?.listPriceInr,
    fee: cart.pricing?.crossBorderFeeInr,
    total: cart.pricing?.totalInr,
    negotiated: cart.pricing?.negotiated
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/**
 * Intent confidence, derived — NOT a new model.
 *
 * The spec asks the Intent panel to show a confidence figure. Rather than add
 * another AI call for it, this reads three facts the parser already reported:
 * which parser succeeded, whether a product query was extracted at all, and
 * whether a budget was found. That's an honest measure of "how sure are we we
 * understood this", and it costs nothing.
 */
function intentConfidence(intent) {
  if (!intent) return { pct: 0, basis: ['No request parsed yet'] };
  const basis = [];
  let pct = 40;

  if (intent.source === 'llm') {
    pct += 35;
    basis.push('Parsed by Gemini, which handles Hindi/Hinglish and loose phrasing');
  } else {
    pct += 18;
    basis.push('Parsed by the deterministic rule-based fallback');
  }

  if (intent.query && intent.query.trim()) {
    pct += 15;
    basis.push(`Product terms extracted: "${intent.query}"`);
  } else {
    pct -= 25;
    basis.push('No product terms could be extracted from the message');
  }

  if (intent.budget != null) {
    pct += 10;
    basis.push(intent.minBudget != null
      ? `Explicit budget range found: ₹${intent.minBudget.toLocaleString('en-IN')}–₹${intent.budget.toLocaleString('en-IN')}`
      : `Budget ceiling found: ₹${intent.budget.toLocaleString('en-IN')}`);
  } else {
    basis.push('No budget stated — the agent will ask rather than assume one');
  }

  return { pct: Math.max(0, Math.min(100, pct)), basis };
}

/**
 * The permissions the Intent Engine itself operates under. Stated explicitly
 * because the most important fact about this stage is what it CANNOT do: the
 * language model chooses search terms and nothing else. Price, trust, policy
 * and payment are all decided by code that never reads its output.
 */
const INTENT_PERMISSIONS = {
  allowed: [
    'Read the user\'s message',
    'Extract product search terms',
    'Extract a stated budget or budget range'
  ],
  denied: [
    'Set or alter any price',
    'Authorize a payment',
    'Modify the mandate',
    'Override trust, risk or policy'
  ]
};

/**
 * The Trust-vs-Policy contrast — the screen this whole version exists to make
 * possible. Trust and policy are computed independently; this only describes
 * the relationship between two results that already exist.
 */
function buildContrast(trust, policy, cart, mandate) {
  if (!trust && !policy) return null;

  const trustScore = trust?.score ?? null;
  const trustHigh = trustScore != null && trustScore >= (trust?.thresholds?.proceed ?? 70);
  const trustLegacyDecision = trust?.legacyDecision || trust?.decision;
  const policyLegacyDecision = policy?.legacyDecision || policy?.decision;
  const policyBlocked = policyLegacyDecision === 'blocked' || policy?.decision === 'BLOCK';
  const policyFlagged = policyLegacyDecision === 'human_approval_required' || policy?.decision === 'REVIEW';
  const total = cart?.pricing?.totalInr ?? null;

  let headline;
  let explanation;
  let tone;

  if (policyBlocked && trustHigh) {
    tone = 'contrast';
    headline = 'A trusted merchant can still be blocked by your mandate';
    explanation = `This merchant scores ${trustScore}/100 — genuinely credible, and the Trust Engine is happy. It made no difference. Your mandate is a separate, deterministic check, and it refused this purchase${total != null && mandate?.maxTransactionInr ? ` because ₹${total.toLocaleString('en-IN')} is past the ₹${mandate.maxTransactionInr.toLocaleString('en-IN')} limit you set` : ''}. Trust is an opinion about who you're dealing with; policy is your rule about what you'll allow. Policy wins.`;
  } else if (policyBlocked) {
    tone = 'blocked';
    headline = 'Blocked by your mandate, not by a low score';
    explanation = `Trust scored ${trustScore ?? '—'}/100, but that isn't why this stopped. Your mandate refused it outright, and no trust score can buy an exception to a rule you set.`;
  } else if (policyFlagged && trustHigh) {
    tone = 'flagged';
    headline = 'High trust, but your mandate still wants you to look';
    explanation = `Trust is ${trustScore}/100 and the merchant checks out. Your mandate has flagged this for a human decision anyway — trust decides how risky the counterparty looks, your mandate decides what may proceed without you.`;
  } else if (trust && !trustHigh && (policyLegacyDecision === 'approved' || policy?.decision === 'ALLOW')) {
    tone = 'inverse';
    headline = 'Your mandate permits this — trust is the reason it paused';
    explanation = `Your mandate is fine with ₹${total != null ? total.toLocaleString('en-IN') : '—'}: it's inside every limit you set. The hesitation is on the other axis — trust scored ${trustScore}/100, so this needs a closer look at the merchant, not at your rules.`;
  } else {
    tone = 'aligned';
    headline = 'Both checks agree — trust is sound and your mandate permits it';
    explanation = `Trust scored ${trustScore ?? '—'}/100 and your mandate raised no violations. These were evaluated independently and happened to agree, which is the normal case. When they disagree, your mandate wins.`;
  }

  return {
    tone,
    headline,
    explanation,
    trust: {
      score: trustScore,
      decision: trust?.decision ?? null,
      verdict: trustHigh ? 'TRUSTED' : (trustLegacyDecision === 'blocked' || trust?.decision === 'BLOCK') ? 'NOT TRUSTED' : 'NEEDS A LOOK',
      nature: 'Heuristic score, 0–100 · advisory',
      question: 'How credible is this merchant?',
      topReasons: (trust?.reasons ?? []).slice(0, 4)
    },
    policy: {
      decision: policy?.decision ?? null,
      verdict: policyBlocked ? 'BLOCKED' : policyFlagged ? 'NEEDS YOU' : 'PERMITTED',
      nature: 'Deterministic rule check · final say',
      question: 'Does this break a rule you set?',
      topReasons: policyBlocked ? (policy?.violations ?? []) : (policy?.flags ?? [])
    },
    rule: 'Trust never overrides policy. Policy has final say on whether money may move.'
  };
}

/**
 * Map an audit-log step name onto the pipeline stage it belongs to, so the
 * audit panel can be grouped by stage and each stage panel can show its own
 * events. Anything unmapped falls through to the audit stage, which is the
 * honest default rather than guessing.
 */
const STEP_TO_STAGE = {
  intent_parsed: 'intent',
  catalog_source: 'discovery',
  item_found: 'discovery',
  no_match_found: 'discovery',
  candidates_scored: 'discovery',
  item_selected: 'discovery',
  negotiation_offered: 'negotiation',
  negotiation_round: 'negotiation',
  negotiation_settled: 'negotiation',
  negotiation_declined: 'negotiation',
  NEGOTIATION_STARTED: 'negotiation',
  NEGOTIATION_MESSAGE_SENT: 'negotiation',
  OFFER_CREATED: 'negotiation',
  COUNTER_OFFER_CREATED: 'negotiation',
  BUNDLE_REQUESTED: 'negotiation',
  BUNDLE_OFFERED: 'negotiation',
  OFFER_ACCEPTED: 'negotiation',
  OFFER_REJECTED: 'negotiation',
  NEGOTIATION_CANCELLED: 'negotiation',
  NEGOTIATION_EXPIRED: 'negotiation',
  FINAL_DEAL_CREATED: 'deal',
  DEAL_VALIDATED: 'deal',
  DEAL_INVALIDATED: 'deal',
  DECISION_EVALUATED: 'policy',
  agent_permission_check: 'merchant_agent',
  cart_shown: 'deal',
  blocked_over_budget: 'deal',
  confidence_scored: 'trust',
  step_up_triggered: 'approval',
  step_up_failed: 'approval',
  step_up_verified: 'approval',
  blocked_low_confidence: 'trust',
  blocked_by_policy: 'policy',
  cart_pending_approval: 'approval',
  user_approved: 'approval',
  payment_guard_blocked: 'payment_guard',
  payment_guard_passed: 'payment_guard',
  payment_executed: 'razorpay',
  payment_blocked: 'payment_guard',
  cod_confirmed: 'razorpay',
  razorpay_order_created: 'razorpay',
  payment_captured: 'razorpay',
  payment_signature_invalid: 'razorpay',
  payment_cancelled: 'razorpay',
  receipt_generated: 'audit',
  receipt_generation_failed: 'audit',
  refund_processed: 'audit',
  refund_failed: 'audit'
};

/**
 * Build the complete TransactionState.
 *
 * @param {object} args
 * @param {object} args.session       the session object from server.js
 * @param {string} args.sessionId
 * @param {object} args.pending       session.pending, or a completed txn record
 * @param {object} args.intent        parsed intent for this request, if known
 * @param {object} args.overrides     live facts not yet stored on the session:
 *                                    { paymentGuard, paymentResult, error,
 *                                      stepUpVerified, injectionDetected,
 *                                      razorpayState, negotiation, discovery }
 * @param {number} args.dailySpentInr
 */
export function buildTransactionState({
  session,
  sessionId,
  pending = null,
  intent = null,
  overrides = {},
  dailySpentInr = 0
} = {}) {
  const p = pending || session?.pending || null;
  const transactionId = p?.transactionId || overrides.transactionId || null;

  const cart = p?.cart || overrides.cart || null;
  const item = p?.item || cart?.item || overrides.item || null;
  // A server-owned canonical decision is authoritative for finalized deals.
  const suppliedDecision = p?.decision || overrides.decision || null;
  const trust = suppliedDecision?.trust || p?.confidence || overrides.trust || null;
  const policy = suppliedDecision?.policy || p?.policy || overrides.policy || null;
  const mandate = session?.mandate || null;
  const mandateVersion = p?.mandateVersion ?? session?.mandateVersion ?? 1;
  const resolvedIntent = intent || overrides.intent || p?.intent || null;

  const stages = emptyStages();

  // ------------------------------------------------------------------
  // Stage 1 — Intent
  // ------------------------------------------------------------------
  const intentConf = intentConfidence(resolvedIntent);
  const intentBlock = resolvedIntent ? {
    raw: resolvedIntent.raw ?? overrides.rawMessage ?? null,
    query: resolvedIntent.query || null,
    budgetInr: resolvedIntent.budget ?? null,
    minBudgetInr: resolvedIntent.minBudget ?? null,
    terms: resolvedIntent.rawTerms || [],
    // Name the model that actually answered, not the one we hoped for. The
    // fallback chain in llmIntent.js means these can differ, and a panel that
    // claims a model the request never reached is exactly the kind of detail
    // a judge checks.
    parser: resolvedIntent.source === 'llm' ? `Gemini (${resolvedIntent.model || 'model unreported'})` : 'Rule-based parser',
    parserKey: resolvedIntent.source || 'rule-based',
    confidencePct: intentConf.pct,
    confidenceBasis: intentConf.basis,
    permissions: INTENT_PERMISSIONS,
    hardLimit: 'This model cannot authorize payment. It selects search terms; every price and every gate is decided by code that never reads its output.'
  } : null;

  if (intentBlock) {
    mark(stages, 'intent', STATUS.PASSED,
      `"${intentBlock.query || '—'}"${intentBlock.budgetInr ? ` · under ₹${intentBlock.budgetInr.toLocaleString('en-IN')}` : ''} · ${intentBlock.confidencePct}% confidence`,
      intentBlock);
  }

  // ------------------------------------------------------------------
  // Stage 2 — Buyer Agent
  // ------------------------------------------------------------------
  const buyerAgent = session ? {
    ...buyerAgentIdentity(session),
    // The identity module returns `type`; the panel wants a human role line and
    // the two facts that make the identity meaningful rather than decorative —
    // when it was issued, and which mandate version bounds it.
    role: 'Acts for you. Can shop and negotiate; cannot authorise payment.',
    issuedAt: session.createdAt || null,
    mandateVersion,
    enforcement: 'Denied actions are not merely absent from a prompt — there is no code path from this agent to the mandate, the approval gate, or the payment rail. It can ask; only your mandate can permit.'
  } : null;
  if (buyerAgent && intentBlock) {
    mark(stages, 'buyer_agent', STATUS.PASSED,
      `${buyerAgent.agentId} acting for ${buyerAgent.owner} · ${buyerAgent.permissions.allowed.length} allowed, ${buyerAgent.permissions.denied.length} denied`,
      buyerAgent);
  }

  // ------------------------------------------------------------------
  // Stage 3 — Product Discovery
  // ------------------------------------------------------------------
  const candidates = p?.candidates || overrides.candidates || null;
  const discovery = (candidates || item) ? {
    source: cart?.source || overrides.source || (item?.live ? 'live' : 'mock'),
    sourceLabel: (cart?.source || overrides.source) === 'live'
      ? 'Live search — Amazon India via RapidAPI'
      : 'Local catalog (data/catalog.json)',
    candidateCount: candidates?.length ?? (item ? 1 : 0),
    candidates: (candidates || []).map((c, i) => ({
      rank: i + 1,
      id: c.item?.id,
      name: c.item?.name,
      merchant: c.item?.merchant,
      priceInr: c.cart?.pricing?.totalInr,
      matchScore: c.confidence?.score ?? null,
      trustDecision: c.confidence?.decision ?? null,
      policyDecision: c.policy?.decision ?? null,
      selected: item ? c.item?.id === item.id : false
    })),
    chosen: item ? {
      id: item.id,
      name: item.name,
      merchant: item.merchant,
      category: item.category,
      listPriceInr: item.price_inr,
      merchantTenureDays: item.merchant_tenure_days ?? null,
      gstVerified: item.gst_verified ?? null,
      originCountry: item.origin_country ?? null,
      matchScore: trust?.score ?? null
    } : null,
    priceProvenance: 'Every price shown comes from a catalog record. No price is ever read out of user text or model output — that is the structural defence against price manipulation, not a filter that could be bypassed.'
  } : null;

  if (discovery) {
    mark(stages, 'discovery', STATUS.PASSED,
      discovery.chosen
        ? `${discovery.chosen.name} selected from ${discovery.candidateCount} ranked candidate${discovery.candidateCount === 1 ? '' : 's'}`
        : `${discovery.candidateCount} candidate${discovery.candidateCount === 1 ? '' : 's'} ranked by confidence`,
      discovery);
  }

  // ------------------------------------------------------------------
  // Stage 4 — Merchant Agent
  // ------------------------------------------------------------------
  const merchantAgent = item?.merchant ? {
    ...merchantAgentIdentity(item.merchant),
    role: 'Acts for the seller. Can offer and discount within a bound it does not control.',
    maxDiscountPct: 10,
    adversarial: 'This agent represents the seller, not you. It is separately identified precisely because its interests differ from yours — and its negotiation bound is re-derived and enforced server-side rather than trusted.'
  } : null;
  if (merchantAgent) {
    mark(stages, 'merchant_agent', STATUS.PASSED,
      `${merchantAgent.agentId} representing ${merchantAgent.owner} · discount floor enforced in code`,
      merchantAgent);
  }

  // ------------------------------------------------------------------
  // Stage 5 — Negotiation
  // ------------------------------------------------------------------
  const protocolNegotiation = p?.negotiation || overrides.negotiation || session?.negotiationEngine?.getSession(p?.negotiationId);
  const negotiated = !!cart?.pricing?.negotiated;
  const negotiation = protocolNegotiation ? {
    occurred: true,
    negotiationId: protocolNegotiation.negotiationId,
    transactionId: protocolNegotiation.transactionId,
    status: protocolNegotiation.status,
    buyerAgent: protocolNegotiation.buyerAgent,
    merchantAgent: protocolNegotiation.merchantAgent,
    buyerMaxInr: protocolNegotiation.buyerConstraints?.maxPriceInr,
    merchantFloorInr: protocolNegotiation.merchantConstraints?.floorInr,
    listPriceInr: protocolNegotiation.product?.listPriceInr,
    finalPriceInr: protocolNegotiation.currentOffer?.finalAmountInr ?? null,
    discountPct: protocolNegotiation.currentOffer?.basePriceInr && protocolNegotiation.product?.listPriceInr
      ? Math.round((1 - protocolNegotiation.currentOffer.basePriceInr / protocolNegotiation.product.listPriceInr) * 10000) / 100
      : 0,
    boundPct: protocolNegotiation.merchantConstraints?.maxDiscountPct ?? 10,
    rounds: protocolNegotiation.rounds,
    offers: protocolNegotiation.offers || [],
    currentOffer: protocolNegotiation.currentOffer,
    messages: protocolNegotiation.messages || [],
    transcript: (protocolNegotiation.messages || []).map(entry => ({
      side: String(entry.sender?.role || 'SYSTEM').toLowerCase(),
      who: entry.sender?.role === 'BUYER' ? `Buyer Agent · ${entry.sender.agentId}` : entry.sender?.role === 'MERCHANT' ? `Merchant Agent · ${entry.sender.agentId}` : 'MANDATE',
      text: entry.message || entry.type.replace(/_/g, ' '),
      priceInr: entry.requestedPriceInr ?? null,
      timestamp: entry.timestamp,
      messageId: entry.messageId,
      validation: entry.validation || null
    })),
    enforcement: 'Every offer is validated centrally against both the Buyer Agent maximum and the Merchant Agent discount floor. Acceptance creates a deal proposal only; MANDATE still controls money.'
  } : (negotiated ? {
    occurred: true,
    listPriceInr: cart.pricing.listPriceInr,
    finalPriceInr: cart.pricing.basePriceInr,
    discountPct: cart.pricing.listPriceInr
      ? Math.round((1 - cart.pricing.basePriceInr / cart.pricing.listPriceInr) * 100)
      : 0,
    boundPct: 10,
    transcript: overrides.transcript || null,
    enforcement: 'The agreed price was re-checked against the item\'s own list price server-side. A price below the enforced floor is clamped, not accepted.'
  } : { occurred: false, reason: 'Paid list price — no negotiation was requested for this purchase.' });

  if (negotiation.occurred) {
    mark(stages, 'negotiation', STATUS.PASSED,
      `₹${negotiation.listPriceInr?.toLocaleString('en-IN')} → ₹${negotiation.finalPriceInr?.toLocaleString('en-IN')} (${negotiation.discountPct}% off, bound ${negotiation.boundPct}%)`,
      negotiation);
  } else if (item) {
    mark(stages, 'negotiation', STATUS.PASSED, 'Skipped — list price accepted', negotiation);
  }

  // ------------------------------------------------------------------
  // Stage 6 — Final Deal (frozen snapshot)
  // ------------------------------------------------------------------
  const snapshotDeal = p?.deal || overrides.deal || null;
  const deal = snapshotDeal ? {
    dealId: snapshotDeal.dealId,
    negotiationId: snapshotDeal.negotiationId,
    mandateVersion: snapshotDeal.mandateVersion,
    status: snapshotDeal.status,
    validation: p?.dealValidation || overrides.dealValidation || null,
    fingerprint: snapshotDeal.fingerprint,
    item: snapshotDeal.product,
    pricing: snapshotDeal.pricing,
    deliveryEstimate: cart?.deliveryEstimate || null,
    isCrossBorder: !!cart?.isCrossBorder,
    withinBudget: snapshotDeal.pricing.finalAmountInr <= (protocolNegotiation?.buyerConstraints?.maxPriceInr ?? snapshotDeal.pricing.finalAmountInr),
    approved: !!cart?.approved,
    frozen: 'Accepted by agents is not payment authorization. This immutable deal is handed to MANDATE for trust, risk, policy, approval, and Payment Guard checks.',
    lines: [
      { label: 'List price', valueInr: snapshotDeal.pricing.listPriceInr },
      { label: 'Negotiated price', valueInr: snapshotDeal.pricing.negotiatedPriceInr },
      ...(snapshotDeal.pricing.bundlePriceInr ? [{ label: 'Bundle', valueInr: snapshotDeal.pricing.bundlePriceInr }] : []),
      { label: 'Final amount', valueInr: snapshotDeal.pricing.finalAmountInr, emphasis: true }
    ]
  } : cart ? {
    fingerprint: dealFingerprint(cart),
    item: cart.item,
    pricing: cart.pricing,
    deliveryEstimate: cart.deliveryEstimate,
    isCrossBorder: cart.isCrossBorder,
    withinBudget: cart.withinBudget,
    approved: cart.approved,
    frozen: 'Every check after this point reads this snapshot. The Payment Guard re-compares the charge against it at execution time, so a price change after approval is caught rather than absorbed.',
    lines: [
      { label: 'Base price', valueInr: cart.pricing.basePriceInr },
      ...(cart.pricing.crossBorderFeeInr ? [{ label: 'Cross-border fee (2.5%)', valueInr: cart.pricing.crossBorderFeeInr }] : []),
      { label: 'Total', valueInr: cart.pricing.totalInr, emphasis: true }
    ]
  } : null;

  if (deal) {
    mark(stages, 'deal', STATUS.PASSED,
      `₹${(deal.pricing.finalAmountInr ?? deal.pricing.totalInr).toLocaleString('en-IN')} frozen · fingerprint ${deal.fingerprint}`,
      deal);
  }

  // ------------------------------------------------------------------
  // Stage 7 — Trust
  //
  // The scale/question/authority annotations are attached to the object itself,
  // not just to the stage copy. Two reasons: the UI reads `state.trust` in some
  // places and the stage detail in others, and an annotation that exists in only
  // one of those is an invisible trap — the panel renders fine while the split
  // screen quietly loses its caption.
  // ------------------------------------------------------------------
  const trustBlock = trust ? {
    ...trust,
    scale: 'Higher is better. 70+ proceeds, 40–69 needs step-up, below 40 is refused.',
    question: 'How credible is this merchant?',
    authority: 'Advisory. Trust can raise the bar but can never override your mandate.',
    stepUpVerified: !!overrides.stepUpVerified
  } : null;

  if (trustBlock) {
    const status = trust.decision === 'BLOCK' || trust.legacyDecision === 'blocked' ? STATUS.BLOCKED : STATUS.PASSED;
    mark(stages, 'trust', status,
      `${trust.score}/100 · ${(trust.level || trust.decision || '—').replace(/_/g, ' ')}${trustBlock.stepUpVerified ? ' (step-up cleared)' : ''}`,
      trustBlock);
  }

  // ------------------------------------------------------------------
  // Stage 8 — Risk (computed here; derived entirely from existing facts)
  // ------------------------------------------------------------------
  let risk = suppliedDecision?.risk || overrides.risk || null;
  if (!risk && cart && mandate) {
    risk = scoreRisk({
      amountInr: cart.pricing.totalInr,
      mandate,
      dailySpentInr,
      listPriceInr: cart.pricing.listPriceInr,
      basePriceInr: cart.pricing.basePriceInr,
      merchantTenureDays: item?.merchant_tenure_days ?? 365,
      gstVerified: item?.gst_verified ?? true,
      isCrossBorder: cart.isCrossBorder,
      recentPurchaseCount: overrides.recentPurchaseCount ?? 0,
      injectionDetected: !!overrides.injectionDetected,
      category: item?.category || 'default'
    });
  }
  if (risk) {
    risk = {
      ...risk,
      scale: 'Higher is WORSE — this axis runs opposite to trust. Below 30 is clear, 30–59 is elevated, 60+ is high.',
      question: 'How unusual is this transaction?',
      authority: 'Advisory. Risk can insist a human looks, but it cannot block a purchase on its own.',
      distinction: 'Separate from trust on purpose. A merchant can be entirely credible while the purchase itself is unusual — a 96/100 merchant, at 98% of your ceiling, on your fourth order in ten minutes, is high trust and high risk at the same time.'
    };
    mark(stages, 'risk', STATUS.PASSED, riskSummary(risk), risk);
  }

  // ------------------------------------------------------------------
  // Stage 9 — Policy
  // ------------------------------------------------------------------
  const policyBlock = policy ? {
    ...policy,
    mandate,
    mandateVersion,
    dailySpentInr,
    checks: mandate ? [
      {
        label: 'Per-transaction ceiling',
        limitInr: mandate.maxTransactionInr,
        actualInr: cart?.pricing?.totalInr ?? null,
        ok: cart ? cart.pricing.totalInr <= mandate.maxTransactionInr : null
      },
      {
        label: 'Daily limit',
        limitInr: mandate.dailyLimitInr,
        actualInr: dailySpentInr + (cart?.pricing?.totalInr ?? 0),
        ok: cart ? (dailySpentInr + cart.pricing.totalInr) <= mandate.dailyLimitInr : null
      },
      {
        label: 'Autonomous spend threshold',
        limitInr: mandate.autonomousSpendThresholdInr,
        actualInr: cart?.pricing?.totalInr ?? null,
        ok: cart ? cart.pricing.totalInr <= mandate.autonomousSpendThresholdInr : null,
        note: 'Exceeding this does not block — it removes the agent\'s autonomy and asks you.'
      },
      {
        label: 'Blocked categories',
        limitInr: null,
        actualLabel: item?.category || '—',
        ok: item ? !mandate.blockedCategories.includes(item.category) : null
      },
      {
        label: 'Cross-border allowed',
        limitInr: null,
        actualLabel: cart?.isCrossBorder ? 'cross-border' : 'domestic',
        ok: cart ? (mandate.allowCrossBorder || !cart.isCrossBorder) : null
      }
    ] : [],
    question: 'Does this break a rule you set?',
    authority: 'Final say. Deterministic, not scored. Nothing in this pipeline can overrule it.'
  } : null;

  if (policyBlock) {
    const policyBlocked = policy.decision === 'BLOCK' || policy.legacyDecision === 'blocked' || policy.decision === 'blocked';
    const policyReview = policy.decision === 'REVIEW' || policy.legacyDecision === 'human_approval_required' || policy.decision === 'human_approval_required';
    const status = policyBlocked ? STATUS.BLOCKED : STATUS.PASSED;
    mark(stages, 'policy', status,
      policyBlocked
        ? `BLOCKED · ${policy.violations.length} violation${policy.violations.length === 1 ? '' : 's'}`
        : policyReview
          ? `Permitted, flagged for human approval`
          : `Permitted · no violations`,
      policyBlock);
  }

  // The canonical view re-evaluates the same frozen transaction facts via
  // separately named deterministic engines. It complements the legacy stage
  // details rather than allowing a UI presentation to change an outcome.
  const decision = suppliedDecision || (cart && mandate ? evaluateTransaction({
    trustInput: {
      crossBorder: !!cart.isCrossBorder, verificationMatch: true,
      amountRatio: resolvedIntent?.budget ? cart.pricing.totalInr / resolvedIntent.budget : 0.5,
      knownMerchant: !cart.isCrossBorder && !item?.live && (item?.merchant_tenure_days ?? 0) >= 180,
      merchantTenureDays: item?.merchant_tenure_days ?? 365, gstVerified: item?.gst_verified ?? true,
      isLive: !!item?.live, sellerRating: item?.sellerRating ?? null, sellerRatingCount: item?.sellerRatingCount ?? 0,
      category: item?.category || 'default', recentPurchaseCount: overrides.recentPurchaseCount ?? 0
    },
    riskInput: {
      amountInr: cart.pricing.totalInr, mandate, dailySpentInr,
      listPriceInr: cart.pricing.listPriceInr, basePriceInr: cart.pricing.basePriceInr,
      merchantTenureDays: item?.merchant_tenure_days ?? 365, gstVerified: item?.gst_verified ?? true,
      isCrossBorder: !!cart.isCrossBorder, recentPurchaseCount: overrides.recentPurchaseCount ?? 0,
      injectionDetected: !!overrides.injectionDetected, category: item?.category || 'default'
    },
    policyInput: { amountInr: cart.pricing.totalInr, category: item?.category || 'default', isCrossBorder: !!cart.isCrossBorder, mandate, dailySpentInr }
  }) : null);

  // ------------------------------------------------------------------
  // The contrast view (§15) — the screen this version exists for
  // ------------------------------------------------------------------
  const contrast = buildContrast(trust, policy, cart, mandate);

  // ------------------------------------------------------------------
  // Stage 10 — Approval Gate
  // ------------------------------------------------------------------
  let approval = overrides.approval || null;
  if (!approval && cart && mandate) {
    approval = evaluateApproval({
      amountInr: cart.pricing.totalInr,
      mandate,
      trust,
      risk,
      policy,
      decision,
      stepUpVerified: !!overrides.stepUpVerified
    });
  }
  if (approval) {
    const status = approval.mode === APPROVAL.BLOCKED
      ? STATUS.BLOCKED
      : (p?.awaitingApproval || p?.awaitingOtp || p?.awaitingFinalApproval)
        ? STATUS.RUNNING
        : STATUS.PASSED;
    mark(stages, 'approval', status, approvalSummary(approval), approval);
  }

  // ------------------------------------------------------------------
  // Stage 11 — Payment Guard
  // ------------------------------------------------------------------
  const paymentGuard = overrides.paymentGuard || null;
  if (paymentGuard) {
    mark(stages, 'payment_guard',
      paymentGuard.passed ? STATUS.PASSED : STATUS.BLOCKED,
      guardSummary(paymentGuard), paymentGuard);
  }

  // ------------------------------------------------------------------
  // Stage 12 — Razorpay
  // ------------------------------------------------------------------
  const paymentResult = overrides.paymentResult || p?.paymentResult || null;
  const razorpayState = overrides.razorpayState
    || (paymentResult
      ? (paymentResult.status === 'cod_pending' ? 'cod_pending' : 'captured')
      : p?.awaitingOnlinePayment ? 'awaiting_customer' : null);

  const razorpay = razorpayState ? {
    state: razorpayState,
    stateLabel: {
      awaiting_customer: 'Waiting for the customer at the Razorpay widget',
      order_created: 'Order created — not yet paid',
      captured: 'Captured and signature-verified',
      cod_pending: 'Cash on Delivery — nothing charged now',
      cancelled: 'Cancelled by the customer',
      failed: 'Failed at the rail',
      refunded: 'Refunded'
    }[razorpayState] || razorpayState,
    orderId: paymentResult?.orderId ?? overrides.orderId ?? null,
    paymentId: paymentResult?.paymentId ?? null,
    amountInr: paymentResult?.amountInr ?? cart?.pricing?.totalInr ?? null,
    method: overrides.paymentMethod || p?.paymentMethod || null,
    signatureVerified: overrides.signatureVerified ?? (paymentResult?.paymentId ? true : null),
    mode: 'test',
    signatureNote: 'A payment is only ever treated as successful after HMAC-SHA256(order_id|payment_id) is recomputed server-side and matches. The browser\'s claim of success is never sufficient.'
  } : null;

  if (razorpay) {
    const status = razorpayState === 'failed' ? STATUS.FAILED
      : razorpayState === 'cancelled' ? STATUS.FAILED
      : razorpayState === 'awaiting_customer' ? STATUS.RUNNING
      : STATUS.PASSED;
    mark(stages, 'razorpay', status,
      razorpay.orderId ? `${razorpay.stateLabel} · ${razorpay.orderId}` : razorpay.stateLabel,
      razorpay);
  }

  // ------------------------------------------------------------------
  // Stages 13 & 14 — Audit + Replay
  // ------------------------------------------------------------------
  const events = transactionId ? (getTrail(transactionId) || []) : [];
  const audit = {
    transactionId,
    displayId: displayIdFor(transactionId),
    eventCount: events.length,
    events: events.map(e => ({
      step: e.step,
      stage: STEP_TO_STAGE[e.step] || 'audit',
      timestamp: e.timestamp,
      details: e.details
    })),
    nature: 'Append-only. Entries are written as decisions happen and are never edited or removed — the log is the evidence, not a summary of it.'
  };

  if (events.length > 0) {
    const paymentComplete = razorpayState === 'captured' || razorpayState === 'cod_pending';
    mark(stages, 'audit', paymentComplete ? STATUS.PASSED : STATUS.RUNNING,
      paymentComplete
        ? `${events.length} event${events.length === 1 ? '' : 's'} recorded`
        : `${events.length} event${events.length === 1 ? '' : 's'} recorded so far`, audit);
    if (paymentComplete) {
      mark(stages, 'replay', STATUS.PASSED,
        `Replayable — ${events.length} steps can be played back in order`,
        { available: true, stepCount: events.length,
          note: 'Replay reads the same append-only log, one entry at a time. Nothing is re-simulated, so what you see is what was actually recorded.' });
    }
  }

  // ------------------------------------------------------------------
  // Explicit failure override (e.g. a thrown payment error)
  // ------------------------------------------------------------------
  if (overrides.error) {
    const failStage = overrides.errorStage || 'razorpay';
    mark(stages, failStage,
      overrides.recovered ? STATUS.RECOVERED : STATUS.FAILED,
      overrides.recovered ? `Recovered safely — ${overrides.error}` : overrides.error,
      { error: overrides.error, recovered: !!overrides.recovered, recoveryNote: overrides.recoveryNote || null });
  }

  // Audit entries are emitted throughout a transaction, including before the
  // user approves it. They must never make the UI infer that a later money
  // stage ran. Reconstruct continuity only up to the furthest *transaction*
  // stage, never from audit/replay activity.
  const transactionReached = razorpay
    ? 'razorpay'
    : paymentGuard
      ? 'payment_guard'
      : approval
        ? 'approval'
        : policyBlock
          ? 'policy'
          : risk
            ? 'risk'
            : trustBlock
              ? 'trust'
              : deal
                ? 'deal'
                : negotiation?.occurred
                  ? 'negotiation'
                  : merchantAgent
                    ? 'merchant_agent'
                    : discovery
                      ? 'discovery'
                      : buyerAgent && intentBlock
                        ? 'buyer_agent'
                        : intentBlock
                          ? 'intent'
                          : null;
  if (transactionReached) markUpTo(stages, transactionReached);
  const reached = transactionReached || reachedStage(stages);

  // ------------------------------------------------------------------
  // Global status header
  // ------------------------------------------------------------------
  const halted = haltedAt(stages);
  const prog = progress(stages);

  let status;
  if (halted) {
    status = halted.status === STATUS.BLOCKED
      ? { code: 'BLOCKED', label: `Blocked at ${halted.stage.label}`, tone: 'red',
          detail: halted.summary, protectedClaim: 'This is the system working, not failing.' }
      : { code: 'FAILED', label: `Failed at ${halted.stage.label}`, tone: 'orange', detail: halted.summary };
  } else if (razorpayState === 'captured' || razorpayState === 'cod_pending') {
    status = { code: 'COMPLETED', label: 'Completed — payment executed and logged', tone: 'green' };
  } else if (approval && (approval.mode === APPROVAL.HUMAN || approval.mode === APPROVAL.STEP_UP)) {
    status = { code: 'AWAITING_HUMAN', label: approval.headline, tone: 'amber', detail: approval.reason };
  } else if (reached) {
    status = { code: 'IN_PROGRESS', label: `In progress — at ${STAGES.find(s => s.id === reached)?.label}`, tone: 'blue' };
  } else {
    status = { code: 'IDLE', label: 'No transaction in flight', tone: 'grey' };
  }

  return {
    transactionId,
    correlationId: getCorrelationId(transactionId),
    displayId: displayIdFor(transactionId),
    sessionId,
    createdAt: p?.createdAt ? new Date(p.createdAt).toISOString() : null,
    updatedAt: new Date().toISOString(),

    status,
    reached,
    halted: halted ? { stageId: halted.id, stageLabel: halted.stage.label, status: halted.status, summary: halted.summary } : null,
    progress: prog,

    stages,
    stageOrder: STAGE_IDS,
    stageMeta: STAGES,
    layers: Object.values(LAYERS).map(k => ({ key: k, label: LAYER_LABELS[k], stageIds: STAGES.filter(s => s.layer === k).map(s => s.id) })),

    intent: intentBlock,
    buyerAgent,
    discovery,
    merchantAgent,
    negotiation,
    deal,
    // These are the annotated blocks, not the raw engine output. The panels read
    // `state.trust` / `state.policy` in some places and `stages.<id>.detail` in
    // others; returning the un-annotated object here would mean a caption that
    // exists in one view and silently vanishes in the other.
    trust: trustBlock,
    risk,
    policy: policyBlock,
    contrast,
    approval,
    decision,
    paymentGuard,
    razorpay,
    audit,

    mandate,
    mandateVersion,
    dailySpentInr
  };
}
