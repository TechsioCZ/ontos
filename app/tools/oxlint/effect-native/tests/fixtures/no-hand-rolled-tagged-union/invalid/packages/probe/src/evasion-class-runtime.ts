// expect-count: 1
// Verbatim shape of packages/core-runtime/src/actions/runtime.ts:209-216, which the rule misses even
// though it reports the `ActionCommitOpen` interface 70 lines above it in the same file.
export class TransactionBridgeFailure<Original> {
  readonly _tag = 'TransactionBridgeFailure';
  readonly original: Original;

  constructor(original: Original) {
    this.original = original;
  }
}
