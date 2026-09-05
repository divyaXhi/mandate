import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseIntent, searchCatalog } from '../src/agent.js';
import { classifyConversation, stateForStage } from '../src/conversationIntent.js';

let passed = 0; let failed = 0;
function check(name, fn) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✕ ${name}\n      ${error.message}`); } }
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const server = read('src/server.js'), app = read('public/app.js'), html = read('public/index.html');
const pkg = JSON.parse(read('package.json'));

console.log('\nConversation orchestration');
check('greetings are routed before catalog search', () => {
  assert.equal(classifyConversation('hii'), 'GREETING'); assert.equal(classifyConversation('hello!'), 'GREETING');
  assert.equal(parseIntent('hii').category, null); assert.ok(server.includes("conversationIntent === 'GREETING'"));
});
check('Hinglish laptop request becomes a bounded structured catalog intent', () => {
  const intent = parseIntent('bhai 45k ke andar non gaming laptop chahiye with laptop bag');
  assert.equal(intent.category, 'laptop'); assert.equal(intent.query, 'laptop'); assert.equal(intent.budget, 45000);
  assert.deepEqual(intent.constraints, ['non-gaming']); assert.deepEqual(intent.accessories, ['laptop bag']);
  const products = searchCatalog(intent); assert.ok(products.length >= 2); assert.ok(products.every(p => !(p.tags || []).includes('gaming')));
});
check('unknown wording asks for a product category instead of hallucinating a listing', () => {
  assert.equal(parseIntent('get me something good').category, null); assert.ok(server.includes("I'm not sure what product to search for yet"));
});
check('short contextual refinements are state-routed', () => {
  assert.equal(classifyConversation('something lighter'), 'REFINE_SEARCH'); assert.ok(server.includes("conversationIntent === 'REFINE_SEARCH'"));
  assert.equal(stateForStage('awaiting_approval'), 'APPROVAL'); assert.equal(stateForStage('awaiting_payment_method'), 'PAYMENT_METHOD');
});
check('daily-limit changes require expiring single-use OTP proofs and rate-limit failed attempts', () => {
  for (const fragment of ['pendingMandateChange', 'otpHash', 'otpSalt', 'expiresAt', 'change.attempts >= 5', 'matchesOtp(change, attempt)', 'updateMandate(session, change.changes']) assert.ok(server.includes(fragment), fragment);
  assert.ok(!server.includes('updateMandate(session, mandateEdit.changes'));
});
check('order creation cannot advance with missing self-recipient delivery details', () => {
  assert.ok(server.includes('!session.profile.phone || !session.profile.address')); assert.ok(server.includes('Before checkout, I need delivery details'));
});
check('Home renders a backend-driven pinned mandate and explicit edit action', () => {
  assert.ok(html.includes('Message Mandate...')); assert.ok(app.includes('📌 PURCHASE MANDATE'));
  assert.ok(app.includes('Daily limit ${inr(m.dailyLimitInr)}')); assert.ok(app.includes('data-commerce="edit-mandate"'));
});
check('agent contact sheet retains the PayMandate authority boundary', () => {
  assert.ok(app.includes('AI shopping agent protected by PayMandate')); assert.ok(app.includes('never authorize or execute it'));
});
check('conversation checks are included in the release regression command', () => {
  assert.equal(pkg.version, '1.0.0'); assert.ok(pkg.scripts.test.includes('check:conversation'));
});
console.log(`\n${'─'.repeat(58)}\nConversation verification: ${passed} checks passed${failed ? `, ${failed} failed` : ''}.\n${'─'.repeat(58)}`);
if (failed) process.exitCode = 1;
