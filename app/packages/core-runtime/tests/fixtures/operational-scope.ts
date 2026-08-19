import { Effect } from 'effect';
import type { OperationalScopeResolverService } from '../../src/operations/context.ts';
import { preserveSystemPrincipalContextTrust } from '../../src/auth/system-principal-context-provenance.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

/** Explicit test seam for suites whose subject is downstream of persisted scope revalidation. */
export const testOperationalScopeResolver: OperationalScopeResolverService = {
  resolve: ({ correlationId, principal, traceId }) =>
    Effect.succeed(
      preserveSystemPrincipalContextTrust(
        principal,
        Object.freeze(
          withOptionalProperty(
            {
              ...principal,
              correlationId,
            },
            !(traceId === undefined),
            'traceId',
            traceId,
            {},
          ),
        ),
      ),
    ),
};
