/**
 * The 14-stage MANDATE pipeline — the single source of truth for what stages
 * exist, what order they run in, and what each one is allowed to be called.
 *
 * This module prevents the frontend from hard-coding a shortened six-stage
 * stepper (intent → cart → trust → approval → payment → audit) that hid most
 * of what the backend actually does. Every stage listed here has a real panel
 * in the Transaction Control Center, and every panel reads its data from the
 * normalized TransactionState (see transactionState.js) rather than inventing
 * its own copy.
 *
 * Nothing in this module makes decisions. It only names and orders them.
 */

/**
 * Stage status vocabulary. Deliberately small — six states is enough to say
 * everything the UI needs to say, and a bigger enum would just create
 * ambiguity about which colour to paint a stage.
 *
 *  PENDING   — not reached yet (grey)
 *  RUNNING   — currently executing (blue, animated)
 *  PASSED    — completed successfully (green)
 *  BLOCKED   — a gate refused it on purpose (red) — this is a CORRECT outcome
 *  FAILED    — something broke unintentionally (orange)
 *  RECOVERED — failed, then recovered safely without harm (orange → green)
 */
export const STATUS = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  PASSED: 'PASSED',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
  RECOVERED: 'RECOVERED'
};

/**
 * The four conceptual layers a transaction passes through. Used to group the
 * pipeline visually so 14 stages read as four ideas instead of a long list.
 */
export const LAYERS = {
  AGENT: 'agent',
  DECISION: 'decision',
  MONEY: 'money',
  RECORD: 'record'
};

export const LAYER_LABELS = {
  [LAYERS.AGENT]: 'Agent layer — what the AI is allowed to do',
  [LAYERS.DECISION]: 'Decision layer — whether this deal may touch money',
  [LAYERS.MONEY]: 'Money layer — the last line before funds move',
  [LAYERS.RECORD]: 'Record layer — proof after the fact'
};

/**
 * The 14 stages, in execution order.
 *
 * `id`       — stable key used by TransactionState, the DOM, and the audit map
 * `label`    — what the judge reads
 * `icon`     — one glyph per stage, no more (see the UI rules in the build plan)
 * `layer`    — grouping
 * `owner`    — who/what performs this stage; makes the AI-vs-control split legible
 * `blurb`    — one line explaining the stage's job, shown in its detail panel
 */
export const STAGES = [
  {
    id: 'intent',
    label: 'Intent Engine',
    icon: '◎',
    layer: LAYERS.AGENT,
    owner: 'AI (Gemini / rule-based fallback)',
    blurb: 'Turns a sentence into a structured request. It decides what to look for — nothing else.'
  },
  {
    id: 'buyer_agent',
    label: 'Buyer Agent',
    icon: '⬡',
    layer: LAYERS.AGENT,
    owner: 'AI, under a declared permission set',
    blurb: 'Acts for you inside explicit bounds. It can shop and negotiate; it cannot approve payment.'
  },
  {
    id: 'discovery',
    label: 'Product Discovery',
    icon: '⌕',
    layer: LAYERS.AGENT,
    owner: 'Catalog search (live or local)',
    blurb: 'Finds and ranks real candidates. Prices come from catalog records, never from free text.'
  },
  {
    id: 'merchant_agent',
    label: 'Merchant Agent',
    icon: '⬢',
    layer: LAYERS.AGENT,
    owner: 'Seller-side AI, separately identified',
    blurb: 'The other side of the table. It has its own ID and its own hard limits.'
  },
  {
    id: 'negotiation',
    label: 'Negotiation',
    icon: '⇄',
    layer: LAYERS.AGENT,
    owner: 'Buyer Agent ⇄ Merchant Agent',
    blurb: 'Two agents settling a price. The discount floor is enforced in code, not by good manners.'
  },
  {
    id: 'deal',
    label: 'Final Deal',
    icon: '▣',
    layer: LAYERS.AGENT,
    owner: 'System (frozen snapshot)',
    blurb: 'The deal is frozen here. Every later check reads this snapshot, so the price cannot drift.'
  },
  {
    id: 'trust',
    label: 'Trust Engine',
    icon: '◈',
    layer: LAYERS.DECISION,
    owner: 'Heuristic scoring, 0–100',
    blurb: 'How credible is this merchant? An opinion about the counterparty — advisory only.'
  },
  {
    id: 'risk',
    label: 'Risk Engine',
    icon: '◬',
    layer: LAYERS.DECISION,
    owner: 'Heuristic scoring, 0–100',
    blurb: 'How unusual is this transaction? A separate axis from trust — a trusted seller can still be a risky purchase.'
  },
  {
    id: 'policy',
    label: 'Policy Engine',
    icon: '⛨',
    layer: LAYERS.DECISION,
    owner: 'Your mandate — deterministic',
    blurb: 'Your rules, checked exactly. Not a score, not negotiable, and it has the final say.'
  },
  {
    id: 'approval',
    label: 'Approval Gate',
    icon: '⎔',
    layer: LAYERS.DECISION,
    owner: 'Mandate threshold, then you',
    blurb: 'Decides whether the agent may act alone or must stop and ask a human.'
  },
  {
    id: 'payment_guard',
    label: 'Payment Guard',
    icon: '⚿',
    layer: LAYERS.MONEY,
    owner: 'System — six pre-flight checks',
    blurb: 'The last gate before money moves. Re-verifies everything, assuming the earlier stages could be wrong.'
  },
  {
    id: 'razorpay',
    label: 'Razorpay Execution',
    icon: '₹',
    layer: LAYERS.MONEY,
    owner: 'Razorpay (test mode)',
    blurb: 'The actual rail. Signature-verified on the way back — a payment is never trusted on the client\'s word.'
  },
  {
    id: 'audit',
    label: 'Audit Trail',
    icon: '☰',
    layer: LAYERS.RECORD,
    owner: 'Append-only log',
    blurb: 'Every decision above, timestamped and immutable. Nothing about this transaction is unrecorded.'
  },
  {
    id: 'replay',
    label: 'Replay',
    icon: '↺',
    layer: LAYERS.RECORD,
    owner: 'Audit trail, played back',
    blurb: 'The whole decision re-run step by step, from the log — so a claim can be checked, not just believed.'
  }
];

export const STAGE_IDS = STAGES.map(s => s.id);

const STAGE_BY_ID = new Map(STAGES.map(s => [s.id, s]));

export function getStage(id) {
  return STAGE_BY_ID.get(id) || null;
}

export function stageIndex(id) {
  return STAGE_IDS.indexOf(id);
}

/**
 * Statuses that mean "this stage is finished and the pipeline moved past it".
 */
const TERMINAL_OK = new Set([STATUS.PASSED, STATUS.RECOVERED]);

/**
 * Statuses that stop the pipeline dead. The UI uses this to grey out
 * everything downstream instead of pretending later stages are merely pending —
 * a blocked transaction never reaches Razorpay, and the picture should say so.
 */
const HALTING = new Set([STATUS.BLOCKED, STATUS.FAILED]);

export function isTerminalOk(status) {
  return TERMINAL_OK.has(status);
}

export function isHalting(status) {
  return HALTING.has(status);
}

/**
 * Create a fresh, all-PENDING stage map.
 *
 * Each entry carries its own detail payload so a panel never has to reach
 * outside its own stage to render: { status, summary, detail, at }.
 *  - summary: one line, shown on the pipeline rail
 *  - detail:  arbitrary stage-specific object, shown in the expanded panel
 *  - at:      ISO timestamp of the last status change, or null
 */
export function emptyStages() {
  const out = {};
  for (const s of STAGES) {
    out[s.id] = { status: STATUS.PENDING, summary: null, detail: null, at: null };
  }
  return out;
}

/**
 * Mark a stage. Mutates and returns the stage map, so calls can be chained
 * naturally while building a TransactionState.
 */
export function mark(stages, id, status, summary = null, detail = null) {
  if (!stages[id]) return stages;
  stages[id] = {
    status,
    summary,
    detail,
    at: new Date().toISOString()
  };
  return stages;
}

/**
 * Mark every stage strictly before `id` as PASSED, unless it already carries a
 * more specific status. Used when the pipeline is reconstructed from session
 * state rather than observed live — reaching stage N is proof that 1..N-1
 * completed, but we don't want to overwrite a RECOVERED or BLOCKED verdict
 * that was set deliberately.
 */
export function markUpTo(stages, id, summary = null) {
  const target = stageIndex(id);
  if (target < 0) return stages;
  for (let i = 0; i < target; i++) {
    const sid = STAGE_IDS[i];
    if (stages[sid].status === STATUS.PENDING) {
      stages[sid] = { status: STATUS.PASSED, summary, detail: null, at: new Date().toISOString() };
    }
  }
  return stages;
}

/**
 * Where did the pipeline stop, and why? Returns the first halting stage, or
 * null if nothing halted. The global status header reads this.
 */
export function haltedAt(stages) {
  for (const id of STAGE_IDS) {
    if (isHalting(stages[id].status)) {
      return { id, ...stages[id], stage: getStage(id) };
    }
  }
  return null;
}

/**
 * The furthest stage that is not PENDING — i.e. how far this transaction got.
 */
export function reachedStage(stages) {
  let reached = null;
  for (const id of STAGE_IDS) {
    if (stages[id].status !== STATUS.PENDING) reached = id;
  }
  return reached;
}

/**
 * Progress as a fraction, for the header bar. Counts finished stages only —
 * a RUNNING stage is deliberately not counted as done.
 */
export function progress(stages) {
  const done = STAGE_IDS.filter(id => isTerminalOk(stages[id].status)).length;
  return { done, total: STAGE_IDS.length, pct: Math.round((done / STAGE_IDS.length) * 100) };
}
