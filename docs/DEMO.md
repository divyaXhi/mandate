# Demo guide

## Before you begin

```bash
npm install
cp .env.example .env
npm run demo
```

Open [http://localhost:3000](http://localhost:3000). The app works offline with local catalog and parser fallbacks. Configure Razorpay Test Mode keys only when demonstrating online checkout.

## Happy path

1. Ask for a product within your purchase limit.
2. Select a result and accept a negotiated offer if one is shown.
3. Inspect the exact deal; approve it in chat.
4. Add delivery details and select **Pay Online** or **Cash on Delivery**.
5. For online checkout, complete the hosted Razorpay Test Mode form.
6. Download the receipt and audit PDF after success.

## Policy block

Ask for or select a deal above the displayed per-purchase maximum. The application must show that the payment is blocked before Razorpay is contacted. Open **Inspect → Authorization** to see the rule and **Inspect → Audit** for the resulting evidence.

## Duplicate-payment protection

After a completed test transaction, open **Inspect → Security** and choose **Test duplicate-payment block**. The outcome must be blocked; a second payment is not created.

## What to show an evaluator

- The customer-first chat experience.
- The distinct Trust, Risk, Policy, Approval, and Payment Guard stages.
- The practical Security Lab result and its audit evidence.
- The read-only timeline and replay.
- The generated receipt and redacted audit PDF.

## Troubleshooting

- **Port 3000 is busy:** stop the old process, then rerun `npm run demo`.
- **Gemini or catalog lookup fails:** expected fallback behavior; local parsing and catalog data remain available.
- **Razorpay checkout does not open:** confirm Test Mode key ID and secret in `.env`, restart the server, and check internet access for Checkout.js.
- **Audit looks empty after checkout:** refresh the current application tab; completed transaction state is retained locally across reloads and tabs.
