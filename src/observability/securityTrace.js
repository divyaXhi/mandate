import { buildTransactionTrace } from './transactionTrace.js';

export function buildSecurityTrace(transactionId, events = []) {
  const trace = buildTransactionTrace(transactionId, events);
  return { ...trace, timeline: trace.timeline.filter(event => event.stage === 'SECURITY' || event.stage === 'RECOVERY') };
}
