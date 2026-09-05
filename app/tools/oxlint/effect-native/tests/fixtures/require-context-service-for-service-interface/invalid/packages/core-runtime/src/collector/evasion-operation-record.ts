// expect-count: 1
import { Effect } from 'effect';

/** Audit B4's "symbol-slotted operation records": the effectful ops sit one level inside the member. */
export interface CollectorOperationsGateway {
  readonly operations: {
    readonly record: (event: string) => Effect.Effect<void, Error>;
    readonly flush: () => Effect.Effect<void>;
  };
}

export const flushCollector = (gateway: CollectorOperationsGateway): Effect.Effect<void> =>
  gateway.operations.flush();
