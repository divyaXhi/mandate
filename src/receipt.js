import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.join(__dirname, '..', 'public', 'receipts');

if (!fs.existsSync(RECEIPTS_DIR)) {
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
}

/**
 * Generate an order receipt PDF and save it to public/receipts/<transactionId>.pdf
 * (auto-served by Express's static middleware). Returns the public URL path.
 */
export function generateReceipt({ transactionId, item, cart, recipient, paymentMethod, orderId, amountInr, status }) {
  const filePath = path.join(RECEIPTS_DIR, `${transactionId}.pdf`);
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  // Header
  doc.fontSize(20).fillColor('#12100A').text('paymandate', { continued: false });
  doc.fontSize(10).fillColor('#666666').text('Order Receipt — Razorpay test-mode', { paragraphGap: 10 });
  doc.moveDown(1);
  doc.strokeColor('#CCCCCC').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(1);

  // Order meta
  doc.fontSize(11).fillColor('#12100A');
  doc.text(`Order ID: ${orderId}`);
  doc.text(`Transaction ID: ${transactionId}`);
  doc.text(`Date: ${new Date().toLocaleString('en-IN')}`);
  doc.text(`Payment method: ${paymentMethod === 'cod' ? 'Cash on Delivery' : 'Online (Razorpay)'}`);
  doc.text(`Final status: ${status || (paymentMethod === 'cod' ? 'COD order placed' : 'Payment captured')}`);
  doc.moveDown(1);

  // Item
  doc.fontSize(13).fillColor('#12100A').text('Item', { underline: true });
  doc.fontSize(11).moveDown(0.3);
  doc.text(item.name);
  doc.fillColor('#666666').text(`Sold by: ${item.merchant}`);
  doc.moveDown(1);

  // Price breakdown
  doc.fillColor('#12100A').fontSize(13).text('Price breakdown', { underline: true });
  doc.fontSize(11).moveDown(0.3);
  doc.text(`Base price: Rs. ${cart.pricing.basePriceInr}`);
  if (cart.pricing.crossBorderFeeInr) {
    doc.text(`Cross-border fee: Rs. ${cart.pricing.crossBorderFeeInr}`);
  }
  doc.fontSize(12).fillColor('#12100A').text(`Total paid: Rs. ${amountInr}`, { underline: false });
  doc.moveDown(1);

  // Delivery
  doc.fontSize(13).fillColor('#12100A').text('Delivery', { underline: true });
  doc.fontSize(11).moveDown(0.3);
  doc.text(`Estimated delivery: ${cart.deliveryEstimate?.label || 'Not available'}`);
  doc.text(`Deliver to: ${recipient.name}`);
  doc.text(`Address: ${recipient.address}${recipient.pincode ? ' - ' + recipient.pincode : ''}`);
  doc.text(`Phone: ${recipient.phone}`);
  if (recipient.email) doc.text(`Email: ${recipient.email}`);
  doc.moveDown(1.5);

  // Footer
  doc.strokeColor('#CCCCCC').moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.5);
  doc.fontSize(9).fillColor('#888888').text(
    'Need a refund or return? Open the paymandate chat and use the "Reverse / refund" button next to this order in Completed transactions.',
    { width: 495 }
  );

  doc.end();

  return `/receipts/${transactionId}.pdf`;
}
