/** A read-only timeline assembled from the append-only audit log. */
import { toStructuredAuditEvent } from './auditEvents.js';
export function buildTransactionTimeline(transactionId, events = []) {
  return {
    transactionId,
    readOnly: true,
    events: events.map(toStructuredAuditEvent).map((event, index) => ({
      sequence: index + 1,
      timestamp: event.timestamp,
      stage: event.stage,
      event: event.event,
      correlationId: event.correlationId,
      details: event.details
    }))
  };
}
