import { runPurchase } from './index.js';
import { printTrail } from './viewTrail.js';

async function main() {
  console.log('\n=== DEMO 1: Domestic purchase (should auto-proceed) ===');
  const r1 = await runPurchase('buy me a phone case under 500', { buyerCountry: 'IN' });
  printTrail(r1.transactionId);

  console.log('\n=== DEMO 2: Cross-border purchase, verification clean ===');
  const r2 = await runPurchase('buy me a mug set under 3000', { buyerCountry: 'IN' });
  printTrail(r2.transactionId);

  console.log('\n=== DEMO 3: Cross-border purchase, verification FAILS (triggers pause) ===');
  const r3 = await runPurchase('buy me a keyboard under 10000', {
    buyerCountry: 'IN',
    simulateVerificationFail: true
  });
  printTrail(r3.transactionId);
}

main().catch(console.error);
