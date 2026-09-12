import { ActionPermissionCheckError, makeActionAuthorizationPreflightPermit } from '../../src/index.ts';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

const permitInput = {
  actionInvocationId: '70000000-0000-4000-8000-000000000001',
  actionKey: 'commerce.customer-context.claim-counterparty-access-invitation',
  principalId: '50000000-0000-4000-8000-000000000001',
} as const;

it.effect('consumes an invocation-bound preflight permit once', () =>
  Effect.gen(function* oneShotPreflightPermit() {
    const permit = makeActionAuthorizationPreflightPermit(permitInput);
    yield* permit.consume;
    const replay = yield* Effect.flip(permit.consume);
    expect(Schema.is(ActionPermissionCheckError)(replay)).toBe(true);
  }),
);

it('does not expose proof material in the permit identity', () => {
  const permit = makeActionAuthorizationPreflightPermit(permitInput);
  expect(JSON.stringify(permit)).not.toContain('secret');
  expect(JSON.stringify(permit)).not.toContain('raw');
});
