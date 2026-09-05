const state = { transactionsStarted: 0, transactionsCompleted: 0, decisions: { allow: 0, review: 0, block: 0 }, payments: { attempted: 0, succeeded: 0, blocked: 0, recovered: 0, duplicatePrevented: 0 }, negotiations: { started: 0, completed: 0, expired: 0 }, security: { attacksRun: 0, attacksBlocked: 0 }, latencyMs: {} };
const startedAt = new Map();

export function resetMetrics() {
  state.transactionsStarted = 0; state.transactionsCompleted = 0;
  state.decisions = { allow: 0, review: 0, block: 0 };
  state.payments = { attempted: 0, succeeded: 0, blocked: 0, recovered: 0, duplicatePrevented: 0 };
  state.negotiations = { started: 0, completed: 0, expired: 0 };
  state.security = { attacksRun: 0, attacksBlocked: 0 }; state.latencyMs = {}; startedAt.clear();
}
export function markTransactionStart(transactionId) { state.transactionsStarted++; startedAt.set(transactionId, Date.now()); }
const latencyKey = stage => ({ INTENT: 'intentMs', DISCOVERY: 'discoveryMs', NEGOTIATION: 'negotiationMs', TRUST: 'trustMs', RISK: 'riskMs', POLICY: 'policyMs', DECISION: 'decisionMs', APPROVAL: 'approvalMs', PAYMENT_GUARD: 'paymentGuardMs', PAYMENT: 'paymentMs' }[stage] || null);
export function recordLatency(transactionId, stage, explicitKey = null) {
  const started = startedAt.get(transactionId); if (!started) return;
  const key = explicitKey || latencyKey(stage); if (!key) return;
  const value = Date.now() - started; const prior = state.latencyMs[key] || { count: 0, total: 0, last: null };
  state.latencyMs[key] = { count: prior.count + 1, total: prior.total + value, last: value, average: Math.round((prior.total + value) / (prior.count + 1)) };
}
export function recordAuditEvent(event) {
  const name = event.event;
  if (name === 'NEGOTIATION_STARTED') state.negotiations.started++;
  if (name === 'FINAL_DEAL_CREATED') state.negotiations.completed++;
  if (name === 'NEGOTIATION_EXPIRED') state.negotiations.expired++;
  if (name === 'DECISION_EVALUATED') { const d = String(event.decision || '').toLowerCase(); if (d in state.decisions) state.decisions[d]++; }
  if (/PAYMENT_ATTEMPTED|RAZORPAY_ORDER_CREATED|PAYMENT_EXECUTED/.test(name)) state.payments.attempted++;
  if (/PAYMENT_CAPTURED|PAYMENT_EXECUTED|COD_CONFIRMED/.test(name)) state.payments.succeeded++;
  if (/PAYMENT_GUARD_BLOCKED|PAYMENT_BLOCKED/.test(name)) state.payments.blocked++;
  if (/RECOVERED/.test(name)) state.payments.recovered++;
  if (/DUPLICATE/.test(name)) state.payments.duplicatePrevented++;
  if (name === 'ATTACK_STARTED') state.security.attacksRun++;
  if (name === 'ATTACK_RESOLVED') state.security.attacksBlocked++;
  if (/PAYMENT_CAPTURED|PAYMENT_EXECUTED|COD_CONFIRMED/.test(name)) { state.transactionsCompleted++; recordLatency(event.transactionId, event.stage, 'totalMs'); startedAt.delete(event.transactionId); }
  recordLatency(event.transactionId, event.stage);
}
export function metricsSnapshot() { return JSON.parse(JSON.stringify(state)); }
