/** Explicit, small transaction state machine used by reliability checks. */
export const TRANSACTION_STATE = Object.freeze({
  CREATED: 'CREATED', INTENT_PARSED: 'INTENT_PARSED', NEGOTIATING: 'NEGOTIATING',
  DEAL_CREATED: 'DEAL_CREATED', EVALUATING: 'EVALUATING', AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  PAYMENT_READY: 'PAYMENT_READY', PAYMENT_PROCESSING: 'PAYMENT_PROCESSING', SUCCESS: 'SUCCESS',
  BLOCKED: 'BLOCKED', REJECTED: 'REJECTED', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED',
  FAILED: 'FAILED', RECOVERY_REQUIRED: 'RECOVERY_REQUIRED'
});

const allowed = new Map([
  ['CREATED', ['INTENT_PARSED', 'CANCELLED', 'REJECTED']],
  ['INTENT_PARSED', ['NEGOTIATING', 'BLOCKED', 'CANCELLED']],
  ['NEGOTIATING', ['DEAL_CREATED', 'REJECTED', 'CANCELLED', 'EXPIRED']],
  ['DEAL_CREATED', ['EVALUATING', 'BLOCKED', 'EXPIRED']],
  ['EVALUATING', ['AWAITING_APPROVAL', 'PAYMENT_READY', 'BLOCKED', 'REJECTED']],
  ['AWAITING_APPROVAL', ['PAYMENT_READY', 'CANCELLED', 'EXPIRED', 'BLOCKED']],
  ['PAYMENT_READY', ['PAYMENT_PROCESSING', 'CANCELLED', 'BLOCKED', 'EXPIRED']],
  ['PAYMENT_PROCESSING', ['SUCCESS', 'FAILED', 'RECOVERY_REQUIRED']],
  ['RECOVERY_REQUIRED', ['PAYMENT_READY', 'SUCCESS', 'FAILED']],
  ['SUCCESS', []], ['BLOCKED', []], ['REJECTED', []], ['CANCELLED', []], ['EXPIRED', []], ['FAILED', []]
]);

export class InvalidTransactionTransitionError extends Error {
  constructor(from, to) {
    super(`Cannot transition transaction from ${from} to ${to}`);
    this.code = 'INVALID_TRANSACTION_STATE';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from, to) { return (allowed.get(from) || []).includes(to); }

export class TransactionStateMachine {
  constructor(initial = TRANSACTION_STATE.CREATED) {
    if (!allowed.has(initial)) throw new InvalidTransactionTransitionError('UNKNOWN', initial);
    this.state = initial;
    this.history = [{ state: initial, at: new Date().toISOString() }];
  }

  transition(next) {
    if (!canTransition(this.state, next)) throw new InvalidTransactionTransitionError(this.state, next);
    this.state = next;
    this.history.push({ state: next, at: new Date().toISOString() });
    return this.state;
  }

  get terminal() { return (allowed.get(this.state) || []).length === 0; }
}
