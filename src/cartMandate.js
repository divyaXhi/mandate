import { getFxRate } from './fxRates.js';

/**
 * Build a Cart Mandate: the explicit, human-readable object the user must
 * approve before any payment happens. This is the "bounded and gated" checkpoint.
 *
 * @param {object} item - catalog item
 * @param {string} buyerCountry
 * @param {number|null} budget - buyer's stated budget, for the withinBudget check
 * @param {number|null} overridePriceInr - use this instead of item.price_inr — the
 *   only legitimate caller of this is the negotiation flow (merchantAgent.js),
 *   after a bounded, logged negotiation. Nothing else may override price.
 */
export function buildCartMandate(item, buyerCountry, budget, overridePriceInr = null) {
  const isCrossBorder = item.origin_country !== buyerCountry;
  const fx = getFxRate(item.origin_country);
  const basePrice = overridePriceInr ?? item.price_inr;

  const fee = isCrossBorder ? Math.round(basePrice * fx.feePct) : 0;
  const totalInr = basePrice + fee;

  // Estimated delivery: simple, honest heuristic — cross-border takes longer,
  // live-marketplace listings and small merchants get slightly different windows.
  // Not a real courier ETA (no shipping API here); shown as a range, clearly an estimate.
  const minDays = isCrossBorder ? 7 : (item.live ? 3 : 2);
  const maxDays = isCrossBorder ? 14 : (item.live ? 6 : 5);
  const deliveryEstimate = { minDays, maxDays, label: `${minDays}-${maxDays} business days` };

  return {
    item: {
      id: item.id,
      name: item.name,
      merchant: item.merchant,
      originCountry: item.origin_country,
      category: item.category,
      merchantTenureDays: item.merchant_tenure_days,
      gstVerified: item.gst_verified
    },
    pricing: {
      basePriceInr: basePrice,
      listPriceInr: item.price_inr,
      negotiated: overridePriceInr != null && overridePriceInr !== item.price_inr,
      crossBorderFeeInr: fee,
      totalInr,
      fxRate: isCrossBorder ? { code: fx.code, rateToINR: fx.rateToINR, live: fx.live } : null,
      // shown transparently — this is the exact thing Instant Checkout's
      // failure postmortem flagged as missing (see project brief)
      displayCurrencyNote: isCrossBorder
        ? `Cross-border purchase from ${item.origin_country}. Fee (${(fx.feePct * 100).toFixed(1)}%) included above. FX: 1 ${fx.code} ≈ ₹${fx.rateToINR.toFixed(2)}${fx.live ? ' (live)' : ' (cached)'}.`
        : 'Domestic purchase — no conversion fee.'
    },
    deliveryEstimate,
    isCrossBorder,
    withinBudget: budget ? totalInr <= budget : true,
    approved: false // flips to true only after explicit user confirmation
  };
}
