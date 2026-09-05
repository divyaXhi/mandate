import { toStructuredAuditEvent } from './auditEvents.js';

export function buildTransactionTrace(transactionId, events = []) {
  const timeline = events.map(toStructuredAuditEvent).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).map((event, index) => ({ sequence: index + 1, ...event }));
  const lastDecision = [...timeline].reverse().find(event => event.decision)?.decision || null;
  return { transactionId, correlationId: timeline[0]?.correlationId || null, status: lastDecision || 'RECORDED', readOnly: true, timeline };
}
