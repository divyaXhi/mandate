/**
 * Approval Gate — decides whether the agent may act alone, or must stop and
 * put a human in the loop.
 *
 * This logic was previously implemented as inline branches scattered
 * through server.js, which meant the most interesting question in the product —
 * "why did it need to ask me?" — had no single answer to point at. This module pulls
 * it into one place so the Control Center can show the comparison that was
 * actually made, against the actual number, with the actual reason.
 *
 * The gate never invents authority. It can only ever do one of four things:
 *   autonomous      — the agent proceeds without interrupting you
 *   step_up_required— identity re-check needed before you can even approve
 *   human_required  — a human must explicitly approve
 *   blocked         — no approval is possible; the transaction is refused
 *
 * Critically: the gate cannot un-block a policy refusal. If the Policy Engine
 * said no, this returns `blocked` no matter how good trust looks. Policy has
 * final say — that ordering is the whole product.
 */

export const APPROVAL = {
  AUTONOMOUS: 'autonomous',
  STEP_UP: 'step_up_required',
  HUMAN: 'human_required',
  BLOCKED: 'blocked'
};

/**
 * @param {object} input
 * @param {number} input.amountInr          the frozen deal total
 * @param {object} input.mandate            user mandate (needs autonomousSpendThresholdInr)
 * @param {object} input.trust              trustLayer.scoreConfidence() output
 * @param {object} input.risk               riskEngine.scoreRisk() output
 * @param {object} input.policy             policyEngine.evaluatePolicy() output
 * @param {object} input.decision           canonical transaction decision
 * @param {boolean} input.stepUpVerified    has the user already cleared step-up?
 * @returns {{mode:string, allowed:boolean, autonomous:boolean, threshold:number,
 *            headline:string, reason:string, triggers:Array, comparison:object,
 *            humanActionLabel:string|null}}
 */
export function evaluateApproval({
  amountInr = 0,
  mandate = null,
  trust = null,
  risk = null,
  policy = null,
  decision = null,
  stepUpVerified = false
} = {}) {
  const threshold = mandate?.autonomousSpendThresholdInr ?? 0;
  const trustDecision = trust?.legacyDecision || trust?.decision;
  const policyDecision = policy?.legacyDecision || policy?.decision;

  // The comparison the gate actually performs, exposed verbatim so the UI can
  // render the arithmetic rather than a verdict. "₹2,400 > ₹2,000" is a far
  // better explanation than "human approval required".
  const comparison = {
    amountInr,
    thresholdInr: threshold,
    overThreshold: threshold > 0 && amountInr > threshold,
    text: threshold > 0
      ? `₹${Math.round(amountInr).toLocaleString('en-IN')} ${amountInr > threshold ? '>' : '≤'} ₹${threshold.toLocaleString('en-IN')} autonomous limit`
      : `No autonomous limit configured — every purchase asks`
  };

  const triggers = [];

  // ---- Hard refusals first. Nothing below can override these.
  if (policy && (policyDecision === 'blocked' || policy.decision === 'BLOCK')) {
    return {
      mode: APPROVAL.BLOCKED,
      allowed: false,
      autonomous: false,
      threshold,
      comparison,
      headline: 'No approval possible',
      reason: 'Your mandate refuses this transaction outright, so there is nothing here for you to approve. Approval can gate a permitted purchase; it cannot authorise a forbidden one.',
      triggers: (policy.violations || []).map(v => ({ source: 'Policy Engine', label: 'Mandate violation', detail: v })),
      humanActionLabel: null
    };
  }

  if (trust && (trustDecision === 'blocked' || trust.decision === 'BLOCK')) {
    return {
      mode: APPROVAL.BLOCKED,
      allowed: false,
      autonomous: false,
      threshold,
      comparison,
      headline: 'No approval possible',
      reason: `Trust in this counterparty is too low to proceed (${trust.score}/100). This one needs manual review — step-up verification would confirm who you are, but the problem is who they are.`,
      triggers: (trust.reasons || []).map(r => ({ source: 'Trust Engine', label: 'Low trust', detail: r })),
      humanActionLabel: null
    };
  }

  // The canonical resolver is deliberately redundant with the detailed engines
  // above: those branches retain the most useful explanation, while this
  // fallback means a frozen canonical result cannot be accidentally bypassed
  // if a legacy presentation field is absent.
  if (decision?.finalDecision === 'BLOCK') {
    return {
      mode: APPROVAL.BLOCKED,
      allowed: false,
      autonomous: false,
      threshold,
      comparison,
      headline: 'No approval possible',
      reason: `The transaction decision is BLOCK (${decision.reason}). Approval cannot override a blocked mandate or trust result.`,
      triggers: (decision.reasons || []).map(r => ({ source: r.engine || 'Decision Engine', label: 'Decision evidence', detail: r.detail || String(r) })),
      humanActionLabel: null
    };
  }

  // ---- Escalation triggers. Any single one is enough to stop autonomy.
  if (comparison.overThreshold) {
    triggers.push({
      source: 'Your mandate',
      label: 'Above autonomous limit',
      detail: `${comparison.text} — you set this line, so the agent stops here and asks.`
    });
  }

  if (policy && (policyDecision === 'human_approval_required' || policy.decision === 'REVIEW')) {
    for (const f of policy.flags || []) {
      triggers.push({ source: 'Policy Engine', label: 'Mandate flag', detail: f });
    }
    if (!(policy.flags || []).length) {
      triggers.push({ source: 'Policy Engine', label: 'Mandate flag', detail: 'Your mandate requires a human decision on this purchase.' });
    }
  }

  const needsStepUp = !!(trust && trustDecision === 'step_up_required' && !stepUpVerified);
  if (needsStepUp) {
    triggers.push({
      source: 'Trust Engine',
      label: 'Identity re-check',
      detail: `Trust is moderate (${trust.score}/100) — confirm it's really you before this goes any further.`
    });
  }

  if (risk && risk.band === 'high') {
    triggers.push({
      source: 'Risk Engine',
      label: 'High transaction risk',
      detail: `Risk scored ${risk.score}/100. Risk cannot block a purchase on its own, but it can insist a human looks at it.`
    });
  }

  if (decision?.finalDecision === 'REVIEW' && triggers.length === 0) {
    triggers.push({
      source: 'Decision Engine',
      label: 'Canonical review',
      detail: `The combined deterministic checks require review (${decision.reason}).`
    });
  }

  // ---- Step-up outranks plain human approval: you cannot meaningfully approve
  //      a purchase until we know you're you.
  if (needsStepUp) {
    return {
      mode: APPROVAL.STEP_UP,
      allowed: false,
      autonomous: false,
      threshold,
      comparison,
      headline: 'Identity check required',
      reason: 'Verify it\'s you, then you can decide on this purchase.',
      triggers,
      humanActionLabel: 'Enter the one-time code'
    };
  }

  if (triggers.length > 0) {
    return {
      mode: APPROVAL.HUMAN,
      allowed: true,
      autonomous: false,
      threshold,
      comparison,
      headline: 'Human approval required',
      reason: triggers.length === 1
        ? triggers[0].detail
        : `${triggers.length} separate checks each want a human on this one.`,
      triggers,
      humanActionLabel: 'Approve this purchase'
    };
  }

  // ---- Autonomous. Still worth saying WHY it was allowed to be autonomous,
  //      because "the agent just went ahead" is the scary reading and the
  //      honest answer is "you already authorised exactly this shape of spend".
  return {
    mode: APPROVAL.AUTONOMOUS,
    allowed: true,
    autonomous: true,
    threshold,
    comparison,
    headline: 'Agent may proceed alone',
    reason: threshold > 0
      ? `${comparison.text}, trust and risk are both inside tolerance, and your mandate raised no flags. You pre-authorised this shape of purchase, so the agent doesn't need to interrupt you.`
      : 'Trust and risk are inside tolerance and your mandate raised no flags.',
    triggers: [],
    humanActionLabel: null
  };
}

/**
 * One-line summary for the pipeline rail.
 */
export function approvalSummary(approval) {
  if (!approval) return null;
  switch (approval.mode) {
    case APPROVAL.AUTONOMOUS: return `Autonomous · ${approval.comparison.text}`;
    case APPROVAL.STEP_UP: return `Step-up required · identity re-check`;
    case APPROVAL.HUMAN: return `Human approval required · ${approval.triggers.length} trigger${approval.triggers.length > 1 ? 's' : ''}`;
    case APPROVAL.BLOCKED: return `No approval possible`;
    default: return null;
  }
}
