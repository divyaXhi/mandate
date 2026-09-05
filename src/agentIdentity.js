/**
 * Agent Identity — gives the Buyer Agent and Merchant Agent an explicit
 * identity with a stated permission set, AND real runtime enforcement of the
 * bounds that matter for money movement. This isn't just a documentation
 * layer: enforceNegotiationBound() below is actually called by
 * merchantAgent.js before a negotiated price is ever used, and it
 * independently re-derives the legal floor/ceiling rather than trusting
 * whatever price it's handed — so a Merchant Agent (or a bug, or an
 * injection) proposing a price outside its permitted bound gets rejected in
 * code, not just documented as "not allowed" in a UI panel.
 */

const MERCHANT_MAX_DISCOUNT_PCT = 0.10; // must match merchantAgent.js's MAX_DISCOUNT_PCT

export function buyerAgentIdentity(session) {
  return {
    agentId: `BUY-${session.agentSeed || '00000'}`,
    type: 'Buyer Agent',
    owner: session.profile?.name || 'User',
    status: 'active',
    permissions: {
      allowed: ['Search catalog', 'Compare products', 'Negotiate with Merchant Agent', 'Create cart', 'Request payment'],
      denied: ['Modify mandate', 'Approve payment', 'Increase spending limit', 'Bypass policy engine']
    }
  };
}

export function merchantAgentIdentity(merchantName) {
  return {
    agentId: `MER-${hashToId(merchantName)}`,
    type: 'Merchant Agent',
    owner: merchantName,
    status: 'active',
    permissions: {
      allowed: ['Read catalog', 'Generate offers', 'Negotiate price (bounded)', 'Recommend bundles'],
      denied: ['Modify buyer mandate', 'Authorize buyer payment', 'Exceed negotiation discount floor', 'Bypass trust/policy checks']
    }
  };
}

/**
 * Runtime enforcement of the Merchant Agent's one real financial power: how
 * far it's allowed to discount a listed price during negotiation. Called
 * with whatever price merchantAgent.js is about to hand off — independently
 * recomputes the legal floor from the item's OWN list price (never from the
 * proposed price itself, which is exactly what a malicious/buggy proposal
 * would try to manipulate) and clamps to it.
 *
 * @returns {{ allowed: boolean, enforcedPriceInr: number, violated: boolean, reason: string|null }}
 */
export function enforceNegotiationBound(listPriceInr, proposedPriceInr) {
  const floor = Math.round(listPriceInr * (1 - MERCHANT_MAX_DISCOUNT_PCT));
  const ceiling = listPriceInr; // a Merchant Agent negotiating a price ABOVE its own list price makes no sense either — clamp both ends

  if (proposedPriceInr < floor) {
    return { allowed: false, enforcedPriceInr: floor, violated: true, reason: `Merchant Agent proposed ₹${proposedPriceInr}, below its permitted floor of ₹${floor} (max ${(MERCHANT_MAX_DISCOUNT_PCT * 100).toFixed(0)}% off list ₹${listPriceInr}) — clamped to the floor.` };
  }
  if (proposedPriceInr > ceiling) {
    return { allowed: false, enforcedPriceInr: ceiling, violated: true, reason: `Merchant Agent proposed ₹${proposedPriceInr}, above its own list price of ₹${ceiling} — clamped to list price.` };
  }
  return { allowed: true, enforcedPriceInr: proposedPriceInr, violated: false, reason: null };
}

function hashToId(str) {
  let h = 0;
  for (let i = 0; i < (str || '').length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return String(h % 100000).padStart(5, '0');
}
