export const DEMO_SCENARIOS = Object.freeze({
  happy_path: {
    id: 'happy_path', name: 'Happy Path', prompt: 'Find me a laptop under ₹80,000.',
    product: { id: 'demo-laptop-allow', name: 'Demo Laptop Pro', merchant: 'TechStore', category: 'electronics', price_inr: 79000, origin_country: 'IN', merchant_tenure_days: 1200, gst_verified: true },
    buyerMaxInr: 80000, negotiatedPriceInr: 78000,
    mandate: { maxTransactionInr: 80000, dailyLimitInr: 100000, autonomousSpendThresholdInr: 100000, blockedCategories: ['gambling', 'financial'], allowedCategories: [], allowCrossBorder: true }
  },
  policy_block: {
    id: 'policy_block', name: 'Policy Block', prompt: 'Find me a premium laptop.',
    product: { id: 'demo-laptop-block', name: 'Premium Demo Laptop', merchant: 'TechStore', category: 'electronics', price_inr: 95000, origin_country: 'IN', merchant_tenure_days: 1200, gst_verified: true },
    buyerMaxInr: 95000, negotiatedPriceInr: 95000,
    mandate: { maxTransactionInr: 80000, dailyLimitInr: 150000, autonomousSpendThresholdInr: 100000, blockedCategories: ['gambling', 'financial'], allowedCategories: [], allowCrossBorder: true }
  }
});

export const demoScenarioById = id => DEMO_SCENARIOS[id] || null;
