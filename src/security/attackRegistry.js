/** The complete, centrally declared Security Lab catalogue. */
export const ATTACKS = Object.freeze({
  PROMPT_INJECTION: { id: 'prompt_injection', name: 'Prompt Injection', targetLayer: 'Input security', expectedDefense: 'PROMPT_INJECTION_DETECTED' },
  PRICE_MANIPULATION: { id: 'price_manipulation', name: 'Price Manipulation', targetLayer: 'Payment Guard', expectedDefense: 'PRICE_INTEGRITY' },
  MANDATE_VIOLATION: { id: 'mandate_violation', name: 'Mandate Violation', targetLayer: 'Policy', expectedDefense: 'AMOUNT_EXCEEDS_LIMIT' },
  FAKE_MERCHANT: { id: 'fake_merchant', name: 'Fake Merchant', targetLayer: 'Trust', expectedDefense: 'TRUST_TOO_LOW' },
  DUPLICATE_PAYMENT: { id: 'duplicate_payment', name: 'Duplicate Payment', targetLayer: 'Payment Guard', expectedDefense: 'IDEMPOTENCY' },
  STALE_DEAL: { id: 'stale_deal', name: 'Stale Deal', targetLayer: 'Deal Revalidation', expectedDefense: 'STALE_DEAL' },
  AGENT_PERMISSION: { id: 'agent_permission_violation', name: 'Agent Permission', targetLayer: 'Agent permissions', expectedDefense: 'AGENT_ACTION_DENIED' },
  NETWORK_FAILURE: { id: 'network_failure', name: 'Network Failure Recovery', targetLayer: 'Idempotency ledger', expectedDefense: 'VERIFY_BEFORE_RETRY' }
});

export const attackById = (id) => Object.values(ATTACKS).find(attack => attack.id === id) || null;
