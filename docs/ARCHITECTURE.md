# Architecture

## Design principle

PayMandate separates **proposal** from **authority**. Mandate helps the user shop; PayMandate independently verifies the deal and controls whether it can move to payment.

```text
Browser
  │
  ├── Mandate chat and product selection
  └── Inspect: transaction, authorization, payment, audit, security
          │
Express API (`src/server.js`)
          │
          ├── Intent and catalog discovery
          ├── Negotiation protocol
          ├── Trust / Risk / Policy / Decision
          ├── Approval and Payment Guard
          ├── Razorpay Test Mode adapter
          └── Audit, trace, replay, receipt, tracking
```

## Transaction lifecycle

1. **Intent** — natural language becomes a bounded search request. It never supplies a price or payment authority.
2. **Discovery** — products, merchants, and prices come from catalog records or a clearly identified live source.
3. **Negotiation** — the Buyer and Merchant Agents exchange constrained offers. The backend re-derives the buyer ceiling and merchant floor on every turn.
4. **Deal validation** — the final deal is immutable and fingerprinted.
5. **Decision** — Trust, Risk, and Policy independently evaluate the same frozen facts; a canonical resolver produces Allow, Review, or Block.
6. **Approval** — only the user can approve the exact amount. Changes to purchase rules use a short-lived, single-use OTP proof.
7. **Payment Guard** — mandate, amount, decision, approval, freshness, idempotency, and rail readiness are checked immediately before payment.
8. **Execution and evidence** — Razorpay Test Mode signatures are verified on the server; receipt and audit evidence are generated only after a valid completion.

## Source ownership

| Area | Primary location | Responsibility |
| --- | --- | --- |
| HTTP orchestration | `src/server.js` | API validation, session orchestration, checkout callback |
| Intent and catalog | `src/agent.js`, `src/liveCatalog.js`, `src/llmIntent.js` | Bounded query understanding and product discovery |
| Negotiation | `src/negotiationEngine.js`, `src/agentIdentity.js` | Agent protocol and constraints |
| Decision | `src/decision/`, `src/trust/`, `src/risk/`, `src/policy/` | Independent evidence and canonical outcome |
| Approval and payment | `src/approvalGate.js`, `src/paymentGuard.js`, `src/paymentMandate.js` | User authority, revalidation, rail adapter |
| Evidence | `src/auditLog.js`, `src/observability/`, `src/auditExport.js` | Append-only evidence, trace, replay, exports |
| Runtime controls | `src/runtime/` | Request validation, transaction state machine, idempotency ledger |
| Browser app | `public/` | Shopping experience and read-only Inspect surfaces |

## Read-only evaluator views

Inspect surfaces do not call any endpoint that can approve, modify the mandate, or execute a payment. Normal Mode and Judge Mode only alter the amount of evidence shown. This makes the system observable without turning debugging views into a bypass.

## Runtime data

`data/catalog.json` is sample catalog data. `data/audit-log.json`, `data/customers.json`, generated receipts, and generated audit exports are local runtime artifacts and are ignored from source control and clean submission archives.
