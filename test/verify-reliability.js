import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAction, requireCurrency, requireId, requireObject, requirePositiveAmount } from '../src/runtime/validation.js';
import { TransactionStateMachine, TRANSACTION_STATE, InvalidTransactionTransitionError } from '../src/runtime/transactionStateMachine.js';
import { PaymentAttemptLedger, PaymentRecoveryRequiredError } from '../src/runtime/paymentAttemptLedger.js';
import { ERROR_CODE } from '../src/runtime/errorCodes.js';
import { NegotiationEngine } from '../src/negotiationEngine.js';
import { buyerAgentIdentity, merchantAgentIdentity } from '../src/agentIdentity.js';
import { runPaymentGuard } from '../src/paymentGuard.js';
import { parseIntentWithLLM } from '../src/llmIntent.js';
import { searchLiveProducts } from '../src/liveCatalog.js';
import { getFxRate } from '../src/fxRates.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.log(`  ✕ ${name}\n      ${error.message}`); }
}
const mustThrow = (fn, Type = Error) => assert.throws(fn, Type);

function freshDeal() {
  const engine = new NegotiationEngine({ now: () => 1_700_000_000_000 });
  const product = { id: 'p-reliability', name: 'Reliability laptop', merchant: 'Verified merchant', category: 'electronics', price_inr: 75000 };
  const buyer = buyerAgentIdentity({ agentSeed: 'reliability', profile: { name: 'Reliability buyer' } });
  const merchant = merchantAgentIdentity(product.merchant);
  const negotiation = engine.createSession({ transactionId: 'TXN-RELIABILITY', buyerAgent: buyer, merchantAgent: merchant, product, buyerMaxInr: 80000, mandateVersion: 1 });
  engine.createOffer(negotiation.negotiationId, { productId: product.id, basePriceInr: 75000 });
  const deal = engine.acceptOffer(negotiation.negotiationId);
  return { engine, product, merchant, deal, negotiation };
}

console.log('\nReliability and production hardening');
console.log('\nAPI Validation');
await check('rejects missing/malformed identifiers and bodies', () => {
  mustThrow(() => requireId('', 'transactionId'));
  mustThrow(() => requireId(42, 'dealId'));
  mustThrow(() => requireObject([]));
  mustThrow(() => requireObject(null));
});
await check('rejects zero, negative, non-integer amounts and unsupported currency/action', () => {
  for (const amount of [0, -1, 1.5, '100']) mustThrow(() => requirePositiveAmount(amount));
  mustThrow(() => requireCurrency('USD'));
  mustThrow(() => requireAction('PAY_NOW', ['ACCEPT', 'CANCEL']));
});

console.log('\nState Machine');
await check('allows the declared success path only', () => {
  const state = new TransactionStateMachine();
  for (const next of ['INTENT_PARSED', 'NEGOTIATING', 'DEAL_CREATED', 'EVALUATING', 'AWAITING_APPROVAL', 'PAYMENT_READY', 'PAYMENT_PROCESSING', 'SUCCESS']) state.transition(next);
  assert.strictEqual(state.state, TRANSACTION_STATE.SUCCESS);
  assert.strictEqual(state.terminal, true);
});
await check('rejects transitions out of terminal and blocked states', () => {
  const success = new TransactionStateMachine(TRANSACTION_STATE.SUCCESS);
  mustThrow(() => success.transition(TRANSACTION_STATE.PAYMENT_PROCESSING), InvalidTransactionTransitionError);
  const blocked = new TransactionStateMachine(TRANSACTION_STATE.BLOCKED);
  mustThrow(() => blocked.transition(TRANSACTION_STATE.PAYMENT_READY), InvalidTransactionTransitionError);
});

console.log('\nDuplicate Actions and Idempotency');
await check('duplicate accept creates exactly one immutable deal', () => {
  const { engine, deal, negotiation } = freshDeal();
  assert.strictEqual(engine.getDeal(deal.dealId), deal);
  mustThrow(() => engine.acceptOffer(negotiation.negotiationId));
  assert.strictEqual(engine.deals.size, 1);
});
await check('concurrent payment requests collapse to one executor call', async () => {
  const ledger = new PaymentAttemptLedger();
  let calls = 0;
  const execute = async () => { calls++; return { orderId: 'order-one', amountInr: 500, status: 'created' }; };
  const results = await Promise.all([ledger.execute('TXN-CONCURRENT', execute), ledger.execute('TXN-CONCURRENT', execute), ledger.execute('TXN-CONCURRENT', execute)]);
  assert.strictEqual(calls, 1);
  assert.strictEqual(new Set(results.map(result => result.orderId)).size, 1);
});
await check('a completed payment retry returns existing evidence and never creates another payment', async () => {
  const ledger = new PaymentAttemptLedger();
  let calls = 0;
  await ledger.execute('TXN-PAID', async () => { calls++; return { orderId: 'one', amountInr: 100 }; });
  const retry = await ledger.execute('TXN-PAID', async () => { calls++; return { orderId: 'two', amountInr: 100 }; });
  assert.strictEqual(calls, 1);
  assert.strictEqual(retry.recovered, true);
  assert.strictEqual(retry.orderId, 'one');
});

console.log('\nApproval and Payment Guard');
await check('review/approval bypass is refused by the final guard', () => {
  const guard = runPaymentGuard({ cart: { approved: false, pricing: { totalInr: 500 } }, approvedAmountInr: 500, mandate: { maxTransactionInr: 1000, dailyLimitInr: 1000 }, transactionId: 'TXN-REVIEW', decision: { finalDecision: 'REVIEW' } });
  assert.strictEqual(guard.passed, false);
  assert.strictEqual(guard.failedCheckId, 'cart_approved');
});
await check('Payment Guard blocks final deal facts that fail revalidation despite ALLOW', () => {
  const guard = runPaymentGuard({ cart: { approved: true, pricing: { totalInr: 500 } }, approvedAmountInr: 500, mandate: { maxTransactionInr: 1000, dailyLimitInr: 1000 }, transactionId: 'TXN-STALE', railConfigured: true, decision: { finalDecision: 'ALLOW' }, dealValidation: { valid: false, reason: 'DEAL_STALE_OR_CHANGED' } });
  assert.strictEqual(guard.passed, false);
  assert.strictEqual(guard.failedCheckId, 'deal_revalidation');
});

console.log('\nStale Deal and Revalidation');
await check('revalidates transaction, mandate, product, merchant, amount, currency, bundle, and fingerprint', () => {
  const { engine, product, merchant, deal } = freshDeal();
  const valid = engine.revalidateDeal(deal.dealId, { transactionId: deal.transactionId, mandateVersion: 1, buyerMaxInr: 80000, productId: product.id, merchantAgentId: merchant.agentId, finalAmountInr: 75000, currency: 'INR', bundlePriceInr: 0, fingerprint: deal.fingerprint });
  assert.strictEqual(valid.valid, true);
  for (const changed of [
    { transactionId: 'TXN-OTHER' }, { mandateVersion: 2 }, { productId: 'p-other' }, { merchantAgentId: 'M-OTHER' },
    { finalAmountInr: 76000 }, { currency: 'USD' }, { bundlePriceInr: 1 }, { fingerprint: 'MUTATED' }
  ]) {
    const result = engine.revalidateDeal(deal.dealId, { transactionId: deal.transactionId, mandateVersion: 1, buyerMaxInr: 80000, productId: product.id, merchantAgentId: merchant.agentId, finalAmountInr: 75000, currency: 'INR', bundlePriceInr: 0, fingerprint: deal.fingerprint, ...changed });
    assert.strictEqual(result.valid, false, JSON.stringify(changed));
  }
});

console.log('\nNetwork Recovery');
await check('distinguishes safe retry, recovered payment, and uncertain state', async () => {
  const ledger = new PaymentAttemptLedger();
  assert.deepStrictEqual(ledger.recovery('NONE'), { status: 'SAFE_RETRY', paymentExecuted: false });
  await ledger.execute('DONE', async () => ({ orderId: 'done' }));
  assert.strictEqual(ledger.recovery('DONE').status, 'RECOVERED');
  ledger.set('UNCERTAIN', { status: 'uncertain' });
  assert.strictEqual(ledger.recovery('UNCERTAIN').status, 'RECOVERY_REQUIRED');
  assert.throws(() => ledger.execute('UNCERTAIN', async () => ({})), PaymentRecoveryRequiredError);
});

console.log('\nError Contract, Fallbacks, and Server Stability');
await check('server exposes the structured error contract and malformed-JSON handler', () => {
  const source = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
  assert.match(source, /success: false, error: \{ code: stableCode, message, stage, transactionId \}/);
  assert.match(source, /Malformed JSON request body/);
  assert.match(source, /Unknown API endpoint/);
  assert.deepStrictEqual(Object.values(ERROR_CODE), [
    'INVALID_REQUEST', 'INVALID_TRANSACTION_STATE', 'DEAL_INVALID', 'STALE_DEAL', 'MANDATE_LIMIT_EXCEEDED',
    'POLICY_BLOCKED', 'TRUST_BLOCKED', 'RISK_REVIEW', 'APPROVAL_REQUIRED', 'APPROVAL_EXPIRED',
    'PAYMENT_GUARD_BLOCKED', 'DUPLICATE_PAYMENT', 'PAYMENT_RECOVERY_REQUIRED', 'NEGOTIATION_EXPIRED'
  ]);
});
await check('external dependency failure remains safe through existing fallbacks', async () => {
  const oldGemini = process.env.GEMINI_API_KEY;
  const oldRapid = process.env.RAPIDAPI_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.RAPIDAPI_KEY;
  try {
    assert.strictEqual(await parseIntentWithLLM('find a laptop under 80000'), null);
    assert.strictEqual(await searchLiveProducts('laptop', null, 80000), null);
    assert.strictEqual(getFxRate('US').code, 'USD');
  } finally {
    if (oldGemini !== undefined) process.env.GEMINI_API_KEY = oldGemini;
    if (oldRapid !== undefined) process.env.RAPIDAPI_KEY = oldRapid;
  }
});
await check('project contains no credential-shaped secrets outside the placeholder config and external operations have timeouts', () => {
  const scan = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return ['node_modules', '.git', 'public/receipts'].includes(path.relative(root, full)) ? [] : scan(full);
    return /\.(js|html|css|json|md)$/.test(entry.name) && entry.name !== '.env.example' ? [full] : [];
  });
  const projectText = scan(root).map(file => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(projectText, /AIza[0-9A-Za-z_-]{20,}|rzp_(live|test)_[A-Za-z0-9]{12,}/);
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.env$/m);
  assert.match(fs.readFileSync(path.join(root, '.env.example'), 'utf8'), /RAZORPAY_KEY_SECRET=xxxxxxxx/);
  assert.match(fs.readFileSync(path.join(root, 'src/paymentMandate.js'), 'utf8'), /PAYMENT_TIMEOUT_MS/);
  assert.match(fs.readFileSync(path.join(root, 'src/llmIntent.js'), 'utf8'), /fetchWithTimeout/);
  assert.match(fs.readFileSync(path.join(root, 'src/liveCatalog.js'), 'utf8'), /AbortController/);
  assert.match(fs.readFileSync(path.join(root, 'src/fxRates.js'), 'utf8'), /AbortController/);
});

console.log(`\n${'─'.repeat(58)}\nReliability verification: ${passed} checks passed${failed ? `, ${failed} failed` : ''}.\n${'─'.repeat(58)}`);
if (failed) process.exitCode = 1;
