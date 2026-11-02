import { Effect, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import type { ActionServicePreparationContext } from '../../src/actions/context.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { prepareIdentityNamespaceAuthorization } from '../../src/auth/external-identity/namespace-action-preparation.ts';
import { insideDatabaseTransaction, refuseInsideDatabaseTransaction } from '../../src/db/transaction-io-guard.ts';
import { ContextAccess } from '../../src/permissions/context-access.ts';
import type { ContextAccessService } from '../../src/permissions/context-access.ts';

const namespace = 'test.namespace-preparation';
const context: ActionServicePreparationContext = {
  actionInvocationId: '10000000-0000-4000-8000-000000000001',
  compositionRevision: 'a'.repeat(64),
  scope: {
    ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authBindingId: '10000000-0000-4000-8000-000000000002',
      authContextRef: 'test:namespace-preparation',
      authenticationNamespaceId: 'core.shell',
      authMethod: 'api_key',
      principalId: '10000000-0000-4000-8000-000000000003',
      tenantId: '10000000-0000-4000-8000-000000000004',
    }),
    correlationId: 'namespace-preparation',
  },
  transaction: () => Effect.die('This authorization observation must not use SQL'),
};

const unused = () => Effect.succeed([]);
const access = (decision: 'allowed' | 'denied' | 'unavailable'): ContextAccessService => ({
  identityNamespaces: ({ authenticationNamespaceIds, principalId, tenantId }) =>
    refuseInsideDatabaseTransaction('spicedb', 'TEST namespace authorization').pipe(
      Effect.andThen(
        Effect.sync(() => {
          expect(authenticationNamespaceIds).toEqual([namespace]);
          expect(principalId).toBe(context.scope.principalId);
          expect(tenantId).toBe(context.scope.tenantId);
          return [{ decision, key: namespace }];
        }),
      ),
    ),
  legalEntities: unused,
  modules: unused,
  resources: unused,
  tenants: unused,
});

it.effect('observes exact namespace authority outside SQL and binds a database-only validator', () =>
  Effect.gen(function* exactNamespaceAuthority() {
    const prepared = yield* prepareIdentityNamespaceAuthorization(namespace, context).pipe(
      Effect.provideService(ContextAccess, access('allowed')),
    );
    yield* prepared.bind(context.scope, context.compositionRevision).pipe(insideDatabaseTransaction('TEST'));
    yield* prepared.authorizeNamespace(namespace).pipe(insideDatabaseTransaction('TEST'));
    expect(yield* prepared.authorizeNamespace('other.namespace').pipe(Effect.flip)).toMatchObject({
      code: 'identity_unavailable',
    });
  }),
);

it.effect('expires at the exclusive preparation boundary even inside the final SQL gate', () =>
  Effect.gen(function* exclusiveNamespaceDeadline() {
    const prepared = yield* prepareIdentityNamespaceAuthorization(namespace, context).pipe(
      Effect.provideService(ContextAccess, access('allowed')),
    );
    yield* TestClock.adjust('29999 millis');
    yield* prepared.bind(context.scope, context.compositionRevision).pipe(insideDatabaseTransaction('TEST'));
    yield* TestClock.adjust('1 millis');
    expect(yield* prepared.authorizeNamespace(namespace).pipe(Effect.flip)).toMatchObject({
      code: 'identity_unavailable',
    });
    expect(yield* prepared.bind(context.scope, context.compositionRevision).pipe(Effect.flip)).toMatchObject({
      code: 'operation_context_unavailable',
    });
  }),
);

it.effect('rejects another principal, Tenant, authentication binding, correlation, or composition', () =>
  Effect.gen(function* mismatchedNamespaceContext() {
    const prepared = yield* prepareIdentityNamespaceAuthorization(namespace, context).pipe(
      Effect.provideService(ContextAccess, access('allowed')),
    );
    for (const scope of [
      { ...context.scope, principalId: '10000000-0000-4000-8000-000000000005' },
      { ...context.scope, tenantId: '10000000-0000-4000-8000-000000000006' },
      { ...context.scope, authBindingId: '10000000-0000-4000-8000-000000000007' },
      { ...context.scope, correlationId: 'another-invocation' },
    ]) {
      expect(yield* prepared.bind(scope, context.compositionRevision).pipe(Effect.flip)).toMatchObject({
        code: 'operation_context_unavailable',
      });
    }
    expect(yield* prepared.bind(context.scope, 'b'.repeat(64)).pipe(Effect.flip)).toMatchObject({
      code: 'operation_context_unavailable',
    });
  }),
);

for (const decision of ['denied', 'unavailable'] as const) {
  it.effect(`preserves the ${decision} namespace observation without granting a prepared validator`, () =>
    Effect.gen(function* refusedNamespaceObservation() {
      expect(
        yield* prepareIdentityNamespaceAuthorization(namespace, context).pipe(
          Effect.provideService(ContextAccess, access(decision)),
          Effect.flip,
        ),
      ).toMatchObject({
        code: decision === 'denied' ? 'identity_forbidden' : 'identity_unavailable',
      });
    }),
  );
}
