import { Effect } from 'effect';
import type { OperationalScopeResolverShape } from '../../src/operations/context.ts';

/** Explicit test seam for suites whose subject is downstream of persisted scope revalidation. */
export const testOperationalScopeResolver: OperationalScopeResolverShape = {
  resolve: ({ correlationId, principal, traceId }) =>
    Effect.succeed(
      Object.freeze({
        ...principal,
        correlationId,
        ...(traceId === undefined ? {} : { traceId }),
      }),
    ),
};
