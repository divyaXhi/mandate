/**
 * Live foreign-exchange rates for the cross-border fee calculation, via
 * open.er-api.com (free, no API key required). Kept as a background-refreshed
 * in-memory cache rather than an on-demand fetch, so buildCartMandate() in
 * cartMandate.js can stay fully synchronous — every other module that calls
 * it doesn't need to become async just for this.
 *
 * Falls back to the same static rates the project shipped with if the live
 * fetch fails or hasn't completed yet — a cross-border price should never be
 * blocked or made wrong by a flaky network call.
 */

const FALLBACK_RATES = { USD: 83.2, GBP: 105.4 };
const REFRESH_MS = 30 * 60 * 1000; // 30 minutes

let cache = { ...FALLBACK_RATES };
let lastLiveFetch = 0;

async function refresh() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // never let this hang the server
    let res;
    try {
      res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new Error(`FX API returned ${res.status}`);
    const data = await res.json();
    if (data?.rates?.INR && data?.rates?.GBP) {
      cache = {
        USD: data.rates.INR,
        GBP: data.rates.INR / data.rates.GBP // cross rate via USD, since the API bases on USD
      };
      lastLiveFetch = Date.now();
      console.log('[fxRates] refreshed live rates:', cache);
    }
  } catch (err) {
    console.warn(`[fxRates] live fetch failed (${err.message}) — using cached/fallback rates`);
  }
}

// Tests and deterministic demo runs must not leave a background socket or
// interval alive. They still use the same synchronous fallback rates, so the
// pricing rule itself is identical without relying on external network state.
const deterministicEnvironment = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'demo' || process.env.DEMO_MODE === 'true';
const backgroundRefreshEnabled = !deterministicEnvironment;
if (backgroundRefreshEnabled) {
  refresh();
  const refreshTimer = setInterval(refresh, REFRESH_MS);
  refreshTimer.unref(); // background freshness must never prevent clean exit
}

const CROSS_BORDER_FEE_PCT = 0.025; // a fixed business rule, independent of the live/mock rate

/**
 * @param {string} countryCode - 'US' | 'UK' | 'IN' | other
 * @returns {{ code: string, rateToINR: number, feePct: number, live: boolean }}
 */
export function getFxRate(countryCode) {
  const isLive = lastLiveFetch > 0 && (Date.now() - lastLiveFetch) < REFRESH_MS * 2;
  if (countryCode === 'US') return { code: 'USD', rateToINR: cache.USD, feePct: CROSS_BORDER_FEE_PCT, live: isLive };
  if (countryCode === 'UK') return { code: 'GBP', rateToINR: cache.GBP, feePct: CROSS_BORDER_FEE_PCT, live: isLive };
  return { code: 'INR', rateToINR: 1, feePct: 0, live: true };
}
