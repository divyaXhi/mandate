/**
 * LLM-based intent parsing via Google Gemini (free tier, no billing required).
 * This REPLACES the regex-based query/budget extraction in agent.js's
 * parseIntent — but critically, changes nothing about what the LLM is
 * allowed to influence. The LLM only ever produces { query, budget,
 * minBudget } — the same shape the rule-based parser already produced.
 * It cannot set a price, approve anything, or touch the mandate; those are
 * still entirely owned by cartMandate.js, trustLayer.js, and policyEngine.js,
 * which never read anything from this module except which products to look for.
 *
 * Falls back to the existing rule-based parseIntent (agent.js) whenever:
 *  - no GEMINI_API_KEY is configured
 *  - the API call fails, times out, or returns something unparseable
 * so a flaky network or missing key never breaks the shopping flow.
 */

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// Google retires flash models without much warning; a single hard-coded ID means
// the feature silently stops working the day that ID leaves the serving list.
// Try in order, remember the first one that answers, and let the caller see which
// one that was. The env override always wins and is tried first, alone.
const GEMINI_MODEL_FALLBACKS = ['gemini-2.5-flash', 'gemini-2.0-flash'];
const GEMINI_URL = model => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const SYSTEM_PROMPT = `You extract shopping intent from a user's message, which may be in English, Hindi, Hinglish, or a mix. Respond with ONLY a JSON object, no other text, no markdown fences, matching exactly this shape:

{"query": "<short English search terms for the product, e.g. 'laptop' or 'running shoes'>", "budget": <max price in INR as a number, or null>, "minBudget": <min price in INR as a number, or null>}

Rules:
- Translate/normalize the product query to plain English search terms (2-4 words), even if the input is in Hindi or Hinglish.
- "under 500", "500 se kam", "80k ke andar" all mean budget=that number (convert "k" to thousands).
- "500 to 1500", "500 aur 1500 ke beech" means minBudget=500, budget=1500.
- If no budget is mentioned at all, both budget and minBudget must be null.
- If the message isn't a shopping request at all, return {"query": "", "budget": null, "minBudget": null}.
- Never include any explanation, only the JSON object.`;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {string} message - the raw user message
 * @returns {Promise<{ query: string, budget: number|null, minBudget: number|null,
 *                     model: string|null }|null>}
 *   null means "LLM parsing unavailable/failed — caller should fall back"
 *   model is the ID that actually answered (for the UI to label truthfully).
 */
export async function parseIntentWithLLM(message) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !message || !message.trim()) return null;

  // One explicit env choice beats a fallback list: if the user said GEMINI_MODEL,
  // that is the model they want, and a silent swap to a different one would hide
  // a real problem. Try only that one, but still report the failure honestly.
  const candidates = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : GEMINI_MODEL_FALLBACKS;
  let lastError = null;

  for (const model of candidates) {
    try {
      const res = await fetchWithTimeout(`${GEMINI_URL(model)}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\nUser message: "${message}"` }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 150,
            responseMimeType: 'application/json'
          }
        })
      }, 6000);

      const isAuthError = res.status === 400 || res.status === 401 || res.status === 403;
      if (isAuthError) {
        // A wrong key will fail identically for every candidate — retrying the
        // next model would only burn both requests and hide the real cause.
        console.warn(`[llmIntent] Gemini rejected the key (${res.status}) — falling back to rule-based parsing`);
        return null;
      }

      if (!res.ok) {
        // 404 = model not found (retired). Try the next candidate; keep riding
        // the list only for "model does not exist", which is a naming problem.
        lastError = new Error(`Gemini returned ${res.status}`);
        console.warn(`[llmIntent] Gemini model ${model} returned ${res.status} — trying next candidate`);
        continue;
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        lastError = new Error('Empty completion from Gemini');
        continue;
      }

      const parsed = JSON.parse(text);
      if (typeof parsed.query !== 'string') {
        lastError = new Error('Unparseable completion from Gemini');
        continue;
      }

      return {
        query: parsed.query.trim(),
        budget: typeof parsed.budget === 'number' ? Math.round(parsed.budget) : null,
        minBudget: typeof parsed.minBudget === 'number' ? Math.round(parsed.minBudget) : null,
        model
      };
    } catch (err) {
      // Network failure or timeout: same for every candidate — one retry per
      // candidate would mean 6+ seconds of dead time before falling back, and
      // the demo path never wants that on bad venue wifi.
      lastError = err;
      console.warn(`[llmIntent] Gemini call failed (${err.message}) — falling back to rule-based parsing`);
      return null;
    }
  }

  console.warn(`[llmIntent] all model candidates failed (${lastError?.message}) — falling back to rule-based parsing`);
  return null;
}
