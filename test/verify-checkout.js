import assert from 'node:assert/strict';
import fs from 'node:fs';

let passed = 0; let failed = 0;
function check(name, fn) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✕ ${name}\n      ${error.message}`); } }
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const server = read('src/server.js'), app = read('public/app.js'), receipt = read('src/receipt.js'), pkg = JSON.parse(read('package.json'));

console.log('\nCheckout hardening');
check('OTP values are salted and hashed before session storage', () => {
  for (const fragment of ['crypto.randomInt', 'crypto.randomBytes', 'timingSafeEqual', 'otpHash', 'otpSalt']) assert.ok(server.includes(fragment), fragment);
  assert.ok(!server.includes('pendingMandateChange = { changes: requested.changes, reason: requested.reason, otp,'));
  assert.ok(!server.includes("{ attempted: attempt }"));
});
check('OTP expiry, reuse prevention, and attempt limits are enforced', () => {
  for (const fragment of ['Date.now() > change.expiresAt', 'session.pendingMandateChange = null', 'change.attempts >= 5', 'Date.now() > pending.otpExpiresAt', 'pending.otpAttempts >= 5']) assert.ok(server.includes(fragment), fragment);
});
check('COD has a distinct confirmation and checkout details are revalidated at execution', () => {
  for (const fragment of ['awaitingCodConfirmation', 'handleCodConfirmation', 'hasValidCheckoutDetails', 'Checkout is incomplete']) assert.ok(server.includes(fragment), fragment);
  assert.ok(app.includes('Yes, place order'));
});
check('Razorpay failure returns to a safe choice without claiming a duplicate order', () => {
  assert.ok(app.includes("No duplicate payment was created"));
  assert.ok(app.includes("/api/payment/cancelled"));
  assert.ok(server.includes("awaitingPaymentMethod = true"));
});
check('normal conversation avoids raw decision-engine labels', () => {
  assert.ok(server.includes('within your purchase authority')); assert.ok(server.includes('No payment was started'));
});
check('receipt remains a factual TEST-mode artifact', () => {
  for (const fragment of ['Order ID:', 'Transaction ID:', 'Payment method:', 'Sold by:', 'Razorpay test-mode']) assert.ok(receipt.includes(fragment), fragment);
});
check('checkout checks remain included in the complete regression command', () => {
  assert.equal(pkg.version, '1.0.0'); assert.ok(pkg.scripts.test.includes('check:checkout'));
});
console.log(`\n${'─'.repeat(58)}\nCheckout verification: ${passed} checks passed${failed ? `, ${failed} failed` : ''}.\n${'─'.repeat(58)}`);
if (failed) process.exitCode = 1;
