import assert from 'assert';
import fs from 'fs';
import { ATTACKS } from '../src/security/attackRegistry.js';
import { runRegisteredAttack } from '../src/security/attackRunner.js';
import { recordAttackAudit } from '../src/security/attackResults.js';
import { loadCatalog } from '../src/agent.js';
import { buildCartMandate } from '../src/cartMandate.js';
import { detectPromptInjection } from '../src/security.js';
import { evaluateTransaction } from '../src/decision/transactionEvaluator.js';
import { runPaymentGuard } from '../src/paymentGuard.js';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.log(`  ✕ ${name}\n      ${error.message}`); }
}

const session = {
  mandate: {
    maxTransactionInr: 10000, dailyLimitInr: 20000,
    autonomousSpendThresholdInr: 2000, blockedCategories: ['gambling'],
    allowedCategories: [], allowCrossBorder: true
  },
  transactions: []
};
const attempts = new Map();
const context = {
  session, loadCatalog, buildCartMandate, detectPromptInjection, evaluateTransaction,
  runPaymentGuard, buyCountry: 'IN', dailySpentInr: 0,
  // Mirrors the production idempotency write-before-attempt behavior without
  // calling a real rail in a deterministic verification test.
  executePaymentIdempotent: async (_cart, _amountInr, transactionId) => {
    attempts.set(transactionId, { status: 'pending' });
    throw new Error('simulated response loss');
  },
  getPaymentAttempt: (transactionId) => attempts.get(transactionId) || null
};

const EXPECTED = {
  prompt_injection: { layer: 'Input security + Risk', reason: 'PROMPT_INJECTION_DETECTED', decision: 'NEUTRALIZED', status: 'NEUTRALIZED' },
  price_manipulation: { layer: 'Payment Guard', reason: 'PRICE_INTEGRITY', decision: 'BLOCK', status: 'BLOCKED' },
  mandate_violation: { layer: 'Policy + Payment Guard', reason: 'AMOUNT_EXCEEDS_LIMIT', decision: 'BLOCK', status: 'BLOCKED' },
  fake_merchant: { layer: 'Trust Engine', decision: 'BLOCK', status: 'BLOCKED' },
  duplicate_payment: { layer: 'Payment Guard', reason: 'IDEMPOTENCY', decision: 'BLOCK', status: 'BLOCKED' },
  stale_deal: { layer: 'Deal Revalidation', reason: 'STALE_DEAL', decision: 'BLOCK', status: 'BLOCKED' },
  agent_permission_violation: { layer: 'Agent permissions', reason: 'AGENT_ACTION_DENIED', decision: 'BLOCK', status: 'BLOCKED' },
  network_failure: { layer: 'Idempotency ledger', reason: 'VERIFY_BEFORE_RETRY', decision: 'RECOVERED', status: 'RECOVERED' }
};

console.log('\nSecurity Lab');
for (const attack of Object.values(ATTACKS)) {
  await check(`${attack.name} reaches its real defense and records a normalized result`, async () => {
    const result = await runRegisteredAttack(attack, context);
    assert.strictEqual(result.attackId, attack.id);
    const expected = EXPECTED[attack.id];
    assert.strictEqual(result.detectionLayer, expected.layer);
    assert.strictEqual(result.decision, expected.decision);
    assert.strictEqual(result.status, expected.status);
    assert.ok(result.detectionReason.includes(expected.reason || ''), `expected reason ${expected.reason}, got ${result.detectionReason}`);
    assert.ok(result.blocked || result.decision === 'NEUTRALIZED' || result.decision === 'RECOVERED', 'attack must block, neutralize, or take a verified recovery path');
    assert.strictEqual(result.duplicatePaymentExecuted, false, 'a security scenario must never execute a duplicate payment');
    assert.ok(result.defenseChain.length >= 5, 'result must explain the defense chain');
    assert.match(result.defenseChain.at(-2), /Payment boundary/);
    const audit = [];
    recordAttackAudit(result, (...args) => audit.push(args));
    assert.deepStrictEqual(audit.map(entry => entry[1]), ['ATTACK_STARTED', 'ATTACK_DETECTED', 'SECURITY_DECISION', result.auditEvent]);
    if (attack.id === 'agent_permission_violation') assert.strictEqual(result.evidence.unauthorizedActionAllowed, false, 'unauthorized merchant action must be denied');
    if (attack.id === 'stale_deal') assert.strictEqual(result.evidence.staleDealValid, false, 'stale deal must not validate');
    if (attack.id === 'mandate_violation') assert.strictEqual(result.evidence.policyAllowed, false, 'policy violation must not be allowed');
    if (attack.id === 'stale_deal' || attack.id === 'mandate_violation') assert.strictEqual(result.paymentAttempted, false, 'blocked deal/policy must not reach payment');
  });
}

await check('server has one active Security Lab attack implementation', () => {
  const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  for (const retired of ['attackPromptInjection', 'attackPriceManipulation', 'attackMandateViolation', 'attackFakeMerchant', 'attackNetworkFailure', 'attackAgentPermissionViolation']) {
    assert.strictEqual(source.includes(retired), false, `${retired} must not remain in server.js`);
  }
});

console.log(`\n${'─'.repeat(58)}\nSecurity verification: ${passed} checks passed${failed ? `, ${failed} failed` : ''}.\n${'─'.repeat(58)}`);
if (failed) process.exitCode = 1;
