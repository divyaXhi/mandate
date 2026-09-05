/**
 * Live product search against Amazon India, via RapidAPI's "Real-Time Amazon
 * Data" service (real-time-amazon-data.p.rapidapi.com — free tier available).
 *
 * Falls back cleanly when RAPIDAPI_KEY isn't set or the call fails: callers
 * should treat a null/empty return as "use the local mock catalog instead"
 * (see agent.js searchCatalog), so a network hiccup or missing key during a
 * live demo never breaks the flow — it just quietly uses the seeded data.
 *
 * Real listings don't carry "merchant tenure on our platform" or "GST verified"
 * the way our own small-merchant catalog does — there's no such thing for an
 * external marketplace seller. Instead we map Amazon's own seller signals
 * (star rating, rating count) into the same trust-relevant shape, and
 * trustLayer.js scores those instead when an item is `live: true`.
 */

const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'real-time-amazon-data.p.rapidapi.com';

/**
 * @param {string} query - search terms (already synonym-mapped by parseIntent)
 * @param {number|null} minPriceInr
 * @param {number|null} maxPriceInr
 * @returns {Promise<Array|null>} array of catalog-shaped items, or null if live search is unavailable
 */
export async function searchLiveProducts(query, minPriceInr, maxPriceInr) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey || !query) return null;

  try {
    const params = new URLSearchParams({
      query,
      country: 'IN',
      page: '1'
    });
    if (minPriceInr) params.set('min_price', String(minPriceInr));
    if (maxPriceInr) params.set('max_price', String(maxPriceInr));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000); // never hang a chat request on a slow/dead external API
    let res;
    try {
      res = await fetch(`https://${RAPIDAPI_HOST}/search?${params.toString()}`, {
        headers: {
          'x-rapidapi-key': apiKey,
          'x-rapidapi-host': RAPIDAPI_HOST
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      console.warn(`[liveCatalog] RapidAPI returned ${res.status} — falling back to mock catalog`);
      return null;
    }

    const data = await res.json();
    const products = data?.data?.products || [];
    if (products.length === 0) return null;

    return products.slice(0, 10).map(mapToItem).filter(Boolean);
  } catch (err) {
    console.warn(`[liveCatalog] Live search failed (${err.message}) — falling back to mock catalog`);
    return null;
  }
}

function mapToItem(p) {
  const price = parseInrPrice(p.product_price);
  if (price == null) return null;

  return {
    id: p.asin || `live_${Math.random().toString(36).slice(2, 10)}`,
    name: p.product_title || 'Unknown product',
    category: 'live', // category-risk weighting doesn't apply cleanly to arbitrary live results
    price_inr: price,
    stock: 1,
    origin_country: 'IN', // Amazon India listings — treated as domestic for the cross-border signal
    merchant: p.product_byline || p.brand || 'Amazon India seller',
    live: true,
    sellerRating: p.product_star_rating ? parseFloat(p.product_star_rating) : null,
    sellerRatingCount: p.product_num_ratings ? parseInt(String(p.product_num_ratings).replace(/,/g, ''), 10) : 0,
    productUrl: p.product_url || null,
    imageUrl: p.product_photo || null
  };
}

function parseInrPrice(priceStr) {
  if (!priceStr) return null;
  const digits = String(priceStr).replace(/[^\d.]/g, '');
  const val = parseFloat(digits);
  return isNaN(val) ? null : Math.round(val);
}
