import assert from 'assert';
import { evaluateTransaction } from '../src/decision/transactionEvaluator.js';
import { evaluateApproval, APPROVAL } from '../src/approvalGate.js';
import { runPaymentGuard } from '../src/paymentGuard.js';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✕ ${name}\n      ${error.message}`);
  }
}

const benignMandate = {
  maxTransactionInr: 10000,
  dailyLimitInr: 100000,
  autonomousSpendThresholdInr: 2000,
  blockedCategories: ['gambling'],
  allowedCategories: [],
  allowCrossBorder: true
};

function evaluate({ trust = {}, risk = {}, policy = {} } = {}) {
  return evaluateTransaction({
    trustInput: {
      crossBorder: false, verificationMatch: true, amountRatio: 0.1,
      knownMerchant: true, merchantTenureDays: 365, gstVerified: true,
      category: 'groceries', recentPurchaseCount: 0, ...trust
    },
    riskInput: {
      amountInr: 500, mandate: benignMandate, dailySpentInr: 0,
      merchantTenureDays: 365, gstVerified: true, isCrossBorder: false,
      recentPurchaseCount: 0, injectionDetected: false, category: 'groceries', ...risk
    },
    policyInput: {
      amountInr: 500, category: 'groceries', isCrossBorder: false,
      mandate: benignMandate, dailySpentInr: 0, ...policy
    }
  });
}

console.log('\nCanonical decision engine');

check('allows a benign transaction when every deterministic check passes', () => {
  const decision = evaluate();
  assert.strictEqual(decision.trust.canonicalDecision, 'PASS');
  assert.strictEqual(decision.risk.canonicalDecision, 'PASS');
  assert.strictEqual(decision.policy.canonicalDecision, 'ALLOW');
  assert.strictEqual(decision.finalDecision, 'ALLOW');
});

check('blocks when counterparty trust is too low', () => {
  const decision = evaluate({
    trust: {
      crossBorder: true, verificationMatch: false, amountRatio: 0.99,
      knownMerchant: false, merchantTenureDays: 1, gstVerified: false,
      category: 'electronics', recentPurchaseCount: 4
    }
  });
  assert.strictEqual(decision.trust.canonicalDecision, 'BLOCK');
  assert.strictEqual(decision.finalDecision, 'BLOCK');
  assert.strictEqual(decision.finalReason, 'TRUST_TOO_LOW');
});

check('requires review for a high-risk transaction without inventing a policy block', () => {
  const decision = evaluate({
    risk: {
      amountInr: 9500, dailySpentInr: 85000, merchantTenureDays: 1,
      gstVerified: false, isCrossBorder: true, recentPurchaseCount: 4,
      injectionDetected: true, category: 'electronics'
    }
  });
  assert.strictEqual(decision.risk.canonicalDecision, 'REVIEW');
  assert.strictEqual(decision.policy.canonicalDecision, 'ALLOW');
  assert.strictEqual(decision.finalDecision, 'REVIEW');
  assert.strictEqual(decision.finalReason, 'RISK_REVIEW_REQUIRED');
});

check('policy blocks even when Trust passes and Risk is low', () => {
  const mandate = { ...benignMandate, maxTransactionInr: 8000, autonomousSpendThresholdInr: 10000 };
  const decision = evaluate({
    risk: { amountInr: 9000, mandate },
    policy: { amountInr: 9000, mandate }
  });
  assert.strictEqual(decision.trust.canonicalDecision, 'PASS');
  assert.strictEqual(decision.risk.canonicalDecision, 'PASS');
  assert.strictEqual(decision.policy.canonicalDecision, 'BLOCK');
  assert.strictEqual(decision.finalDecision, 'BLOCK');
  assert.strictEqual(decision.finalReason, 'AMOUNT_EXCEEDS_LIMIT');
});

check('policy remains the reason for a block when every engine raises concerns', () => {
  const mandate = { ...benignMandate, maxTransactionInr: 8000, allowCrossBorder: false };
  const decision = evaluate({
    trust: { crossBorder: true, verificationMatch: false, knownMerchant: false, merchantTenureDays: 1, gstVerified: false, recentPurchaseCount: 4 },
    risk: { amountInr: 9000, mandate, dailySpentInr: 99000, merchantTenureDays: 1, gstVerified: false, isCrossBorder: true, recentPurchaseCount: 4, injectionDetected: true, category: 'electronics' },
    policy: { amountInr: 9000, mandate, isCrossBorder: true }
  });
  assert.strictEqual(decision.finalDecision, 'BLOCK');
  assert.strictEqual(decision.reason, 'AMOUNT_EXCEEDS_LIMIT');
});

check('approval gate honors a canonical blocked decision as a final safety fallback', () => {
  const decision = evaluate({ policy: { amountInr: 15000 } });
  const approval = evaluateApproval({ amountInr: 15000, mandate: benignMandate, decision });
  assert.strictEqual(decision.finalDecision, 'BLOCK');
  assert.strictEqual(approval.mode, APPROVAL.BLOCKED);
  assert.strictEqual(approval.allowed, false);
});

check('Payment Guard rejects a canonical BLOCK before any payment rail check can pass', () => {
  const decision = evaluate({ policy: { amountInr: 15000 } });
  const guard = runPaymentGuard({
    cart: { approved: true, pricing: { totalInr: 15000 } },
    approvedAmountInr: 15000, mandate: benignMandate, transactionId: 'MDT-blocked',
    paymentMethod: 'online', railConfigured: true, decision
  });
  assert.strictEqual(guard.passed, false);
  assert.strictEqual(guard.failedCheckId, 'canonical_decision');
});

console.log(`\n${'─'.repeat(58)}\nDecision verification: ${passed} checks passed${failed ? `, ${failed} failed` : ''}.\n${'─'.repeat(58)}`);
if (failed) process.exitCode = 1;
