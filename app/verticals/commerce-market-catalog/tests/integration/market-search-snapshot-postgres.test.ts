import { CoreSearchProjectionUnavailable, CoreSearchWorkerSnapshot, findPostgresFailure } from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotService, CoreSearchWorkerSnapshotView } from '@app/core-runtime';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { sql } from 'drizzle-orm';
import { Effect, Exit, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { commerceMarketCatalogRelations, markets } from '../../src/database/schema.ts';
import { makeMarketSearchSource } from '../../src/services/market-search-source.ts';

const tenantId = 'e3470000-0000-4000-8000-000000000001';
const otherTenantId = 'e3470000-0000-4000-8000-000000000002';
const sellerId = 'e3470000-0000-4000-8000-000000000003';
const otherSellerId = 'e3470000-0000-4000-8000-000000000004';
const marketId = 'e3471000-0000-4000-8000-000000000001';
const otherMarketId = 'e3471000-0000-4000-8000-000000000002';
const otherTenantMarketId = 'e3471000-0000-4000-8000-000000000003';
const concurrentMarketId = 'e3471000-0000-4000-8000-000000000004';
const january = new Date('2020-01-01T00:00:00.000Z');
const june = new Date('2024-06-01T00:00:00.000Z');
const futureDefinition = new Date('2030-06-01T00:00:00.000Z');
const july = new Date('2030-07-01T00:00:00.000Z');
const august = new Date('2030-08-01T00:00:00.000Z');

type MarketDatabase = TestDatabaseFromClient<typeof commerceMarketCatalogRelations>;
type MarketTransaction = Parameters<Parameters<MarketDatabase['transaction']>[0]>[0];

const context = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: 'market-search-native-claim',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: 'commerce.market-catalog',
  deliveryId: 'market-search-native-delivery',
  domainEventId: 'market-search-native-event',
  messageId: 'market-search-native-message',
  producerModuleKey: 'commerce.market-catalog',
  tenantId,
  tenantSequenceNo: 3n,
  topic: 'commerce.market-catalog.market-created.v1',
  workerKey: 'commerce.market-catalog.project-market-created-to-search',
});

const snapshotUnavailable = (cause: unknown) =>
  new CoreSearchProjectionUnavailable({
    cause,
    code: 'core_search_projection_unavailable',
    reason: 'Native search snapshot failed',
  });

const noTenantScope = () => Effect.die('Market search must select a company');
const companyReadFor =
  (
    transaction: MarketTransaction,
    betweenCompanies: Effect.Effect<void>,
  ): CoreSearchWorkerSnapshotView['forLegalEntity'] =>
  (legalEntityId, readCompany) =>
    Effect.gen(function* readCompanySnapshot() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                   set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
      );
      const result = yield* readCompany(transaction);
      if (legalEntityId === sellerId) {
        yield* betweenCompanies;
      }
      return result;
    }).pipe(Effect.mapError(snapshotUnavailable));

/** Real restricted runtime connection, with the same transaction/scope seam Core gives the owner. */
const readerFor = (
  database: MarketDatabase,
  betweenCompanies: Effect.Effect<void> = Effect.void,
): CoreSearchWorkerSnapshotService => ({
  read: (_context, read) =>
    database
      .transaction((transaction) =>
        Effect.gen(function* readNativeSnapshot() {
          yield* transaction.setTransaction({ accessMode: 'read only', isolationLevel: 'repeatable read' });
          return yield* read({
            eventWatermark: '99',
            forLegalEntity: companyReadFor(transaction, betweenCompanies),
            legalEntityIds: [sellerId, otherSellerId],
            projectionVersion: '23',
            tenant: noTenantScope,
            tenantId,
          });
        }),
      )
      .pipe(Effect.mapError(snapshotUnavailable)),
});

const seedMarket = (admin: MarketDatabase, id: string, tenant: string, seller: string, code: string) =>
  admin.transaction((transaction) =>
    Effect.gen(function* seedSearchHistory() {
      yield* transaction.execute(sql`
        insert into commerce_market_catalog.markets (
          market_id, tenant_id, selling_legal_entity_id, business_code,
          created_by_action_invocation_id, created_by_principal_id
        ) values (${id}::uuid, ${tenant}::uuid, ${seller}::uuid, ${code}, gen_random_uuid(), gen_random_uuid())
      `);
      yield* transaction.execute(sql`
        insert into commerce_market_catalog.market_definition_revisions (
          tenant_id, market_id, selling_legal_entity_id, revision_number, purpose, channels,
          jurisdictions, supported_locales, effective_from, effective_to, change_reason,
          action_invocation_id, acting_principal_id
        ) values
          (${tenant}::uuid, ${id}::uuid, ${seller}::uuid, 1, 'Historical purpose', '["B2C"]',
           '[]', '["cs"]', ${january.toISOString()}::timestamptz, ${june.toISOString()}::timestamptz,
           'Private audit reason', gen_random_uuid(), gen_random_uuid()),
          (${tenant}::uuid, ${id}::uuid, ${seller}::uuid, 2, 'Current purpose', '["B2C"]',
           '[]', '["cs"]', ${june.toISOString()}::timestamptz, ${futureDefinition.toISOString()}::timestamptz,
           'Private audit reason', gen_random_uuid(), gen_random_uuid()),
          (${tenant}::uuid, ${id}::uuid, ${seller}::uuid, 3, 'Future purpose', '["B2C"]',
           '[]', '["cs"]', ${futureDefinition.toISOString()}::timestamptz, null,
           'Private audit reason', gen_random_uuid(), gen_random_uuid())
      `);
      yield* transaction.execute(sql`
        insert into commerce_market_catalog.market_lifecycle_periods (
          tenant_id, market_id, selling_legal_entity_id, revision_number, lifecycle,
          effective_from, effective_to, reason, action_invocation_id, acting_principal_id
        ) values
          (${tenant}::uuid, ${id}::uuid, ${seller}::uuid, 1, 'ACTIVE',
           ${january.toISOString()}::timestamptz, ${july.toISOString()}::timestamptz,
           'Private reason', gen_random_uuid(), gen_random_uuid()),
          (${tenant}::uuid, ${id}::uuid, ${seller}::uuid, 2, 'SUSPENDED',
           ${july.toISOString()}::timestamptz, ${august.toISOString()}::timestamptz,
           'Private reason', gen_random_uuid(), gen_random_uuid()),
          (${tenant}::uuid, ${id}::uuid, ${seller}::uuid, 3, 'RETIRED',
           ${august.toISOString()}::timestamptz, null,
           'Private reason', gen_random_uuid(), gen_random_uuid())
      `);
    }),
  );

it.live('denies raw runtime SELECT with 42501 while the owner search snapshot preserves scoped history', () =>
  Effect.scoped(
    Effect.gen(function* runtimeSearchSnapshot() {
      const clients = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(clients.admin, commerceMarketCatalogRelations);
      const runtime = yield* makeTestDatabaseFromClient(clients.runtime, commerceMarketCatalogRelations);
      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanSearchHistory() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`);
            for (const table of ['market_lifecycle_periods', 'market_definition_revisions', 'markets'] as const) {
              yield* transaction.execute(
                sql`delete from ${sql.identifier('commerce_market_catalog')}.${sql.identifier(table)}
                    where tenant_id in (${tenantId}::uuid, ${otherTenantId}::uuid)`,
              );
            }
          }),
        );
      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
      yield* seedMarket(admin, marketId, tenantId, sellerId, 'SEARCH-A');
      yield* seedMarket(admin, otherMarketId, tenantId, otherSellerId, 'SEARCH-B');
      yield* seedMarket(admin, otherTenantMarketId, otherTenantId, sellerId, 'SEARCH-FOREIGN');

      // This is the old source's first query, on the actual ontos_runtime connection.
      const raw = yield* readerFor(runtime)
        .read(context, (snapshot) =>
          snapshot.forLegalEntity(sellerId, (executor) =>
            executor.select({ marketId: markets.marketId }).from(markets),
          ),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(raw)).toBe(true);
      if (Exit.isFailure(raw)) {
        expect(Option.getOrNull(findPostgresFailure(raw.cause, ({ code }) => code === '42501'))?.code).toBe('42501');
      }
      for (const table of ['markets', 'market_definition_revisions', 'market_lifecycle_periods'] as const) {
        const denied = yield* runtime
          .execute(sql`select * from ${sql.identifier('commerce_market_catalog')}.${sql.identifier(table)}`)
          .pipe(Effect.exit);
        expect(Exit.isFailure(denied)).toBe(true);
        if (Exit.isFailure(denied)) {
          expect(Option.getOrNull(findPostgresFailure(denied.cause))?.code).toBe('42501');
        }
      }

      const source = yield* makeMarketSearchSource.pipe(
        Effect.provideService(CoreSearchWorkerSnapshot, readerFor(runtime)),
      );
      const targetedExit = yield* source.load(context, { marketId }).pipe(Effect.exit);
      if (Exit.isFailure(targetedExit)) {
        expect(Option.getOrNull(findPostgresFailure(targetedExit.cause, ({ code }) => code === '42501'))).toBeNull();
      }
      const targeted = yield* source.load(context, { marketId });
      expect(targeted).toEqual({
        projectionVersion: '23',
        records: [
          {
            businessCode: 'SEARCH-A',
            definitions: [
              { effectiveFrom: january, effectiveTo: june, purpose: 'Historical purpose' },
              { effectiveFrom: june, effectiveTo: futureDefinition, purpose: 'Current purpose' },
              { effectiveFrom: futureDefinition, effectiveTo: null, purpose: 'Future purpose' },
            ],
            lifecycles: [
              { effectiveFrom: january, effectiveTo: july, lifecycle: 'ACTIVE' },
              { effectiveFrom: july, effectiveTo: august, lifecycle: 'SUSPENDED' },
              { effectiveFrom: august, effectiveTo: null, lifecycle: 'RETIRED' },
            ],
            marketId,
            sellingLegalEntityId: sellerId,
            tenantId,
          },
        ],
        tenantId,
      });
      const rebuilt = yield* source.load(context, { rebuild: true });
      expect(rebuilt.projectionVersion).toBe('23');
      expect(rebuilt.records.map((row) => row.marketId)).toEqual([marketId, otherMarketId]);
      expect((yield* source.load(context, { marketId: otherTenantMarketId })).records).toEqual([]);

      // A separate writer commits between company reads. The second company's read must
      // retain the first company's PostgreSQL snapshot, not acquire a fresh connection.
      const concurrentSource = yield* makeMarketSearchSource.pipe(
        Effect.provideService(
          CoreSearchWorkerSnapshot,
          readerFor(
            runtime,
            seedMarket(admin, concurrentMarketId, tenantId, otherSellerId, 'SEARCH-CONCURRENT').pipe(Effect.orDie),
          ),
        ),
      );
      const coherent = yield* concurrentSource.load(context, { rebuild: true });
      expect(coherent.projectionVersion).toBe('23');
      expect(coherent.records.map((row) => row.marketId)).toEqual([marketId, otherMarketId]);
      expect((yield* source.load(context, { rebuild: true })).records.map((row) => row.marketId)).toEqual([
        marketId,
        otherMarketId,
        concurrentMarketId,
      ]);

      for (const [readTenant, readSeller] of [
        [otherTenantId, sellerId],
        [tenantId, otherSellerId],
        [null, null],
      ]) {
        const rejected = yield* runtime
          .transaction((transaction) =>
            Effect.gen(function* mismatchScope() {
              yield* transaction.execute(
                sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                         set_config('ontos.legal_entity_id', ${sellerId}, true)`,
              );
              return yield* transaction.execute(
                sql`select * from commerce_market_catalog.read_market_search_snapshot(
                ${readTenant}::uuid, ${readSeller}::uuid, '{}'::jsonb
              )`,
              );
            }),
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(rejected)).toBe(true);
        if (Exit.isFailure(rejected)) {
          expect(Option.getOrNull(findPostgresFailure(rejected.cause))?.code).toBe('42501');
        }
      }
      const missingScope = yield* runtime
        .execute(
          sql`select * from commerce_market_catalog.read_market_search_snapshot(
          ${tenantId}::uuid, ${sellerId}::uuid, '{}'::jsonb
        )`,
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(missingScope)).toBe(true);
      if (Exit.isFailure(missingScope)) {
        expect(Option.getOrNull(findPostgresFailure(missingScope.cause))?.code).toBe('42501');
      }

      // A malformed single-Market request must never silently become a tenant rebuild.
      for (const invalid of [{ marketId: null }, { marketId: 'invalid' }, { marketId: 7 }, { tenantId }, []]) {
        const rejected = yield* runtime
          .transaction((transaction) =>
            Effect.gen(function* invalidTarget() {
              yield* transaction.execute(
                sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                         set_config('ontos.legal_entity_id', ${sellerId}, true)`,
              );
              return yield* transaction.execute(
                sql`select * from commerce_market_catalog.read_market_search_snapshot(
                ${tenantId}::uuid, ${sellerId}::uuid, ${JSON.stringify(invalid)}::jsonb
              )`,
              );
            }),
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(rejected)).toBe(true);
        if (Exit.isFailure(rejected)) {
          expect(Option.getOrNull(findPostgresFailure(rejected.cause))?.code).toBe('22023');
        }
      }
      const privileges = yield* runtime.execute<{ runtime_select: boolean }>(
        sql`select has_table_privilege('ontos_runtime', 'commerce_market_catalog.markets', 'SELECT')
            or has_table_privilege('ontos_runtime', 'commerce_market_catalog.market_definition_revisions', 'SELECT')
            or has_table_privilege('ontos_runtime', 'commerce_market_catalog.market_lifecycle_periods', 'SELECT')
            as runtime_select`,
        'objects',
      );
      expect(privileges).toEqual([{ runtime_select: false }]);
      const routine = yield* admin.execute<{ public_execute: boolean; runtime_execute: boolean; secure: boolean }>(
        sql`select
          routine.prosecdef and routine.provolatile = 's'
            and routine.proconfig = array['search_path=pg_catalog, pg_temp'] as secure,
          has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE') as runtime_execute,
          exists(select 1 from aclexplode(routine.proacl) acl
                 where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute
        from pg_proc routine
        where routine.oid = 'commerce_market_catalog.read_market_search_snapshot(uuid,uuid,jsonb)'::regprocedure`,
        'objects',
      );
      expect(routine).toEqual([{ public_execute: false, runtime_execute: true, secure: true }]);
    }),
  ),
);
