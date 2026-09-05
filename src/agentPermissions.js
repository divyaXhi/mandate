/**
 * Server-side negotiation action policy. Identities state what an agent is;
 * this module decides which protocol actions that identity may take. The
 * browser never supplies an agent id or gets to widen this map.
 */
export const AGENT_ACTIONS = Object.freeze({
  BUYER: Object.freeze([
    'PRICE_REQUEST', 'COUNTER_OFFER', 'BUNDLE_REQUEST', 'ACCEPT', 'REJECT', 'CANCEL'
  ]),
  MERCHANT: Object.freeze([
    'OFFER', 'COUNTER_OFFER', 'BUNDLE_OFFER', 'REJECT', 'CANCEL'
  ])
});

export function canPerformNegotiationAction(role, action) {
  return AGENT_ACTIONS[role]?.includes(action) || false;
}

export function assertNegotiationPermission(role, action) {
  if (!canPerformNegotiationAction(role, action)) {
    const error = new Error(`AGENT_ACTION_DENIED: ${role} cannot perform ${action}`);
    error.code = 'AGENT_ACTION_DENIED';
    throw error;
  }
}
