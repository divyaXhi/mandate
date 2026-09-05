/**
 * Merchant Agent — the seller-side counterpart to the buyer's agent. Its job
 * is to grow merchant revenue (accept reasonable offers, propose bundles)
 * while the buyer's agent tries to stay within budget.
 *
 * Deliberately rule-based, not LLM-driven, for the same reason the policy
 * engine is: a pricing decision needs to be bounded and explainable. This
 * agent can propose a price — it can NEVER force one. Whatever it proposes
 * still goes through buildCartMandate, scoreConfidence, and evaluatePolicy
 * exactly like a listed price would — MANDATE has final say either way.
 */

const MAX_DISCOUNT_PCT = 0.10; // the merchant will never counter more than 10% off list price

const BUNDLE_BY_CATEGORY = {
  electronics: { name: 'protective case + screen guard', priceInr: 249 },
  accessories: { name: 'gift wrap + extended warranty', priceInr: 99 },
  footwear: { name: 'sock pair + shoe cleaner kit', priceInr: 149 },
  apparel: { name: 'fabric care kit', priceInr: 129 },
  home: { name: 'care & maintenance kit', priceInr: 99 },
  fitness: { name: 'carry bag', priceInr: 179 }
};

/**
 * @param {object} item - catalog item with item.price_inr (list price)
 * @param {number} requestedPriceInr - what the buyer's agent is asking for (e.g. their budget)
 * @returns {{ accepted: boolean, finalPriceInr?: number, counterPriceInr?: number, message: string }}
 */
export function proposeCounterOffer(item, requestedPriceInr) {
  const listPrice = item.price_inr;
  const floor = Math.round(listPrice * (1 - MAX_DISCOUNT_PCT));

  if (requestedPriceInr >= listPrice) {
    return { accepted: true, finalPriceInr: listPrice, message: `Accepted at list price ₹${listPrice}.` };
  }
  if (requestedPriceInr >= floor) {
    return { accepted: true, finalPriceInr: requestedPriceInr, message: `Deal — I can do ₹${requestedPriceInr} for the ${item.name}.` };
  }
  return {
    accepted: false,
    counterPriceInr: floor,
    message: `₹${requestedPriceInr} is below what I can offer, but I can do ₹${floor} — that's the best I can go (max ${(MAX_DISCOUNT_PCT * 100).toFixed(0)}% off list).`
  };
}

/**
 * Upsell offer — a bundled add-on at a partial discount, shown alongside an
 * accepted or negotiated price. Purely informational unless the buyer opts in.
 */
export function proposeBundle(item) {
  const addon = BUNDLE_BY_CATEGORY[item.category];
  if (!addon) return null;
  const bundlePriceInr = Math.round(addon.priceInr * 0.7); // 30% off the add-on when bundled
  return { addonName: addon.name, addonListPriceInr: addon.priceInr, bundlePriceInr };
}
