import { TrustedPrincipalContextSchema, loadDatabaseConnectionPair } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import {
  RegisteredGatewayRouteScopeSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
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
import { symmyImportJobs, symmyIntegrationRelations, symmyJobEffects, symmyJobRoutes } from '../../src/db/schema.ts';
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
  'looks up qualified sources with UTF-16 hash parity and recovers only exact jobs after selector replacement',
  () =>
    Effect.gen(function* qualifiedSelectors() {
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const admin = yield* openDatabase(connections.admin.connectionString);
      const scope = scopeFor(crypto.randomUUID(), crypto.randomUUID());
      const legalEntityId = Schema.decodeUnknownSync(RegisteredGatewayRouteScopeSchema.fields.legalEntityId)(
        crypto.randomUUID(),
      );
      const companyScope = { ...scope, legalEntityId };
      const logicalRouteId = crypto.randomUUID();
      const targetId = crypto.randomUUID();
      yield* Effect.addFinalizer(() =>
        admin
          .delete(symmyJobEffects)
          .where(eq(symmyJobEffects.tenantId, scope.tenantId))
          .pipe(
            Effect.andThen(admin.delete(symmyImportJobs).where(eq(symmyImportJobs.tenantId, scope.tenantId))),
            Effect.andThen(admin.delete(symmyJobRoutes).where(eq(symmyJobRoutes.tenantId, scope.tenantId))),
            Effect.orDie,
          ),
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
            legalEntityId,
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
      const read = (code: string, caller = scope, replayIdempotencyKey?: string) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* readContext() {
            const executor = yield* installOperationalScope(transaction, caller);
            const store = yield* symmyJobStoreFactory(executor, caller);
            const input = { code, routeKey: 'priceListPricesBatch' as const };
            if (replayIdempotencyKey !== undefined) {
              Object.assign(input, { replayIdempotencyKey });
            }
            return yield* store.routeContext(input);
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
      const [first] = fixtures;
      const idempotencyKey = 'exact-retained-price-list';
      const admit = (caller = companyScope, key = idempotencyKey) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* admitSelectedJob() {
            const executor = yield* installOperationalScope(transaction, caller);
            const store = yield* symmyJobStoreFactory(executor, caller);
            return yield* store.admit({
              code: first.routeCode,
              fixtureId: 'selector-fixture',
              idempotencyKey: key,
              routeKey: 'priceListPricesBatch',
            });
          }),
        );
      const accepted = yield* admit();
      yield* admin
        .update(symmyJobRoutes)
        .set({ active: false, principalId: crypto.randomUUID() })
        .where(eq(symmyJobRoutes.routeId, first.physicalRouteId));
      const replacementRouteId = crypto.randomUUID();
      yield* admin.insert(symmyJobRoutes).values({
        active: true,
        fixtureIds: ['selector-fixture'],
        legalEntityId,
        mappingVersion: 'physical-map-2',
        principalId: scope.principalId,
        routeCode: first.routeCode,
        routeId: replacementRouteId,
        routeKey: 'priceListPricesBatch',
        routeRevision: 'physical-2',
        tenantId: scope.tenantId,
      });
      const code = encodeSymmySourceSelector(
        { ...first.source, routeId: logicalRouteId, selectorKind: 'PRICE_GROUP', tenantId: scope.tenantId },
        first.source.sourceRecordId,
        targetId,
      );
      const retained = yield* read(code, scope, idempotencyKey);
      expect(retained).toMatchObject({
        allowedOwnerOperations: [],
        issuerId: first.source.issuerId,
        resolvedCode: first.routeCode,
        routeId: replacementRouteId,
        selector: { source: { sourceRecordId: first.source.sourceRecordId } },
      });
      expect(retained.replayIdempotencyDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(yield* admit()).toMatchObject({ inserted: false, jobId: accepted.jobId });
      expect(yield* Effect.flip(read(code, scope, 'fresh-key'))).toMatchObject({ code: 'route_denied' });
      expect(
        yield* Effect.flip(read(code, scopeFor(scope.tenantId, crypto.randomUUID()), idempotencyKey)),
      ).toMatchObject({ code: 'route_denied' });

      const [registered] = yield* admin
        .select({ fixturePlan: symmyJobRoutes.fixturePlan })
        .from(symmyJobRoutes)
        .where(eq(symmyJobRoutes.routeId, first.physicalRouteId));
      const template = yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)(registered?.fixturePlan);
      const currentSource = { ...first.source, sourceRecordId: 'replacement-price-group' };
      const currentSourceRouteId = crypto.randomUUID();
      const currentTemplate = yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)({
        ...template,
        selector: {
          kind: 'PRICE_GROUP',
          source: {
            ...currentSource,
            entityKind: 'PriceGroup',
            route: { integrationRouteId: currentSourceRouteId, tenantId: scope.tenantId },
          },
          target: template.selector?.target,
        },
        sourceMappingVersion: 'logical-map-2',
        sourceRouteId: currentSourceRouteId,
        sourceRouteRevision: 'logical-2',
      });
      yield* admin
        .update(symmyJobRoutes)
        .set({ fixturePlan: currentTemplate })
        .where(eq(symmyJobRoutes.routeId, replacementRouteId));

      const exact = yield* read(code, scope, idempotencyKey);
      expect(exact).toMatchObject({
        allowedOwnerOperations: [],
        legalEntityId,
        replayIdempotencyDigest: retained.replayIdempotencyDigest,
        resolvedCode: first.routeCode,
        routeId: replacementRouteId,
        selector: { source: { sourceRecordId: first.source.sourceRecordId } },
        sourceMappingVersion: 'logical-map-2',
        sourceRouteId: currentSourceRouteId,
        sourceRouteRevision: 'logical-2',
      });
      const exactScope = trustVerifiedGatewayPrincipalContext(
        { ...companyScope, authenticationNamespaceId: 'internal.symmy.test' },
        'a'.repeat(64),
        undefined,
        undefined,
        undefined,
        yield* Schema.decodeUnknownEffect(RegisteredGatewayRouteScopeSchema)({
          ...exact,
          operations: [{ entrypointKey: 'integration.symmy.admit-symmy-job', schemaVersion: '1' }],
          principalId: scope.principalId,
          routeKey: 'priceListPricesBatch',
        }),
      );
      expect(yield* admit(exactScope)).toMatchObject({ inserted: false, jobId: accepted.jobId });
      expect(yield* Effect.flip(admit(exactScope, 'fresh-key'))).toMatchObject({ code: 'route_denied' });
      expect(yield* Effect.flip(read(code, scope, 'fresh-key'))).toMatchObject({ code: 'route_denied' });
      expect(
        yield* Effect.flip(read(code, scopeFor(scope.tenantId, crypto.randomUUID()), idempotencyKey)),
      ).toMatchObject({ code: 'route_denied' });
      expect(
        yield* Effect.flip(read(code, scopeFor(crypto.randomUUID(), scope.principalId), idempotencyKey)),
      ).toMatchObject({ code: 'route_denied' });

      const currentCode = encodeSymmySourceSelector(
        { ...currentSource, routeId: currentSourceRouteId, selectorKind: 'PRICE_GROUP', tenantId: scope.tenantId },
        currentSource.sourceRecordId,
        targetId,
      );
      const current = yield* read(currentCode, scope, 'fresh-key');
      expect(current.replayIdempotencyDigest).toBeUndefined();
      expect(current.allowedOwnerOperations).toHaveLength(1);

      yield* admin
        .update(symmyJobRoutes)
        .set({ legalEntityId: crypto.randomUUID() })
        .where(eq(symmyJobRoutes.routeId, replacementRouteId));
      expect(yield* Effect.flip(read(code, scope, idempotencyKey))).toMatchObject({ code: 'route_denied' });
      expect(yield* Effect.flip(admit(exactScope))).toMatchObject({ code: 'route_denied' });
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
  30_000,
);
