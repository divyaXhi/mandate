import assert from 'assert';
import { generateCorrelationId, getCorrelationId, attachCorrelation } from '../src/observability/correlation.js';
import { createAuditEvent, toStructuredAuditEvent } from '../src/observability/auditEvents.js';
import { buildDecisionProvenance } from '../src/observability/decisionProvenance.js';
import { explainDecision } from '../src/observability/decisionExplanation.js';
import { buildTransactionTrace } from '../src/observability/transactionTrace.js';
import { buildSecurityTrace } from '../src/observability/securityTrace.js';
import { resetMetrics, markTransactionStart, recordAuditEvent, metricsSnapshot } from '../src/observability/metrics.js';
import { logEvent, getTrail, clearTrails } from '../src/auditLog.js';

let passed = 0; let failed = 0;
async function check(name, fn) { try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✕ ${name}\n      ${error.message}`); } }
const tx = 'OBSERVABILITY-TEST-TRACE';
clearTrails([tx]); resetMetrics();

const allow = { finalDecision: 'ALLOW', finalReason: 'ALL_CHECKS_PASSED', trust: { decision: 'ALLOW', score: 94, reasonCodes: ['MERCHANT_VERIFIED'] }, risk: { decision: 'ALLOW', level: 'LOW', score: 18, reasonCodes: ['LOW_RISK'] }, policy: { decision: 'ALLOW', reasonCodes: [] } };
const review = { ...allow, finalDecision: 'REVIEW', finalReason: 'RISK_REVIEW', risk: { decision: 'REVIEW', level: 'HIGH', score: 74, reasonCodes: ['HIGH_RISK'] } };
const block = { ...allow, finalDecision: 'BLOCK', finalReason: 'AMOUNT_EXCEEDS_LIMIT', policy: { decision: 'BLOCK', reasonCodes: ['AMOUNT_EXCEEDS_LIMIT'] } };
const context = { deal: { pricing: { finalAmountInr: 95000 }, fingerprint: 'FPRINT' }, mandate: { maxTransactionInr: 80000 } };

console.log('\nObservability and explainability');
console.log('\nCorrelation and structured audit');
await check('server correlation IDs are unique, stable per transaction, and not caller-supplied', () => {
  assert.notStrictEqual(generateCorrelationId(), generateCorrelationId());
  assert.strictEqual(getCorrelationId(tx), getCorrelationId(tx));
  assert.notStrictEqual(getCorrelationId(tx), getCorrelationId('OBSERVABILITY-OTHER'));
  assert.strictEqual(attachCorrelation({ transactionId: tx, correlationId: 'untrusted' }).correlationId, getCorrelationId(tx));
});
await check('structured events contain mandatory fields, unique IDs, and append without mutation', () => {
  const first = logEvent(tx, 'INTENT_PARSED', { prompt: 'find a laptop' });
  const second = logEvent(tx, 'PRODUCT_SELECTED', { productId: 'demo-laptop' });
  for (const event of [first, second]) for (const field of ['eventId', 'transactionId', 'correlationId', 'timestamp', 'stage', 'event']) assert.ok(event[field], field);
  assert.notStrictEqual(first.eventId, second.eventId);
  const before = getTrail(tx); logEvent(tx, 'DECISION_EVALUATED', { finalDecision: 'ALLOW', reasonCodes: ['ALL_CHECKS_PASSED'] });
  assert.strictEqual(getTrail(tx).slice(0, before.length).map(event => event.eventId).join(','), before.map(event => event.eventId).join(','));
});
await check('structured audit ordering and legacy adaptation remain readable', () => {
  const events = getTrail(tx); assert.ok(events[0].timestamp <= events[1].timestamp);
  const legacy = toStructuredAuditEvent({ transactionId: 'legacy', step: 'payment_guard_blocked', details: {} });
  assert.strictEqual(legacy.stage, 'PAYMENT_GUARD');
});

console.log('\nDecision provenance and WHY');
await check('ALLOW, REVIEW, and BLOCK provenance record the actual authority', () => {
  assert.strictEqual(buildDecisionProvenance(allow, context).authority.layer, 'DECISION_ENGINE');
  assert.strictEqual(buildDecisionProvenance(review, context).authority.layer, 'RISK');
  const provenance = buildDecisionProvenance(block, context);
  assert.deepStrictEqual(provenance.authority, { layer: 'POLICY', rule: 'MAX_TRANSACTION_LIMIT' });
  assert.ok(provenance.reasonCodes.includes('AMOUNT_EXCEEDS_LIMIT'));
});
await check('WHY is deterministic structured evidence and cannot alter authorization', () => {
  const first = explainDecision(block, context); const second = explainDecision(block, context);
  assert.deepStrictEqual(first, second);
  assert.strictEqual(first.finalDecision, 'BLOCK');
  assert.strictEqual(first.authority.layer, 'POLICY');
  assert.ok(first.evidence.includes('Final deal: ₹95,000'));
  assert.strictEqual(block.finalDecision, 'BLOCK');
});

console.log('\nTrace and security evidence');
await check('transaction trace is ordered, read-only, correlation-bound, and reconstructed from audit', () => {
  const trace = buildTransactionTrace(tx, getTrail(tx));
  assert.strictEqual(trace.readOnly, true); assert.strictEqual(trace.correlationId, getCorrelationId(tx));
  assert.deepStrictEqual(trace.timeline.map(event => event.sequence), [1, 2, 3]);
  assert.ok(trace.timeline.every(event => event.eventId && event.stage));
});
await check('security attack lifecycle is represented in the normal trace', () => {
  const securityTx = 'OBSERVABILITY-SECURITY'; clearTrails([securityTx]);
  logEvent(securityTx, 'ATTACK_STARTED', { attackId: 'prompt_injection' });
  logEvent(securityTx, 'ATTACK_DETECTED', { detectionLayer: 'Input security' });
  logEvent(securityTx, 'SECURITY_DECISION', { finalDecision: 'BLOCK' });
  logEvent(securityTx, 'ATTACK_RESOLVED', { recoveryAction: 'Payment not executed' });
  const trace = buildSecurityTrace(securityTx, getTrail(securityTx));
  assert.deepStrictEqual(trace.timeline.map(event => event.event), ['ATTACK_STARTED', 'ATTACK_DETECTED', 'SECURITY_DECISION', 'ATTACK_RESOLVED']);
  assert.ok(trace.timeline.every(event => event.stage === 'SECURITY'));
  clearTrails([securityTx]);
});

console.log('\nMetrics');
await check('metrics count evidence without changing authorization', () => {
  resetMetrics(); markTransactionStart('OBSERVABILITY-METRIC');
  recordAuditEvent(createAuditEvent('OBSERVABILITY-METRIC', 'NEGOTIATION_STARTED'));
  recordAuditEvent(createAuditEvent('OBSERVABILITY-METRIC', 'FINAL_DEAL_CREATED'));
  recordAuditEvent(createAuditEvent('OBSERVABILITY-METRIC', 'DECISION_EVALUATED', { finalDecision: 'BLOCK' }));
  recordAuditEvent(createAuditEvent('OBSERVABILITY-METRIC', 'PAYMENT_GUARD_BLOCKED'));
  recordAuditEvent(createAuditEvent('OBSERVABILITY-METRIC', 'ATTACK_STARTED'));
  recordAuditEvent(createAuditEvent('OBSERVABILITY-METRIC', 'ATTACK_RESOLVED'));
  const metrics = metricsSnapshot();
  assert.strictEqual(metrics.transactionsStarted, 1); assert.strictEqual(metrics.decisions.block, 1);
  assert.strictEqual(metrics.payments.blocked, 1); assert.strictEqual(metrics.security.attacksRun, 1); assert.strictEqual(metrics.security.attacksBlocked, 1);
  assert.strictEqual(block.finalDecision, 'BLOCK');
});
await check('latency is observational and only records measured elapsed values', () => {
  resetMetrics(); markTransactionStart('OBSERVABILITY-LATENCY'); recordAuditEvent(createAuditEvent('OBSERVABILITY-LATENCY', 'DECISION_EVALUATED', { finalDecision: 'ALLOW' }));
  const latency = metricsSnapshot().latencyMs; assert.ok(latency.decisionMs?.last >= 0);
});

clearTrails([tx]);
console.log(`\n${'─'.repeat(58)}\nObservability verification: ${passed} checks passed${failed ? `, ${failed} failed` : ''}.\n${'─'.repeat(58)}`);
if (failed) process.exitCode = 1;
