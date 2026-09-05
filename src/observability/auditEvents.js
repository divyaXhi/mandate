import crypto from 'crypto';
import { attachCorrelation } from './correlation.js';

const STAGES = Object.freeze(['INTENT', 'DISCOVERY', 'NEGOTIATION', 'TRUST', 'RISK', 'POLICY', 'DECISION', 'APPROVAL', 'PAYMENT_GUARD', 'PAYMENT', 'SECURITY', 'RECOVERY']);
const stageFor = step => {
  const name = String(step || '').toUpperCase();
  if (/INJECTION|ATTACK|SECURITY/.test(name)) return 'SECURITY';
  if (/RECOVER|IDEMPOT/.test(name)) return 'RECOVERY';
  if (/PAYMENT_GUARD/.test(name)) return 'PAYMENT_GUARD';
  if (/PAYMENT|RAZORPAY|COD|REFUND|RECEIPT/.test(name)) return 'PAYMENT';
  if (/APPROV|STEP_UP|OTP/.test(name)) return 'APPROVAL';
  if (/DECISION/.test(name)) return 'DECISION';
  if (/POLICY|MANDATE/.test(name)) return 'POLICY';
  if (/RISK|CONFIDENCE/.test(name)) return 'RISK';
  if (/TRUST/.test(name)) return 'TRUST';
  if (/NEGOTIATION|OFFER|DEAL|BUNDLE|AGENT_ACTION/.test(name)) return 'NEGOTIATION';
  if (/PRODUCT|CATALOG|ITEM_FOUND|CANDIDATE/.test(name)) return 'DISCOVERY';
  return 'INTENT';
};

function reasonCodes(details = {}) {
  const raw = details.reasonCodes || details.decision?.reasonCodes || details.decision?.policy?.reasonCodes || [];
  return Array.isArray(raw) ? raw.filter(Boolean) : [];
}

/** Converts legacy append-only entries into structured evidence without modifying them. */
export function toStructuredAuditEvent(entry = {}) {
  const structured = {
    eventId: entry.eventId || `evt_${crypto.randomUUID().replace(/-/g, '')}`,
    transactionId: entry.transactionId || null,
    timestamp: entry.timestamp || new Date().toISOString(),
    stage: entry.stage || stageFor(entry.event || entry.step),
    event: entry.event || String(entry.step || 'UNKNOWN').toUpperCase(),
    actor: entry.actor || 'SYSTEM',
    component: entry.component || 'mandate-server',
    decision: entry.decision || entry.details?.finalDecision || entry.details?.decision?.finalDecision || null,
    reasonCodes: entry.reasonCodes || reasonCodes(entry.details),
    details: entry.details || {}
  };
  const correlated = attachCorrelation(structured);
  return { ...correlated, correlationId: entry.correlationId || correlated.correlationId };
}

export function createAuditEvent(transactionId, step, details = {}, metadata = {}) {
  return toStructuredAuditEvent({ transactionId, step, details, timestamp: new Date().toISOString(), ...metadata });
}

export { STAGES as OBSERVABILITY_STAGES };
