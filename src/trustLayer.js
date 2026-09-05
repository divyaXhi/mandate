/**
 * Trust Layer — scores confidence for a proposed purchase instead of a flat approve/block.
 *
 * Signals considered (rule-based, deliberately explainable):
 *  - crossBorder: is the merchant in a different country than the buyer?
 *  - verificationMatch: did the simulated CVC/AVS-style check pass?
 *  - amountRatio: how much of the user's budget does this consume? (near-limit = slightly riskier)
 *  - knownMerchant: has this merchant been transacted with before? (simulated)
 *  - merchantTenureDays / gstVerified: platform-tenure and KYC signals for items from the
 *    local mock catalog (small merchants who have no external reputation to check).
 *  - sellerRating / sellerRatingCount: for LIVE items (real Amazon India search results via
 *    liveCatalog.js), there's no "tenure on our platform" to check — instead we score the
 *    seller's real public rating and review volume, which is the actual trust signal that
 *    exists for an external marketplace listing. Only one of these two signal pairs applies
 *    per item, decided by whether the item came from a live search.
 *  - category: category-level risk weight (e.g. high-value electronics vs. daily-use groceries)
 *  - recentPurchaseCount: how many purchases has this session made in the last few minutes?
 *
 * Decisions are tiered, not binary:
 *  - proceed             (score >= PROCEED_THRESHOLD)
 *  - step_up_required    (STEP_UP_THRESHOLD <= score < PROCEED_THRESHOLD) — OTP-style reconfirmation
 *  - blocked             (score < STEP_UP_THRESHOLD) — too risky to proceed even with step-up
 */

const PROCEED_THRESHOLD = 70; // at/above this, proceed automatically
const STEP_UP_THRESHOLD = 40; // between this and PROCEED_THRESHOLD, require step-up auth
// below STEP_UP_THRESHOLD: blocked outright

const CATEGORY_RISK = {
  electronics: 8,
  accessories: 2,
  home: 2,
  groceries: 0,
  fashion: 3,
  apparel: 3,
  footwear: 3,
  fitness: 1,
  live: 4, // arbitrary live-search results get a small baseline weight (unknown category risk)
  default: 3
};

export function scoreConfidence({
  crossBorder,
  verificationMatch,
  amountRatio,
  knownMerchant,
  merchantTenureDays = 365,
  gstVerified = true,
  isLive = false,
  sellerRating = null,
  sellerRatingCount = 0,
  category = 'default',
  recentPurchaseCount = 0
}) {
  let score = 95; // start optimistic, subtract for risk signals
  const reasons = [];
  const signals = []; // structured breakdown for UI rendering

  const addSignal = (label, delta, detail) => {
    if (delta !== 0) reasons.push(detail);
    signals.push({ label, delta, detail, triggered: delta !== 0 });
  };

  if (crossBorder) {
    score -= 15;
    addSignal('Cross-border', -15, 'Cross-border transaction — extra scrutiny applied');
  } else {
    addSignal('Cross-border', 0, 'Domestic transaction');
  }

  if (!verificationMatch) {
    score -= 30;
    addSignal('Verification', -30, 'Verification check (CVC/AVS-style) did not match — common false-decline trigger, not treated as automatic block');
  } else {
    addSignal('Verification', 0, 'Verification check passed');
  }

  if (amountRatio > 0.9) {
    score -= 10;
    addSignal('Budget proximity', -10, 'Purchase amount is close to the approved budget limit');
  } else {
    addSignal('Budget proximity', 0, 'Well within approved budget');
  }

  if (!knownMerchant) {
    score -= 5;
    addSignal('Merchant familiarity', -5, 'First transaction with this merchant');
  } else {
    addSignal('Merchant familiarity', 0, 'Previously transacted with this merchant');
  }

  if (isLive) {
    // --- Real marketplace seller reputation (live Amazon India results) ---
    if (sellerRating == null) {
      score -= 15;
      addSignal('Seller rating', -15, 'No public seller rating available for this listing');
    } else if (sellerRating < 3.5) {
      score -= 20;
      addSignal('Seller rating', -20, `Seller rating is low (${sellerRating}/5)`);
    } else if (sellerRating < 4.2) {
      score -= 8;
      addSignal('Seller rating', -8, `Seller rating is moderate (${sellerRating}/5)`);
    } else {
      addSignal('Seller rating', 0, `Seller rating is strong (${sellerRating}/5)`);
    }

    if (sellerRatingCount < 20) {
      score -= 12;
      addSignal('Review volume', -12, `Only ${sellerRatingCount} public ratings — thin review history`);
    } else if (sellerRatingCount < 200) {
      score -= 5;
      addSignal('Review volume', -5, `${sellerRatingCount} public ratings — moderate review history`);
    } else {
      addSignal('Review volume', 0, `${sellerRatingCount}+ public ratings — well-established listing`);
    }
  } else {
    // --- Small-merchant signals (local mock catalog) ---
    if (merchantTenureDays < 30) {
      score -= 15;
      addSignal('Merchant tenure', -15, `Merchant has only been on the platform ${merchantTenureDays} days`);
    } else if (merchantTenureDays < 180) {
      score -= 7;
      addSignal('Merchant tenure', -7, `Merchant has been on the platform ${merchantTenureDays} days — still building history`);
    } else {
      addSignal('Merchant tenure', 0, `Established merchant (${merchantTenureDays}+ days on platform)`);
    }

    if (!gstVerified) {
      score -= 12;
      addSignal('GST/KYC', -12, 'Merchant has not completed GST/KYC verification');
    } else {
      addSignal('GST/KYC', 0, 'Merchant GST/KYC verified');
    }
  }

  const catRisk = CATEGORY_RISK[category] ?? CATEGORY_RISK.default;
  if (catRisk > 0) {
    score -= catRisk;
    addSignal('Category risk', -catRisk, `${category} carries a baseline risk weight (higher-value/resale-prone category)`);
  } else {
    addSignal('Category risk', 0, `${category} is a low-risk category`);
  }

  // --- Spend velocity ---
  if (recentPurchaseCount >= 3) {
    score -= 20;
    addSignal('Spend velocity', -20, `${recentPurchaseCount} purchases in the last few minutes — unusual burst activity`);
  } else if (recentPurchaseCount === 2) {
    score -= 8;
    addSignal('Spend velocity', -8, 'Second purchase in quick succession');
  } else {
    addSignal('Spend velocity', 0, 'Normal purchase pace');
  }

  score = Math.max(0, Math.min(100, score));

  let decision;
  if (score >= PROCEED_THRESHOLD) decision = 'proceed';
  else if (score >= STEP_UP_THRESHOLD) decision = 'step_up_required';
  else decision = 'blocked';

  return {
    score,
    decision,
    reasons,
    signals,
    thresholds: { proceed: PROCEED_THRESHOLD, stepUp: STEP_UP_THRESHOLD }
  };
}
