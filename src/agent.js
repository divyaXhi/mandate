import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { searchLiveProducts } from './liveCatalog.js';
import { parseIntentWithLLM } from './llmIntent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(__dirname, '..', 'data', 'catalog.json');

export function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
}

const SYNONYMS = {
  earphone: 'earbuds', earphones: 'earbuds', headphone: 'earbuds', headphones: 'earbuds',
  earbud: 'earbuds', buds: 'earbuds',
  smartphone: 'smartphone', mobile: 'smartphone', phone: 'smartphone',
  phonecover: 'phone case', 'phone cover': 'phone case', cover: 'case',
  mat: 'yoga mat',
  bottle: 'water bottle',
  speaker: 'bluetooth speaker',
  kurti: 'kurti', kurta: 'kurti',
  shoes: 'running shoes', sneakers: 'running shoes', footwear: 'running shoes',
  bedsheet: 'bedsheet', sheets: 'bedsheet',
  wallet: 'wallet',
  jacket: 'jacket', denim: 'jacket',
  keyboard: 'keyboard',
  mug: 'mug set', mugs: 'mug set', cup: 'mug set'
};

const STOPWORDS = new Set([
  'buy', 'me', 'a', 'an', 'the', 'i', 'want', 'need', 'get', 'find', 'looking',
  'for', 'please', 'pls', 'plz', 'some', 'my', 'to', 'purchase', 'order',
  'is', 'around', 'about', 'roughly', 'nearly', 'approx', 'approximately',
  'budget', 'of', 'in', 'rupees', 'rs', 'inr', 'and', 'bhai', 'yaar', 'ke', 'andar', 'se', 'wala', 'chahiye', 'with'
]);

const CATEGORY_PATTERNS = [
  ['laptop', /\b(?:laptop|notebook)\b/i], ['earbuds', /\b(?:earbuds?|earphones?|headphones?|buds)\b/i],
  ['phone case', /\b(?:phone\s*case|phonecover|cover)\b/i], ['running shoes', /\b(?:running\s+shoes?|shoes?|sneakers?)\b/i],
  ['smartphone', /\b(?:smartphones?|mobile(?:\s+phone)?|phone)\b/i],
  ['keyboard', /\bkeyboard\b/i], ['bluetooth speaker', /\b(?:speaker|bluetooth)\b/i],
  ['water bottle', /\b(?:water\s+)?bottle\b/i], ['yoga mat', /\b(?:yoga\s+)?mat\b/i], ['mug set', /\b(?:mugs?|cups?)\b/i],
  ['jacket', /\b(?:jacket|denim)\b/i], ['kurti', /\b(?:kurti|kurta)\b/i], ['bedsheet', /\b(?:bedsheet|sheets?)\b/i], ['wallet', /\bwallet\b/i],
  ['hair dryer', /\b(?:hair\s*dryer|blow\s*dryer)\b/i], ['office chair', /\b(?:office\s*chair|ergonomic\s*chair)\b/i]
];

export function enrichIntent(request, base) {
  const lower = request.toLowerCase();
  const category = CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(lower))?.[0] || null;
  const constraints = [];
  if (/\b(?:non[ -]?gaming|not gaming|office)\b/i.test(lower)) constraints.push('non-gaming');
  if (/\b(?:gaming)\b/i.test(lower) && !constraints.includes('non-gaming')) constraints.push('gaming');
  if (/\b(?:light|lighter|lightweight)\b/i.test(lower)) constraints.push('lightweight');
  if (/\b(?:battery|long battery)\b/i.test(lower)) constraints.push('good-battery');
  const accessories = /\b(?:laptop )?bag\b/i.test(lower) ? ['laptop bag'] : [];
  // The category is a catalog-search term; descriptive language is metadata,
  // never an invented product fact.
  return { ...base, query: category || base.query, category, constraints, accessories };
}

/**
 * Parse a natural-language request into a structured Intent Mandate.
 * Rule-based (no LLM key configured yet — see docs/project-brief.md and
 * .env.example LLM_API_KEY). Handles a wider range of budget phrasings
 * (single max, or an explicit range) and a synonym map so common alternate
 * phrasings ("earphones", "phonecover") still resolve to catalog terms.
 * The RETURN SHAPE is the contract downstream code depends on — swapping
 * this for an LLM call later means keeping { query, budget, minBudget }
 * and everything else keeps working unchanged.
 *
 * @param {string} request - e.g. "buy me a phone case under 500", "earbuds between 500 and 1500"
 * @returns {{ query: string, budget: number|null, minBudget: number|null, rawTerms: string[] }}
 */
export function parseIntent(request) {
  const lower = request.toLowerCase();

  // Range first: "between X and Y", "X to Y", "X-Y" (only treated as a range
  // when both numbers are followed by no product-sounding word directly after).
  let budget = null;
  let minBudget = null;
  const rangeMatch = lower.match(/(?:between\s*)?(?:rs\.?|₹|inr)?\s*(\d+(?:\.\d+)?)\s*(k)?\s*(?:to|-|and)\s*(?:rs\.?|₹|inr)?\s*(\d+(?:\.\d+)?)\s*(k)?/i);
  if (rangeMatch) {
    let lo = parseFloat(rangeMatch[1]);
    if (rangeMatch[2]) lo *= 1000;
    let hi = parseFloat(rangeMatch[3]);
    if (rangeMatch[4]) hi *= 1000;
    if (hi > lo) {
      minBudget = Math.round(lo);
      budget = Math.round(hi);
    }
  }

  // Single max budget: "under/below/less than X", "budget of X", "around Xk", "~X", bare "Xk"
  if (budget == null) {
    const patterns = [
      /(?:under|below|less than|within|max(?:imum)?)\s*(?:rs\.?|₹|inr)?\s*(\d+(?:\.\d+)?)\s*(k)?/i,
      /budget(?:\s*(?:is|of|around|:))?\s*(?:rs\.?|₹|inr)?\s*~?\s*(\d+(?:\.\d+)?)\s*(k)?/i,
      /~\s*(?:rs\.?|₹|inr)?\s*(\d+(?:\.\d+)?)\s*(k)?/i,
      /(?:rs\.?|₹|inr)\s*(\d+(?:\.\d+)?)\s*(k)?/i,
      /\b(\d+(?:\.\d+)?)\s*(k)\b/i
    ];
    for (const p of patterns) {
      const m = lower.match(p);
      if (m) {
        let val = parseFloat(m[1]);
        if (m[2]) val *= 1000; // "2k" -> 2000
        budget = Math.round(val);
        break;
      }
    }
  }

  // Strip budget phrase + stopwords, keep meaningful nouns/adjectives
  const noBudgetPhrase = lower
    .replace(/(?:between\s*)?(?:rs\.?|₹|inr)?\s*\d+(?:\.\d+)?\s*k?\s*(?:to|-|and)\s*(?:rs\.?|₹|inr)?\s*\d+(?:\.\d+)?\s*k?/gi, ' ')
    .replace(/(?:under|below|less than|within|max(?:imum)?|budget(?:\s*(?:is|of|around|:))?)\s*(?:rs\.?|₹|inr)?\s*~?\s*\d+(?:\.\d+)?\s*k?/gi, ' ')
    .replace(/(?:rs\.?|₹|inr)\s*\d+(?:\.\d+)?\s*k?/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*k\b/gi, ' ');

  const rawTerms = noBudgetPhrase
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !STOPWORDS.has(t));

  // Apply synonym map, then de-dupe
  const mappedTerms = [...new Set(
    rawTerms.map(t => SYNONYMS[t] || t).join(' ').split(/\s+/).filter(Boolean)
  )];

  return enrichIntent(request, { query: mappedTerms.join(' '), budget, minBudget, rawTerms: mappedTerms });
}

/**
 * Search the local mock catalog for items matching the parsed intent.
 * Uses partial-term matching (any query term appearing in the item name/category
 * counts, weighted by how many terms match) rather than requiring every term to
 * match — more forgiving of natural phrasing than a strict AND match.
 */
export function searchCatalog(intent) {
  const { query, budget, minBudget, constraints = [] } = intent;
  const catalog = loadCatalog();
  const terms = query.split(/\s+/).filter(Boolean);

  const scored = catalog
    .filter(item => item.stock > 0)
    // Headroom above budget (not a hard cutoff) — items up to 30% over budget still
    // surface, so the Merchant Agent negotiation rescue path in server.js has
    // something to negotiate on. buildCartMandate's withinBudget check (and the
    // candidate filter in continuePurchase) still enforces the real budget for
    // anything that ISN'T negotiated.
    .filter(item => (budget ? item.price_inr <= budget * 1.3 : true))
    .filter(item => (minBudget ? item.price_inr >= minBudget : true))
    .map(item => {
      const haystack = `${item.name} ${item.category} ${(item.tags || []).join(' ')} ${(item.accessories || []).join(' ')}`.toLowerCase();
      const matchCount = terms.filter(t => haystack.includes(t)).length;
      return { item, matchCount };
    })
    .filter(({ matchCount }) => terms.length === 0 || matchCount > 0)
    .filter(({ item }) => !constraints.includes('non-gaming') || !(item.tags || []).includes('gaming'))
    .filter(({ item }) => !constraints.includes('gaming') || (item.tags || []).includes('gaming'))
    .sort((a, b) => b.matchCount - a.matchCount || a.item.price_inr - b.item.price_inr);

  return scored.map(s => s.item);
}

/**
 * Search for products, preferring a real live search (Amazon India via
 * liveCatalog.js) and falling back to the local mock catalog when live
 * search is unavailable (no RAPIDAPI_KEY configured, or the call fails) or
 * returns nothing. This is the function server.js should call — searchCatalog
 * above stays available directly for the mock-only path and for tests.
 *
 * @returns {Promise<{ items: Array, source: 'live'|'mock' }>}
 */
export async function searchProducts(intent) {
  const liveResults = await searchLiveProducts(intent.query, intent.minBudget, intent.budget);
  if (liveResults && liveResults.length > 0) {
    return { items: liveResults, source: 'live' };
  }
  return { items: searchCatalog(intent), source: 'mock' };
}

/**
 * The entry point server.js should call for any FRESH user message (not a
 * budget-range reply, not an OTP, etc — an actual new shopping request).
 * Tries Gemini first (handles Hindi/Hinglish/mixed natural language far
 * better than the regex parser), falls back to the deterministic parseIntent
 * above whenever the LLM is unavailable, slow, or returns something
 * unusable. Either path returns the exact same shape, so nothing downstream
 * needs to know or care which one ran.
 *
 * Nothing this returns is trusted for anything beyond "what to search for
 * and what price range to search within" — price, trust, and approval are
 * entirely decided elsewhere (cartMandate.js, trustLayer.js, policyEngine.js),
 * which never call this module at all.
 */
export async function parseIntentSmart(message) {
  const llmResult = await parseIntentWithLLM(message);
  if (llmResult && llmResult.query) {
    // Still run through the synonym map so live/mock catalog matching stays
    // consistent regardless of which parser produced the query terms.
    const mappedTerms = [...new Set(
      llmResult.query.toLowerCase().split(/\s+/).map(t => SYNONYMS[t] || t).join(' ').split(/\s+/).filter(Boolean)
    )];
    return enrichIntent(message, { query: mappedTerms.join(' '), budget: llmResult.budget, minBudget: llmResult.minBudget, rawTerms: mappedTerms, source: 'llm', model: llmResult.model });
  }
  return { ...parseIntent(message), source: 'rule-based' };
}
