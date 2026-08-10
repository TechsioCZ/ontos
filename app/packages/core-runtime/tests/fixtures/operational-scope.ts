import { Effect } from 'effect';
import type { OperationalScopeResolverShape } from '../../src/operations/context.ts';
import { preserveSystemPrincipalContextTrust } from '../../src/auth/system-principal-context-provenance.ts';

/** Explicit test seam for suites whose subject is downstream of persisted scope revalidation. */
export const testOperationalScopeResolver: OperationalScopeResolverShape = {
  resolve: ({ correlationId, principal, traceId }) =>
    Effect.succeed(
      preserveSystemPrincipalContextTrust(
        principal,
        Object.freeze({
          ...principal,
          correlationId,
          ...(traceId === undefined ? {} : { traceId }),
        }),
      ),
    ),
};
