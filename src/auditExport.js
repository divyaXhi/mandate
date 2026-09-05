import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDITS_DIR = path.join(__dirname, '..', 'public', 'audits');
if (!fs.existsSync(AUDITS_DIR)) fs.mkdirSync(AUDITS_DIR, { recursive: true });

const SENSITIVE = /(otp|secret|token|password|signature|api.?key|authorization|payment.?id)/i;
const LABELS = {
  intent_parsed: 'User request understood', catalog_source: 'Catalog searched', candidates_scored: 'Products evaluated',
  item_selected: 'Product selected', negotiation_offered: 'Negotiation offered', NEGOTIATION_STARTED: 'Negotiation started',
  OFFER_CREATED: 'Seller offer created', OFFER_ACCEPTED: 'Seller offer accepted', FINAL_DEAL_CREATED: 'Final deal recorded',
  DEAL_VALIDATED: 'Deal validated', DECISION_EVALUATED: 'Authorization decision evaluated', cart_pending_approval: 'Approval requested',
  user_approved: 'User approval recorded', payment_guard_passed: 'Payment Guard passed', payment_guard_blocked: 'Payment Guard blocked',
  razorpay_order_created: 'Razorpay TEST order created', payment_captured: 'Online payment captured', cod_confirmed: 'COD confirmed',
  receipt_generated: 'Receipt generated', payment_cancelled: 'Payment cancelled', payment_blocked: 'Payment blocked',
  blocked_by_policy: 'Policy blocked transaction', blocked_low_confidence: 'Trust checks blocked transaction'
};

export function redactAudit(value, key = '') {
  if (SENSITIVE.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => redactAudit(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAudit(v, k)]));
  return value;
}

export function publicAuditTrail(transactionId, trail) {
  return { transactionId, generatedAt: new Date().toISOString(), events: trail.map(event => ({
    timestamp: event.timestamp, event: event.step || event.event,
    label: LABELS[event.step || event.event] || 'Transaction event', details: redactAudit(event.details || {})
  })) };
}

export async function generateAuditPdf(transactionId, trail) {
  const filePath = path.join(AUDITS_DIR, `${transactionId}.pdf`);
  const report = publicAuditTrail(transactionId, trail);
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);
  doc.fontSize(20).fillColor('#12100A').text('PayMandate Audit Report');
  doc.fontSize(10).fillColor('#666666').text('Human-readable transaction evidence · secrets and credentials redacted');
  doc.moveDown().fontSize(11).fillColor('#12100A').text(`Transaction ID: ${transactionId}`).text(`Generated: ${new Date(report.generatedAt).toLocaleString('en-IN')}`);
  doc.moveDown().strokeColor('#CCCCCC').moveTo(50, doc.y).lineTo(545, doc.y).stroke().moveDown();
  for (const event of report.events) {
    doc.fontSize(12).fillColor('#12100A').text(event.label);
    doc.fontSize(9).fillColor('#666666').text(new Date(event.timestamp).toLocaleString('en-IN'));
    const detail = JSON.stringify(event.details);
    if (detail !== '{}') doc.fontSize(10).fillColor('#333333').text(detail, { width: 495 });
    doc.moveDown(0.8);
  }
  doc.fontSize(9).fillColor('#888888').text('This report explains recorded events. It cannot authorize, replay, or execute a payment.');
  doc.end();
  await new Promise((resolve, reject) => { stream.on('finish', resolve); stream.on('error', reject); });
  return `/audits/${transactionId}.pdf`;
}
