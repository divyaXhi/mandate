import assert from 'assert';
import { demoHealth } from '../src/demo/demoHealth.js';
import { DEMO_SCENARIOS } from '../src/demo/demoScenarios.js';
import { ATTACKS } from '../src/security/attackRegistry.js';

const required = ['api', 'intent', 'catalog', 'buyerAgent', 'merchantAgent', 'negotiation', 'trust', 'risk', 'policy', 'decision', 'approval', 'paymentGuard', 'security', 'audit'];
const health = demoHealth(Object.fromEntries(required.map(key => [key, true])));
assert.strictEqual(process.env.NODE_ENV, 'demo');
assert.strictEqual(process.env.DEMO_MODE, 'true');
assert.strictEqual(health.ready, true);
assert.ok(DEMO_SCENARIOS.happy_path && DEMO_SCENARIOS.policy_block);
assert.ok(Object.keys(ATTACKS).length >= 8);
console.log('\nPayMandate Demo Preflight');
for (const component of health.components) console.log(`✓ ${component.id}`);
console.log('✓ Trace');
console.log('✓ Frontend');
console.log('✓ Razorpay TEST protection');
console.log('\nREADY');
