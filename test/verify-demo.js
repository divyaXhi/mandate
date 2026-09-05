import assert from 'assert';
import { runDemoScenario } from '../src/demo/demoRunner.js';
import { demoHealth } from '../src/demo/demoHealth.js';
import { buildTransactionTimeline } from '../src/observability/transactionTimeline.js';
import { buildCartMandate } from '../src/cartMandate.js';
import { evaluateTransaction } from '../src/decision/transactionEvaluator.js';
import { evaluateApproval } from '../src/approvalGate.js';
import { runPaymentGuard } from '../src/paymentGuard.js';
import { logEvent, getTrail, clearTrails } from '../src/auditLog.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.log(`  ✕ ${name}\n      ${error.message}`); }
}
const context = { buildCartMandate, evaluateTransaction, evaluateApproval, runPaymentGuard, logEvent };
const ids = ['DEMO-HAPPY_PATH', 'DEMO-POLICY_BLOCK'];
clearTrails(ids);

console.log('\nDeterministic demo and observability');
check('health reports every local demo dependency ready', () => {
  const health = demoHealth(Object.fromEntries(['api', 'intent', 'catalog', 'buyerAgent', 'merchantAgent', 'negotiation', 'trust', 'risk', 'policy', 'decision', 'approval', 'paymentGuard', 'security', 'audit'].map(key => [key, true])));
  assert.strictEqual(health.ready, true);
  assert.strictEqual(health.components.length, 14);
});

let happy;
check('Happy Path is deterministic, allowed, approved, and payment-guarded', () => {
  happy = runDemoScenario('happy_path', context);
  assert.strictEqual(happy.decision.finalDecision, 'ALLOW');
  assert.strictEqual(happy.paymentGuard.passed, true);
  assert.strictEqual(happy.paymentAuthorized, true);
  assert.strictEqual(happy.explanation.policy.decision, 'ALLOW');
});

let blocked;
check('Policy Block retains good evidence but refuses the over-limit payment', () => {
  blocked = runDemoScenario('policy_block', context);
  assert.strictEqual(blocked.decision.finalDecision, 'BLOCK');
  assert.strictEqual(blocked.decision.finalReason, 'AMOUNT_EXCEEDS_LIMIT');
  assert.strictEqual(blocked.paymentGuard.passed, false);
  assert.strictEqual(blocked.paymentAuthorized, false);
});

check('timeline and replay inputs are reconstructed only from audit events', () => {
  const events = getTrail(happy.transactionId);
  const timeline = buildTransactionTimeline(happy.transactionId, events);
  assert.ok(timeline.events.some(event => event.event === 'DECISION_EVALUATED'));
  assert.ok(timeline.events.some(event => event.event === 'PAYMENT_GUARD_PASSED'));
  assert.strictEqual(timeline.readOnly, true);
});

check('demo reset scope removes only deterministic demo audit trails', () => {
  assert.ok(clearTrails(ids) > 0);
  assert.strictEqual(getTrail(happy.transactionId).length, 0);
  assert.strictEqual(getTrail(blocked.transactionId).length, 0);
});

console.log(`\n${'─'.repeat(58)}\nDemo verification: ${passed} checks passed${failed ? `, ${failed} failed` : ''}.\n${'─'.repeat(58)}`);
if (failed) process.exitCode = 1;
