import { OperationAuthenticationRequired } from '@app/core-runtime';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PRINCIPAL_AUTH_BINDING_NOT_CURRENT } from '../../shared/portal-auth-contracts.ts';

/**
 * `PRINCIPAL_AUTH_BINDING_NOT_CURRENT` is the Commerce-facing name for the outcome Core expresses
 * generically as `OperationAuthenticationRequired` when the acting Principal's Auth Binding is not
 * Current (see the constant's own JSDoc in `shared/portal-auth-contracts.ts` for the exact mapping
 * site: `api/portal-auth/admission/adapter.ts`'s `mapCoreFailure`). This test pins the literal
 * itself and confirms a Commerce caller can carry it as the `reason` on Core's real
 * `OperationAuthenticationRequired` shape without any decoding surprise, so a rename of either side
 * is caught here rather than only in prose.
 */
it('is the stable literal Commerce names for a not-Current Principal Auth Binding', () => {
  expect(PRINCIPAL_AUTH_BINDING_NOT_CURRENT).toBe('PRINCIPAL_AUTH_BINDING_NOT_CURRENT');
  expect(Schema.is(Schema.Literal(PRINCIPAL_AUTH_BINDING_NOT_CURRENT))(PRINCIPAL_AUTH_BINDING_NOT_CURRENT)).toBe(true);
});

it('round-trips as the reason on Core OperationAuthenticationRequired', () => {
  const failure = new OperationAuthenticationRequired({
    code: 'operation_authentication_required',
    reason: PRINCIPAL_AUTH_BINDING_NOT_CURRENT,
  });

  expect(Schema.is(OperationAuthenticationRequired)(failure)).toBe(true);
  expect(failure.reason).toBe(PRINCIPAL_AUTH_BINDING_NOT_CURRENT);
  expect(failure.code).toBe('operation_authentication_required');
});
