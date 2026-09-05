import crypto from 'crypto';

const correlations = new Map();

/** Server-owned correlation IDs; callers never provide an authority value. */
export function generateCorrelationId() {
  return `corr_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function getCorrelationId(transactionId) {
  if (!transactionId) return null;
  if (!correlations.has(transactionId)) correlations.set(transactionId, generateCorrelationId());
  return correlations.get(transactionId);
}

export function attachCorrelation(event) {
  return { ...event, correlationId: getCorrelationId(event?.transactionId) };
}

export function clearCorrelation(transactionId) { correlations.delete(transactionId); }
