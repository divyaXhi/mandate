import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseIntent } from '../src/agent.js';
import { classifyConversation } from '../src/conversationIntent.js';

let passed = 0; let failed = 0;
function check(name, fn) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✕ ${name}\n      ${error.message}`); } }
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const server = read('src/server.js'), html = read('public/index.html'), app = read('public/app.js'), control = read('public/control.js'), auditExport = read('src/auditExport.js'), receipt = read('src/receipt.js'), pkg = JSON.parse(read('package.json'));

console.log('\nCustomer experience and shopping');
check('fresh Home has no seeded demo, greeting, or example shopping conversation', () => {
  assert.ok(!html.includes('heroScreen')); assert.ok(!html.includes('id="startDemoBtn"'));
  assert.ok(!html.includes('What are you looking for today?')); assert.ok(html.includes('id="chatScroll" aria-live="polite"></div>'));
});
check('guided demos and their controls are absent from the product UI', () => {
  for (const fragment of ['autoDemoBtn', 'autoDemoRunning', 'Guided demo', 'Guided chat demo', 'comparisonStrip', 'demoControls', 'resetDemoBtn', 'demoHealthStatus', 'demoResult']) {
    assert.ok(!(html + app).includes(fragment), fragment);
  }
});
check('the intent layer recognizes new catalog categories without inventing product facts', () => {
  const dryer = parseIntent('hair dryer under 1500'); const chair = parseIntent('office chair below 8000'); const phone = parseIntent('smartphone under 20000');
  assert.equal(dryer.category, 'hair dryer'); assert.equal(dryer.budget, 1500);
  assert.equal(chair.category, 'office chair'); assert.equal(chair.budget, 8000);
  assert.equal(phone.category, 'smartphone'); assert.equal(phone.budget, 20000);
});
check('refinement language and ordinal product selection are explicitly recognized', () => {
  for (const value of ['show cheaper ones', 'show another one', 'under 40000 instead', 'make it cheaper']) assert.equal(classifyConversation(value), 'REFINE_SEARCH');
  assert.equal(classifyConversation('second one'), 'PRODUCT_SELECTION');
  assert.ok(server.includes('ordinalMatch')); assert.ok(server.includes('refinement.budget ?? session.lastIntent.budget'));
  assert.ok(server.indexOf('awaitingProductChoice') < server.indexOf('if (session.awaitingBudgetRangeFor)'));
});
check('a selected card is re-evaluated with its actual budget and copied titles remain selectable', () => {
  assert.ok(server.includes('buyerBudgetInr: intent.budget'));
  assert.ok(server.includes('dealContext.buyerBudgetInr'));
  assert.ok(server.includes('normaliseProductText'));
});
check('catalog misses are transparent and never fabricated', () => {
  assert.ok(server.includes('I won’t invent a product or price'));
});
check('negotiation remains reachable with normal customer language', () => {
  assert.ok(server.includes('Want me to negotiate with the seller?'));
  assert.ok(app.includes("{ label: 'Negotiate', value: 'yes' }"));
  assert.ok(app.includes("{ label: 'Counter', value: 'counter' }"));
  assert.ok(app.includes("{ label: 'Decline', value: 'no' }"));
});
check('normal chat hides engine terms while retaining backend decision paths', () => {
  assert.ok(!server.includes('sorted by confidence — highest first'));
  assert.ok(!server.includes('Merchant Agent: "${proposal.message}"'));
  assert.ok(app.includes('function answerWhyInChat'));
  assert.ok(!app.includes("window.MandateControl?.selectStage('decision');"));
  assert.ok(html.includes('razorpay-avatar'));
  assert.ok(html.includes('assets/razorpay-payment-mark.png'));
  assert.ok(app.includes('function purchaseJourneyMarkup'));
  assert.ok(app.includes('SELLER NEGOTIATION'));
  assert.ok(app.includes('const wait = ms'));
  assert.ok(app.includes("paymandate.local-session.v1"), 'a browser reload must retain the payment session');
});
check('order summary and profile use backend mandate facts', () => {
  assert.ok(server.includes('Daily purchase limit:')); assert.ok(server.includes('Remaining today:'));
  assert.ok(app.includes('Your purchase authority')); assert.ok(app.includes('Daily maximum: ${inr(m.dailyLimitInr)}'));
});
check('address edits use the pin-drop delivery picker with pincode and browser location support', () => {
  assert.ok(server.includes("stage: 'editing_address_map'"));
  assert.ok(server.includes('handleEditDetails(session, message, addressPayload)'));
  for (const fragment of ['editing_address_map', 'useMyLocationBtn', 'navigator.geolocation', '6-digit pincode']) assert.ok((html + app).includes(fragment), fragment);
});
check('receipt and audit evidence exports are safe', () => {
  for (const fragment of ['/api/audit/:transactionId.json', '/api/audit/:transactionId.pdf', 'generateAuditPdf', 'publicAuditTrail']) assert.ok(server.includes(fragment), fragment);
  for (const fragment of ['SENSITIVE', '[redacted]', 'PayMandate Audit Report']) assert.ok(auditExport.includes(fragment), fragment);
  for (const fragment of ['Final status:', 'Download audit PDF', 'Track delivery', 'Return / refund order', 'paymentFailureHandled']) assert.ok((receipt + app).includes(fragment), fragment);
  assert.ok(!app.includes('Download audit JSON'));
  assert.ok(server.includes("app.get('/track/:transactionId'"));
  assert.ok(server.includes("session.transactions?.at(-1)"), 'Inspect must retain completed evidence after payment');
});
check('technical explanation remains in the five-section Inspect shell', () => {
  for (const label of ['🧭 TRANSACTION', '🛡 AUTHORIZATION', '💳 PAYMENT', '📜 AUDIT', '🔐 SECURITY']) assert.ok(html.includes(label), label);
  assert.ok(html.includes('PAYMANDATE INSPECT')); assert.ok(app.includes('function openInspect'));
  assert.ok(html.includes('Security levels on every purchase'));
  assert.ok(!html.includes('Why prompt injection is the <em>secondary</em> defence'));
  assert.ok(html.includes('id="securityTransaction"'));
  assert.ok(html.includes('id="modeExplainer"'));
  assert.ok(!html.includes('nav-tab-name">CHAT'));
  assert.ok(control.includes('function renderSecurityTransaction'));
  assert.ok(control.includes('function renderAuthorizationSurface'));
  assert.ok(html.includes('Live Security'));
  assert.ok(html.includes('Test duplicate-payment block'));
});
check('experience checks are included in the full regression command', () => {
  assert.equal(pkg.version, '1.0.0'); assert.ok(pkg.scripts.test.includes('check:experience'));
});
console.log(`\n${'─'.repeat(58)}\nExperience verification: ${passed} checks passed${failed ? `, ${failed} failed` : ''}.\n${'─'.repeat(58)}`);
if (failed) process.exitCode = 1;
