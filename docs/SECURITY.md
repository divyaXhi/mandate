# Security model

## Financial authority boundary

Mandate is a shopping assistant. It can interpret requests, discover products, and participate in negotiation. It cannot approve a purchase, change the mandate, or access the payment rail. Those operations are server-owned.

## Controls

| Threat | Control |
| --- | --- |
| Prompt injection | Incoming messages are scanned, and the resulting conversation text never becomes a price or authorization source. |
| Price manipulation | The final amount is taken from a server-owned catalog/deal record and revalidated by Payment Guard. |
| Unsafe merchant | Trust signals and merchant facts feed the canonical decision before approval. |
| Mandate violation | Policy evaluates daily and per-purchase limits independently of Trust and Risk. |
| Unauthorized approval | Approval is explicit, amount-bound, and user-owned. |
| Stale deal | Deal fingerprint and mandate binding are revalidated before payment. |
| Duplicate payment | A transaction-bound idempotency ledger collapses retries and refuses a completed charge. |
| Payment callback forgery | Razorpay Checkout signatures are verified server-side with the account secret. |
| Network ambiguity | Payment attempts distinguish safe retry, recovery, and uncertain state. |

## Security Lab

Security Lab is not a separate mock workflow. Each test runs against the same policy, permission, revalidation, and payment-guard code used by a purchase. It is intentionally safe: attack tests produce evidence and blocked outcomes, not charges.

## Secrets

- Keep `.env` local and out of version control.
- Use Razorpay Test Mode keys during evaluation.
- Do not place API keys in browser JavaScript, audit exports, receipts, screenshots, or issues.
- Rotate any credential that may have been exposed.

## Production boundary

The repository demonstrates controls in a single-process local application. A production deployment must add authenticated sessions, multi-tenant data isolation, durable encrypted storage, secret management, webhooks with replay protection, structured operational logging, rate limiting, and independent security review.
