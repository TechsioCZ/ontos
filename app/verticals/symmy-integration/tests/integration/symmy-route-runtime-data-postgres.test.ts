import { TrustedPrincipalContextSchema, loadDatabaseConnectionPair } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq, inArray } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { SymmyRouteSettingsSchema } from '../../shared/actions/manage-symmy-routes.ts';
import type { SymmyManagedRouteKey } from '../../shared/actions/manage-symmy-routes.ts';
import {
  symmyIntegrationRelations,
  symmyJobRoutes,
  symmyRoutePriceReadSources,
  symmyRouteRetentionPolicies,
} from '../../src/db/schema.ts';
import { symmyPlannedRouteRow } from '../../src/ops/symmy-route-enrollment.ts';
import { symmyManagedRetentionPolicy, symmyManagedRouteRequest } from '../../src/ops/symmy-route-templates.ts';
import { symmyJobStoreFactory } from '../../src/persistence/symmy-job-store.ts';
import {
  readSymmyRetentionPolicies,
  writeSymmyPriceReadSource,
  writeSymmyRetentionPolicy,
} from '../../src/persistence/symmy-route-settings-store.ts';

const enrollment = defineDatabaseIdentityEnrollment([]);
const openDatabase = (connectionString: string) =>
  PgClient.makeClient({ url: Redacted.make(connectionString) }).pipe(
    Effect.flatMap((client) =>
      makeWithDefaults({ relations: symmyIntegrationRelations }).pipe(Effect.provideService(PgClient.PgClient, client)),
    ),
  );
const scopeFor = (
  tenantId: string,
  principalId: string,
  legalEntityId: string,
  authMethod: 'api_key' | 'session',
): OperationalScope => ({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: crypto.randomUUID(),
    authContextRef: `better-auth-${authMethod}:symmy-route-runtime-data`,
    authMethod,
    legalEntityId,
    principalId,
    tenantId,
  }),
  audience: 'symmy-integration',
  correlationId: 'symmy-route-runtime-data',
});
const source = { issuerId: 'symmy-runtime', sourceNamespace: 'runtime-erp' };

it.effect(
  'lets a tenant scope write only its own routes and route data, and reads retention and price sources from data',
  () =>
    Effect.gen(function* runtimeRouteData() {
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const admin = yield* openDatabase(connections.admin.connectionString);
      const runtime = yield* openDatabase(connections.runtime.connectionString);
      const tenantId = crypto.randomUUID();
      const otherTenantId = crypto.randomUUID();
      const legalEntityId = crypto.randomUUID();
      const integrationPrincipalId = crypto.randomUUID();
      const administrator = scopeFor(tenantId, crypto.randomUUID(), legalEntityId, 'session');
      const foreignAdministrator = scopeFor(otherTenantId, crypto.randomUUID(), legalEntityId, 'session');
      const integration = scopeFor(tenantId, integrationPrincipalId, legalEntityId, 'api_key');
      const managed = { legalEntityId, principalId: integrationPrincipalId, tenantId };
      const requestOf = (routeKey: SymmyManagedRouteKey, retentionDays?: number) =>
        Result.getOrThrow(
          symmyManagedRouteRequest({
            routeKey,
            scope: managed,
            settings: Schema.decodeUnknownSync(SymmyRouteSettingsSchema)(
              retentionDays === undefined ? { source } : { retentionDays, source },
            ),
          }),
        );
      const lists = requestOf('priceLists');
      const products = requestOf('productsBatch', 30);
      const rowOf = (request: typeof lists) => ({
        ...symmyPlannedRouteRow(request),
        fixturePlan: request.configuration,
        lifecyclePolicy: request.lifecyclePolicy ?? null,
      });
      yield* Effect.addFinalizer(() =>
        Effect.all(
          [
            admin.delete(symmyRoutePriceReadSources).where(eq(symmyRoutePriceReadSources.tenantId, tenantId)),
            admin.delete(symmyRouteRetentionPolicies).where(eq(symmyRouteRetentionPolicies.tenantId, tenantId)),
            admin.delete(symmyJobRoutes).where(inArray(symmyJobRoutes.tenantId, [tenantId, otherTenantId])),
          ],
          { concurrency: 1 },
        ).pipe(Effect.orDie),
      );
      const scoped = <A, E>(
        caller: OperationalScope,
        work: (executor: Effect.Success<ReturnType<typeof installOperationalScope>>) => Effect.Effect<A, E>,
      ) =>
        runtime.transaction((transaction) =>
          installOperationalScope(transaction, caller, enrollment).pipe(Effect.flatMap(work)),
        );

      // The administrator's Tenant scope enrolls through the runtime role; the trigger takes the change token.
      yield* scoped(administrator, (executor) =>
        Effect.gen(function* enroll() {
          yield* executor.insert(symmyJobRoutes).values([rowOf(lists), rowOf(products)]);
          yield* writeSymmyPriceReadSource(executor, lists, {
            ownerModuleId: 'external.symmy',
            sourceSystemRef: 'erp',
          });
          expect(
            yield* writeSymmyRetentionPolicy(
              executor,
              Result.getOrThrow(symmyManagedRetentionPolicy(products, managed, 30)),
            ),
          ).toBe(true);
        }),
      );
      const stored = yield* admin.select().from(symmyJobRoutes).where(eq(symmyJobRoutes.tenantId, tenantId));
      expect(stored).toHaveLength(2);
      expect(stored.every(({ changeToken }) => changeToken > 0)).toBe(true);

      // Another Tenant's administrator neither writes nor reads them.
      const foreignWrite = yield* scoped(foreignAdministrator, (executor) =>
        executor.insert(symmyJobRoutes).values({ ...rowOf(requestOf('adminProducts')), routeId: crypto.randomUUID() }),
      ).pipe(Effect.result);
      expect(Result.isFailure(foreignWrite)).toBe(true);
      const foreignPolicies = yield* scoped(foreignAdministrator, (executor) =>
        readSymmyRetentionPolicies(executor, { routeId: products.routeId, tenantId }),
      );
      expect(foreignPolicies).toEqual([]);

      const policyRow = Result.getOrThrow(symmyManagedRetentionPolicy(products, managed, 30));
      // Retention comes from the route data of its own Tenant.
      const policies = yield* scoped(administrator, (executor) =>
        readSymmyRetentionPolicies(executor, { routeId: products.routeId, tenantId }),
      );
      expect(policies.map(({ policyId, retentionMs, revision }) => ({ policyId, retentionMs, revision }))).toEqual([
        { policyId: 'symmy-productsBatch', retentionMs: 30 * 86_400_000, revision: '30d' },
      ]);
      // A policy revision never changes.
      const changed = yield* scoped(administrator, (executor) =>
        writeSymmyRetentionPolicy(executor, { ...policyRow, retentionMs: 1 }),
      );
      expect(changed).toBe(false);

      // The enrolled route is admitted with its price read source; a disabled one is refused.
      const context = () =>
        scoped(integration, (executor) =>
          symmyJobStoreFactory(executor, integration).pipe(
            Effect.flatMap((store) => store.routeContext({ routeKey: 'priceLists' })),
          ),
        );
      expect(yield* context()).toMatchObject({
        priceReadSourceSystem: { ownerModuleId: 'external.symmy', sourceSystemRef: 'erp' },
        routeId: lists.routeId,
      });
      yield* scoped(administrator, (executor) =>
        executor.update(symmyJobRoutes).set({ active: false }).where(eq(symmyJobRoutes.routeId, lists.routeId)),
      );
      expect(yield* Effect.flip(context())).toMatchObject({ code: 'route_denied' });
      const [deactivated] = yield* admin.select().from(symmyJobRoutes).where(eq(symmyJobRoutes.routeId, lists.routeId));
      expect(Option.fromUndefinedOr(deactivated).pipe(Option.map(({ active }) => active))).toEqual(Option.some(false));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);
