/**
 * Prompt-injection detection for untrusted content (product titles/descriptions
 * that flow through the agent's context). This is deliberately simple pattern
 * matching, not an LLM call — the point isn't to be a sophisticated classifier,
 * it's to demonstrate the architectural principle: untrusted content flowing
 * through the agent can try to issue instructions, and nothing downstream
 * (price, approval, payment) is allowed to trust it. Detection here is a
 * signal for logging/UI, not the actual safety mechanism — the actual
 * mechanism is that price and approval always come from the catalog record
 * and the user's explicit confirmation, never from free text.
 */

const INJECTION_PATTERNS = [
  /ignore (all|any|the)? ?previous instructions/i,
  /disregard (the|your|all)? ?(budget|instructions|mandate|limits?)/i,
  /set price to/i,
  /override (the )?(price|approval|mandate|budget)/i,
  /auto[- ]?approve/i,
  /charge (rs\.?|₹|inr)?\s*\d+/i,
  /without (confirmation|approval|verification)/i,
  /act as (the )?(admin|system|developer)/i,
  /you (must|should) now/i
];

/**
 * @param {string} text - untrusted text (e.g. a product description)
 * @returns {{ detected: boolean, matches: string[] }}
 */
export function detectPromptInjection(text) {
  if (!text) return { detected: false, matches: [] };
  const matches = [];
  for (const pattern of INJECTION_PATTERNS) {
    const m = text.match(pattern);
    if (m) matches.push(m[0]);
  }
  return { detected: matches.length > 0, matches };
}
