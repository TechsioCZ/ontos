const scopedTransaction: unique symbol = Symbol('@app/core-runtime/db/scoped-transaction');

/** Private owner-factory capability marked nominally; the fields themselves are named. */
export interface ScopedTransactionExecutor {
  readonly delete: () => void;
  readonly insert: () => void;
  readonly [scopedTransaction]: true;
  readonly select: () => void;
  readonly update: () => void;
}
