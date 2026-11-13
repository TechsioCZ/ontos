import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { ProviderBindingRouteKeySchema } from '../../shared/apis/provider-binding-route.ts';
import { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { GatewayMerchantIdentity, GatewayProviderAccountRef } from '../../shared/domain/psp-configuration.ts';
import { pspBindingPersistenceForTransaction } from '../../src/persistence/psp-binding-persistence.ts';
import {
  pspBindingRouteKeyReaderForTransaction,
  pspBindingRouteReaderForTransaction,
} from '../../src/persistence/psp-binding-route-persistence.ts';
import { testNotificationRouteOf } from '../support/route-scope.fixture.ts';
import {
  makeTestScope,
  operationalScopeOf,
  paymentTestRelations,
  provenanceFor,
  randomUuid,
} from './database-fixture.ts';
import type { PaymentTestDatabase, PaymentTestScope } from './database-fixture.ts';

/**
 * #1157 / #1153 native evidence for provider binding routes on the worktree PostgreSQL, as the shared runtime
 * role under forced RLS: a route key resolves only inside its own Tenant (any of its Legal Entities), a retired
 * binding keeps resolving, and an owner Action reads a binding's route only in its own Selling Legal Entity.
 */

type PaymentTestTransaction = Parameters<Parameters<PaymentTestDatabase['transaction']>[0]>[0];

const nativeDatabase = Effect.gen(function* nativeDatabase() {
  const { runtime: runtimeClient } = yield* testDatabaseClients;
  return yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
});

/** The route Read's Core scope: the Tenant only, never a Legal Entity. */
const tenantScopeOf = (scope: PaymentTestScope): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: scope.principalId,
    authContextRef: 'api-key:payment-binding-route-tests',
    authMethod: 'api_key',
    principalId: scope.principalId,
    tenantId: scope.tenantId,
  }),
  correlationId: 'payment-binding-route-tests',
});

const inScope = <Value, Failure>(
  database: PaymentTestDatabase,
  scope: OperationalScope,
  operation: (transaction: Effect.Success<ReturnType<typeof installOperationalScope>>) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction: PaymentTestTransaction) =>
    installOperationalScope(transaction, scope).pipe(Effect.flatMap(operation)),
  );

const resolveKey = (database: PaymentTestDatabase, scope: OperationalScope, routeKey: string) =>
  inScope(database, scope, (transaction) =>
    Schema.decodeUnknownEffect(ProviderBindingRouteKeySchema)(routeKey).pipe(
      Effect.orDie,
      Effect.flatMap((key) => pspBindingRouteKeyReaderForTransaction(transaction).resolveRouteKey(key)),
    ),
  );

const routeOfBinding = (database: PaymentTestDatabase, scope: PaymentTestScope, bindingId: string) =>
  inScope(database, operationalScopeOf(scope), (transaction) =>
    pspBindingRouteReaderForTransaction(transaction).readRouteOfBinding(bindingId),
  );

const GOPAY: GatewayMerchantIdentity = { _tag: 'GOPAY', goid: '8123456789' };

/** One binding of the scope with its Payment-issued route, through the binding owner persistence. */
const createBinding = Effect.fn('PspBindingRouteTest.createBinding')(function* createBinding(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  input: { readonly merchantIdentity?: GatewayMerchantIdentity; readonly replaces?: GatewayProviderAccountRef } = {},
) {
  const merchantIdentity = input.merchantIdentity ?? GOPAY;
  const route = testNotificationRouteOf(scope.tenantId, merchantIdentity._tag);
  const provenance = yield* provenanceFor(scope);
  const created = yield* inScope(database, operationalScopeOf(scope), (transaction) =>
    pspBindingPersistenceForTransaction(transaction).createBinding({
      environment: 'SANDBOX',
      merchantIdentity,
      provenance,
      reason: 'Configure the sandbox gateway account',
      replaces: Option.fromUndefinedOr(input.replaces).pipe(
        Option.map((providerAccountRef) => ({ expectedRevision: 1, providerAccountRef })),
      ),
      route,
      secretRef: 'gopay-sandbox-1',
    }),
  );
  return { created, route };
});

describe('#1157 provider binding route resolution under RLS', () => {
  it.live('#1157 a route key resolves in its own Tenant, across its Legal Entities, and nowhere else', () =>
    Effect.scoped(
      Effect.gen(function* tenantIsolation() {
        const database = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const { created, route } = yield* createBinding(database, scope);

        const resolved = yield* resolveKey(database, tenantScopeOf(scope), route.routeKey);
        expect(resolved).toEqual(
          Option.some({
            bindingId: created.binding.view.bindingId,
            bindingRef: created.binding.view.providerAccountRef,
            bindingStatus: 'CURRENT',
            environment: 'SANDBOX',
            legalEntityId: scope.legalEntityId,
            providerFamily: 'GOPAY',
            routeRevision: 1,
            tenantId: scope.tenantId,
          }),
        );

        // Another Tenant does not see the key: the same answer as an unknown key.
        const other = yield* makeTestScope;
        expect(Option.isNone(yield* resolveKey(database, tenantScopeOf(other), route.routeKey))).toBe(true);
        expect(Option.isNone(yield* resolveKey(database, tenantScopeOf(scope), 'A'.repeat(43)))).toBe(true);

        // Another Legal Entity of the same Tenant resolves to its own Legal Entity, from the route answer only.
        const sibling = { ...scope, legalEntityId: yield* randomUuid };
        const siblingRoute = yield* createBinding(database, sibling);
        const siblingResolved = yield* resolveKey(database, tenantScopeOf(scope), siblingRoute.route.routeKey);
        expect(siblingResolved.pipe(Option.map((answer) => answer.legalEntityId))).toEqual(
          Option.some(sibling.legalEntityId),
        );

        // The resolution refuses a Legal Entity scope: the Read never takes a company.
        const scoped = yield* resolveKey(database, operationalScopeOf(scope), route.routeKey).pipe(Effect.flip);
        expect(Schema.is(PaymentUnavailable)(scoped)).toBe(true);
      }),
    ),
  );

  it.live('#1157 a retired binding still resolves, with its status', () =>
    Effect.scoped(
      Effect.gen(function* retiredResolves() {
        const database = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const original = yield* createBinding(database, scope);
        // A replacement retires the original for new intents; both routes stay addressable.
        const replacement = yield* createBinding(database, scope, {
          merchantIdentity: { _tag: 'GOPAY', goid: '8000000002' },
          replaces: original.created.binding.view.providerAccountRef,
        });
        const [retired, current] = yield* Effect.all(
          [
            resolveKey(database, tenantScopeOf(scope), original.route.routeKey),
            resolveKey(database, tenantScopeOf(scope), replacement.route.routeKey),
          ],
          { concurrency: 1 },
        );
        expect(retired.pipe(Option.map((answer) => [answer.bindingId, answer.bindingStatus]))).toEqual(
          Option.some([original.created.binding.view.bindingId, 'RETIRED_FOR_NEW_INTENTS']),
        );
        expect(current.pipe(Option.map((answer) => [answer.bindingId, answer.bindingStatus]))).toEqual(
          Option.some([replacement.created.binding.view.bindingId, 'CURRENT']),
        );
      }),
    ),
  );

  it.live('#1153 an owner Action reads a binding route only in its own Selling Legal Entity', () =>
    Effect.scoped(
      Effect.gen(function* ownerRecheckScope() {
        const database = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const { created } = yield* createBinding(database, scope);
        const { bindingId, providerAccountRef } = created.binding.view;
        expect(yield* routeOfBinding(database, scope, bindingId)).toEqual(
          Option.some({
            bindingId,
            environment: 'SANDBOX',
            providerAccountRef,
            providerFamily: 'GOPAY',
            routeRevision: 1,
          }),
        );
        const sibling = { ...scope, legalEntityId: yield* randomUuid };
        expect(Option.isNone(yield* routeOfBinding(database, sibling, bindingId))).toBe(true);
        const other = yield* makeTestScope;
        expect(Option.isNone(yield* routeOfBinding(database, other, bindingId))).toBe(true);
        expect(Option.isNone(yield* routeOfBinding(database, scope, yield* randomUuid))).toBe(true);
      }),
    ),
  );
});
