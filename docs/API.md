# API reference

The browser application is the primary client. These endpoints are documented to make review and local testing easier.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/message` | Drives the shopping conversation and returns the latest transaction state. |
| `GET /api/state/:sessionId` | Returns the current or most recently completed read-only transaction state. |
| `GET /api/mandate/:sessionId` | Returns mandate rules and remaining daily capacity. |
| `GET /api/transactions/:sessionId` | Lists completed transactions for the current local session. |
| `POST /api/payment/verify` | Verifies the Razorpay Checkout signature and finalizes a successful online payment. |
| `POST /api/payment/cancelled` | Safely returns an abandoned checkout to payment selection. |
| `POST /api/refund` | Requests reversal for a completed test transaction. |
| `GET /api/timeline/:transactionId` | Builds a timeline from append-only audit events. |
| `GET /api/replay/:transactionId` | Reconstructs read-only evidence; it never executes a payment. |
| `GET /api/audit/:transactionId.pdf` | Returns a redacted audit PDF. |
| `GET /track/:transactionId` | Returns a clearly labelled local TEST-mode delivery status page. |
| `POST /api/attack` | Runs one registered Security Lab test. |
| `POST /api/security/suite` | Runs the full safe Security Lab suite. |

Input validation is enforced server-side. IDs, amounts, actions, and structured bodies are checked before the application reads or changes transaction state.
