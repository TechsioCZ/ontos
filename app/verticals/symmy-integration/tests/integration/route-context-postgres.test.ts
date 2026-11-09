import { TrustedPrincipalContextSchema, loadDatabaseConnectionPair } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import { encodeSymmySourceSelector } from '../../shared/domain/symmy-source-selector.ts';
import { symmyIntegrationRelations, symmyJobRoutes } from '../../src/db/schema.ts';
import { symmyJobStoreFactory } from '../../src/persistence/symmy-job-store.ts';

const openDatabase = (connectionString: string) =>
  PgClient.makeClient({ url: Redacted.make(connectionString) }).pipe(
    Effect.flatMap((client) =>
      makeWithDefaults({ relations: symmyIntegrationRelations }).pipe(Effect.provideService(PgClient.PgClient, client)),
    ),
  );
const scopeFor = (tenantId: string, principalId: string): OperationalScope => ({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: crypto.randomUUID(),
    authContextRef: 'better-auth-api-key:selector-fixture',
    authMethod: 'api_key',
    principalId,
    tenantId,
  }),
  audience: 'symmy-integration',
  correlationId: 'selector-parity-fixture',
});

it.effect(
  'looks up three qualified sources sharing a target hint and preserves UTF-16 Unicode hash parity',
  () =>
    Effect.gen(function* qualifiedSelectors() {
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const admin = yield* openDatabase(connections.admin.connectionString);
      const scope = scopeFor(crypto.randomUUID(), crypto.randomUUID());
      const logicalRouteId = crypto.randomUUID();
      const targetId = crypto.randomUUID();
      yield* Effect.addFinalizer(() =>
        admin.delete(symmyJobRoutes).where(eq(symmyJobRoutes.tenantId, scope.tenantId)).pipe(Effect.orDie),
      );
      const fixtures = [
        { issuerId: 'issuer-a', sourceNamespace: 'catalog-a', sourceRecordId: 'opaque / source 👩🏽‍🔬 '.repeat(9).trim() },
        { issuerId: 'issuer-b', sourceNamespace: 'catalog-b', sourceRecordId: 'different-source' },
        { issuerId: 'issuer-c', sourceNamespace: 'catalog-c', sourceRecordId: '最後のソース😀' },
      ].map((source, index) => ({
        index,
        physicalRouteId: crypto.randomUUID(),
        routeCode: `operator-code-${index}`,
        source,
      }));
      yield* Effect.forEach(
        fixtures,
        ({ index, physicalRouteId, routeCode, source }) => {
          const sourceRef = {
            ...source,
            entityKind: 'PriceGroup',
            route: { integrationRouteId: logicalRouteId, tenantId: scope.tenantId },
          };
          const plan = Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
            items: [
              {
                effects: [
                  {
                    effectKey: 'price',
                    operation: {
                      entrypointKey: 'commerce.pricing.define-price',
                      moduleId: 'commerce.pricing',
                      schemaVersion: '1',
                    },
                  },
                ],
                itemKey: `item-${index}`,
                source: { ...source, entityKind: 'PriceGroup' },
              },
            ],
            selector: {
              kind: 'PRICE_GROUP',
              source: sourceRef,
              target: {
                moduleId: 'pricing.price-group-catalog',
                resourceId: targetId,
                resourceType: 'pricing.price-group-catalog.price-group',
                tenantId: scope.tenantId,
              },
            },
            sourceMappingVersion: 'logical-map-1',
            sourceRouteId: logicalRouteId,
            sourceRouteRevision: 'logical-1',
          });
          return admin.insert(symmyJobRoutes).values({
            active: true,
            fixtureIds: ['selector-fixture'],
            fixturePlan: plan,
            mappingVersion: 'physical-map-1',
            principalId: scope.principalId,
            routeCode,
            routeId: physicalRouteId,
            routeKey: 'priceListPricesBatch',
            routeRevision: 'physical-1',
            tenantId: scope.tenantId,
          });
        },
        { concurrency: 1 },
      );
      const runtime = yield* openDatabase(connections.runtime.connectionString);
      const read = (code: string, caller = scope) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* readContext() {
            const executor = yield* installOperationalScope(transaction, caller);
            const store = yield* symmyJobStoreFactory(executor, caller);
            return yield* store.routeContext({ code, routeKey: 'priceListPricesBatch' });
          }),
        );
      yield* Effect.forEach(
        fixtures,
        Effect.fn('SelectorFixture.verify')(function* verify({ physicalRouteId, routeCode, source }) {
          const selectorScope = {
            ...source,
            routeId: logicalRouteId,
            selectorKind: 'PRICE_GROUP' as const,
            tenantId: scope.tenantId,
          };
          const code = encodeSymmySourceSelector(selectorScope, source.sourceRecordId, targetId);
          const [native] = yield* admin
            .select({
              code: sql<string>`symmy_integration.symmy_source_selector_code(${scope.tenantId},${source.issuerId},${source.sourceNamespace},${logicalRouteId},'PRICE_GROUP',${source.sourceRecordId},${targetId})`,
            })
            .from(symmyJobRoutes)
            .where(eq(symmyJobRoutes.routeId, physicalRouteId));
          expect(native?.code).toBe(code);
          const result = yield* read(code);
          expect(result).toMatchObject({
            issuerId: source.issuerId,
            resolvedCode: routeCode,
            routeId: physicalRouteId,
            sourceMappingVersion: 'logical-map-1',
            sourceRouteId: logicalRouteId,
            sourceRouteRevision: 'logical-1',
          });
          expect(yield* Effect.flip(read(code, scopeFor(scope.tenantId, crypto.randomUUID())))).toMatchObject({
            code: 'route_denied',
          });
          const foreignCode = encodeSymmySourceSelector(
            { ...selectorScope, tenantId: crypto.randomUUID() },
            source.sourceRecordId,
            targetId,
          );
          expect(yield* Effect.flip(read(foreignCode))).toMatchObject({ code: 'route_denied' });
        }),
        { concurrency: 1 },
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
  30_000,
);
