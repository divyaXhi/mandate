/** Per-transaction single-flight ledger: concurrent callers share one attempt. */
export class PaymentRecoveryRequiredError extends Error {
  constructor(transactionId) {
    super(`Payment state for ${transactionId} is uncertain; verify before retrying`);
    this.code = 'PAYMENT_RECOVERY_REQUIRED';
  }
}

export class PaymentAttemptLedger {
  constructor() { this.entries = new Map(); }
  get(id) { return this.entries.get(id) || null; }
  set(id, entry) { this.entries.set(id, entry); }
  delete(id) { this.entries.delete(id); }

  execute(transactionId, execute) {
    if (!transactionId) throw new Error('transactionId is required');
    const existing = this.get(transactionId);
    if (existing?.status === 'succeeded') return Promise.resolve({ ...existing.result, recovered: true });
    if (existing?.status === 'pending') return existing.promise;
    if (existing?.status === 'uncertain') throw new PaymentRecoveryRequiredError(transactionId);

    const promise = Promise.resolve().then(execute).then(result => {
      this.set(transactionId, { status: 'succeeded', result, ...result });
      return { ...result, recovered: false };
    }).catch(error => {
      this.set(transactionId, { status: error?.code === 'PAYMENT_RECOVERY_REQUIRED' ? 'uncertain' : 'failed', error: error.message });
      throw error;
    });
    this.set(transactionId, { status: 'pending', promise });
    return promise;
  }

  recovery(transactionId) {
    const entry = this.get(transactionId);
    if (!entry || entry.status === 'failed') return { status: 'SAFE_RETRY', paymentExecuted: false };
    if (entry.status === 'succeeded') return { status: 'RECOVERED', paymentExecuted: true, result: entry.result };
    return { status: 'RECOVERY_REQUIRED', paymentExecuted: null };
  }
}
