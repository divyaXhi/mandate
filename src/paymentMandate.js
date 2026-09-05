import Razorpay from 'razorpay';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

let razorpay = null;
const PAYMENT_TIMEOUT_MS = 10_000;

function withPaymentTimeout(operation) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PAYMENT_TIMEOUT')), PAYMENT_TIMEOUT_MS); })
  ]).finally(() => clearTimeout(timer));
}

// Keep the demo bootable without payment credentials. Razorpay is required
// only when an online order/refund is actually requested; COD and every
// negotiation/mandate screen remain usable in an offline judging setup.
function razorpayClient() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay test keys are not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env to use online payment.');
  }
  if (!razorpay) {
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });
  }
  return razorpay;
}

/** The publishable key_id — safe to send to the browser (Checkout.js needs it). Never expose key_secret. */
export function getRazorpayKeyId() {
  return process.env.RAZORPAY_KEY_ID;
}

/**
 * Execute payment for an APPROVED cart mandate only.
 * Hard guard: the amount charged can never exceed what was shown and approved
 * in the cart mandate — this is the actual "bounded" enforcement, not just a UI promise.
 *
 * @param {object} cartMandate - must have approved === true
 * @param {number} approvedAmountInr - the exact amount the user approved (from the cart shown to them)
 */
export async function executePayment(cartMandate, approvedAmountInr) {
  if (!cartMandate.approved) {
    throw new Error('BLOCKED: cannot execute payment — cart mandate was not approved by user');
  }

  if (cartMandate.pricing.totalInr > approvedAmountInr) {
    // This is the integrity check: if the price changed between approval and
    // execution (e.g. stock/price update), we refuse rather than silently overcharge.
    throw new Error(
      `BLOCKED: cart total (₹${cartMandate.pricing.totalInr}) exceeds approved amount (₹${approvedAmountInr}) — price mismatch detected`
    );
  }

  let order;
  try {
    order = await withPaymentTimeout(razorpayClient().orders.create({
      amount: cartMandate.pricing.totalInr * 100, // Razorpay expects paise
      currency: 'INR',
      notes: {
        item: cartMandate.item.name,
        merchant: cartMandate.item.merchant,
        crossBorder: String(cartMandate.isCrossBorder)
      }
    }));
  } catch (err) {
    // Razorpay's SDK throws errors shaped like { statusCode, error: { description, code } }
    // for validation failures, but auth-level rejections (bad/missing keys) often come back
    // as just { statusCode } with no body — cover both so failures are always legible.
    const description = err?.error?.description
      || (err?.statusCode ? `Razorpay API error (HTTP ${err.statusCode}) — check RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in .env` : null)
      || err?.message
      || 'Unknown Razorpay API error';
    throw new Error(description);
  }

  return {
    orderId: order.id,
    status: order.status,
    amountInr: cartMandate.pricing.totalInr
  };
}

/**
 * Verify a Razorpay Checkout payment signature — the actual proof that a
 * payment_id genuinely belongs to the order_id we created, and wasn't
 * fabricated client-side. Computed as HMAC-SHA256(order_id + "|" + payment_id)
 * using the account's key_secret, per Razorpay's documented verification scheme.
 * A payment is NEVER treated as successful without this check passing.
 */
export function verifyPaymentSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  if (!process.env.RAZORPAY_KEY_SECRET) return false;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  return expected === razorpay_signature;
}

/**
 * Reverse a completed transaction. Attempts a real Razorpay refund when a
 * paymentId is present (the normal case now that Checkout is wired up — see
 * server.js /api/payment/verify), falling back to a clearly-labeled simulated
 * reversal for COD orders or any order that somehow lacks a captured payment.
 */
export async function refundPayment(orderResult, reason) {
  if (orderResult.paymentId) {
    const refund = await razorpayClient().payments.refund(orderResult.paymentId, {
      amount: orderResult.amountInr * 100,
      notes: { reason }
    });
    return { simulated: false, refundId: refund.id, status: refund.status, amountInr: orderResult.amountInr, reason };
  }

  // Simulated reversal — no captured payment exists in this backend-only flow.
  return {
    simulated: true,
    refundId: `sim_refund_${orderResult.orderId}`,
    status: 'processed',
    amountInr: orderResult.amountInr,
    reason
  };
}
