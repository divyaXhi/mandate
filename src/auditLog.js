import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createAuditEvent } from './observability/auditEvents.js';
import { recordAuditEvent } from './observability/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, '..', 'data', 'audit-log.json');

function readLog() {
  if (!fs.existsSync(LOG_PATH)) return [];
  const raw = fs.readFileSync(LOG_PATH, 'utf-8');
  return raw.trim() ? JSON.parse(raw) : [];
}

function writeLog(entries) {
  fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2));
}

/**
 * Append a single event to a transaction's audit trail.
 * @param {string} transactionId
 * @param {string} step - e.g. "intent_parsed", "cart_shown", "confidence_scored", "user_approved", "payment_executed"
 * @param {object} details - arbitrary data relevant to this step
 */
export function logEvent(transactionId, step, details) {
  const entries = readLog();
  const entry = createAuditEvent(transactionId, step, details);
  entries.push({ ...entry, step }); // `step` preserves compatibility with earlier audit readers.
  writeLog(entries);
  recordAuditEvent(entry);
  return entry;
}

/**
 * Get the full audit trail for one transaction, in order.
 */
export function getTrail(transactionId) {
  return readLog().filter(e => e.transactionId === transactionId);
}

/**
 * Get every transaction id that has been logged (for a dashboard/listing view).
 */
export function listTransactionIds() {
  const entries = readLog();
  return [...new Set(entries.map(e => e.transactionId))];
}

/** Remove only explicitly scoped demo evidence; normal transaction history stays intact. */
export function clearTrails(transactionIds = []) {
  const ids = new Set(transactionIds);
  if (ids.size === 0) return 0;
  const entries = readLog();
  const retained = entries.filter(entry => !ids.has(entry.transactionId));
  writeLog(retained);
  return entries.length - retained.length;
}
