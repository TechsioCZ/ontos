// A company without a catalog head row, against PostgreSQL under the runtime role and row-level security: it reads
// as an empty catalog at revision 0, its first write creates the head, a concurrent first write that loses gets the
// revision conflict, and a company that already has a head is untouched.
import { randomUUID } from 'node:crypto';

import {
  TrustedPrincipalContextSchema,
  defineDatabaseIdentityEnrollment,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { sql } from 'drizzle-orm';
import { Deferred, Effect, Exit, Fiber, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { MerchandiseCommandPayloadSchema, MerchandiseRevisionConflict } from '../../shared/actions/apply-command.ts';
import { RecordsRequestSchema } from '../../shared/apis/records.ts';
import { catalogHeads, categories, merchandiseRelations } from '../../src/database/schema.ts';
import { lockHeadForWrite, whereScope } from '../../src/services/merchandise-store.ts';
import type { StoreScope } from '../../src/services/merchandise-store.ts';
import { persistenceService } from '../../src/services/persistence.service.ts';
import type { MerchandiseRecordsGrants } from '../../src/services/persistence.service.ts';
import type { MerchandiseFixture } from './support/merchandise-database.ts';
import { catalogState, withMerchandise } from './support/merchandise-database.ts';
import { TEST_TAX_BOOK } from '../support/tax-fixtures.ts';

type RuntimeDb = Effect.Success<ReturnType<typeof makeTestDatabaseFromClient<typeof merchandiseRelations>>>;

const grants: MerchandiseRecordsGrants = {
  catalog: true,
  cleanup: true,
  createProduct: true,
  images: true,
  markets: true,
  proposeOrderChanges: true,
  readAll: true,
  reviewOrderChanges: true,
  status: true,
  stock: true,
  storefrontOrder: true,
  writeAll: true,
};
const staffRead = Schema.decodeUnknownSync(RecordsRequestSchema)({});
const storefrontRead = Schema.decodeUnknownSync(RecordsRequestSchema)({
  view: { storefront: true, storefrontCatalog: { fields: 'card' } },
});
const createCategoryAt = (id: string, expectedRevision: number) =>
  Schema.decodeSync(MerchandiseCommandPayloadSchema)({
    command: { _tag: 'CreateCategory', id, name: `Kategorie ${id}`, parentId: null, slug: id },
    expectedRevision,
  });

const operationalScope = (store: StoreScope): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: randomUUID(),
    authContextRef: 'session:absent-head-postgres',
    authMethod: 'session',
    ...store,
    principalId: randomUUID(),
  }),
  correlationId: 'absent-head-postgres',
});

/** One owner transaction under the runtime role, in `store`'s verified scope. */
const owner = <A, E>(
  runtime: RuntimeDb,
  store: StoreScope,
  body: (
    services: Effect.Success<ReturnType<typeof persistenceService>>,
    resourceId: string,
    scoped: Effect.Success<ReturnType<typeof installOperationalScope>>,
  ) => Effect.Effect<A, E>,
  prepared?: ReturnType<typeof createCategoryAt>,
) =>
  runtime.transaction((tx) =>
    Effect.gen(function* ownerTransaction() {
      const scope = operationalScope(store);
      const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
      const resourceId = randomUUID();
      const services = yield* persistenceService(
        scoped,
        prepared === undefined
          ? { scope }
          : { prepared: { actionInvocationId: resourceId, payload: prepared, taxBook: TEST_TAX_BOOK }, scope },
      );
      return yield* body(services, resourceId, scoped);
    }),
  );

const write = (runtime: RuntimeDb, store: StoreScope, payload: ReturnType<typeof createCategoryAt>) =>
  owner(
    runtime,
    store,
    (services, resourceId) => services.apply(payload.command, payload.expectedRevision, resourceId),
    payload,
  );

const headOf = (fixture: MerchandiseFixture, store: StoreScope) =>
  fixture.db
    .select({ revision: catalogHeads.revision })
    .from(catalogHeads)
    .where(whereScope(catalogHeads, store))
    .pipe(Effect.map((rows) => rows[0]));

/**
 * Waits, inside PostgreSQL, until a backend is blocked inserting this company's head behind the uncommitted first write.
 * The activity snapshot is cleared on every probe, so each one sees the server's current wait states.
 */
const awaitBlockedHeadInsert = (fixture: MerchandiseFixture) =>
  fixture.db
    .execute(
      sql.raw(`do $$ begin
        for attempt in 1..400 loop
          perform pg_stat_clear_snapshot();
          exit when exists (select 1 from pg_stat_activity
            where wait_event_type = 'Lock' and query like 'insert into "demo_merchandise"."catalog_heads"%');
          perform pg_sleep(0.025);
        end loop;
      end $$`),
    )
    .pipe(
      Effect.andThen(() =>
        fixture.db.execute<{ readonly waiting: number }>(
          sql.raw(`select count(*)::int as waiting from pg_stat_activity
            where wait_event_type = 'Lock' and query like 'insert into "demo_merchandise"."catalog_heads"%'`),
          'objects',
        ),
      ),
      Effect.map(([row]) => (row?.waiting ?? 0) > 0),
    );

const absentHeadChecks = (fixture: MerchandiseFixture) =>
  Effect.scoped(
    Effect.gen(function* absentHead() {
      const connections = yield* loadDatabaseConnectionPair();
      const client = yield* makeTestPgClient(connections.runtime.connectionString, { maxConnections: 3 });
      const runtime = yield* makeTestDatabaseFromClient(client, merchandiseRelations);
      // Companies B and C share the fixture's tenant, so only the company fence separates them from A.
      const companyB: StoreScope = { legalEntityId: randomUUID(), tenantId: fixture.scope.tenantId };
      const companyC: StoreScope = { legalEntityId: randomUUID(), tenantId: fixture.scope.tenantId };
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          [companyB, companyC],
          (store) =>
            Effect.all([
              fixture.db.delete(categories).where(whereScope(categories, store)),
              fixture.db.delete(catalogHeads).where(whereScope(catalogHeads, store)),
            ]),
          { discard: true },
        ).pipe(Effect.orDie),
      );
      const headA = yield* headOf(fixture, fixture.scope);

      // Reads: an empty catalog at revision 0 for staff and the storefront, and no row is created.
      const staff = yield* owner(runtime, companyB, (services) => services.records(staffRead, grants));
      expect({ products: staff.products, revision: staff.revision, total: staff.totalProducts }).toEqual({
        products: [],
        revision: 0,
        total: 0,
      });
      const storefront = yield* owner(runtime, companyB, (services) => services.records(storefrontRead, grants));
      expect({ products: storefront.products, revision: storefront.revision }).toEqual({ products: [], revision: 0 });
      expect(yield* headOf(fixture, companyB)).toBeUndefined();

      // The first write creates the head and lands at revision 1; a stale second first write is refused.
      expect((yield* write(runtime, companyB, createCategoryAt('prvni', 0))).revision).toBe(1);
      expect(yield* headOf(fixture, companyB)).toEqual({ revision: 1 });
      const stale = yield* write(runtime, companyB, createCategoryAt('druha', 0)).pipe(Effect.flip);
      expect(Schema.is(MerchandiseRevisionConflict)(stale)).toBe(true);
      expect((yield* write(runtime, companyB, createCategoryAt('druha', 1))).revision).toBe(2);
      const afterWrites = yield* owner(runtime, companyB, (services) => services.records(staffRead, grants));
      expect(afterWrites.revision).toBe(2);

      // Concurrent first writes in C: the winner holds its new head uncommitted while the loser's insert waits.
      const winnerHolds = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const winner = yield* Effect.forkChild(
        owner(runtime, companyC, (_services, _resourceId, scoped) =>
          Effect.gen(function* winningFirstWrite() {
            yield* lockHeadForWrite(scoped, companyC);
            yield* scoped.update(catalogHeads).set({ revision: 1 }).where(whereScope(catalogHeads, companyC));
            yield* Deferred.succeed(winnerHolds, true);
            yield* Deferred.await(release);
          }),
        ),
      );
      yield* Deferred.await(winnerHolds);
      const loser = yield* Effect.forkChild(
        write(runtime, companyC, createCategoryAt('soubezna', 0)).pipe(Effect.flip, Effect.exit),
      );
      const blocked = yield* awaitBlockedHeadInsert(fixture);
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(winner);
      const lost = yield* Fiber.join(loser);
      expect(blocked).toBe(true);
      // The loser's insert did nothing once the winner committed; it then read revision 1 against its expected 0.
      expect(Exit.isSuccess(lost) && Schema.is(MerchandiseRevisionConflict)(lost.value)).toBe(true);
      expect(yield* headOf(fixture, companyC)).toEqual({ revision: 1 });

      // Company A, which already had a head, kept its revision and rows.
      expect(yield* headOf(fixture, fixture.scope)).toEqual(headA);
      const readA = yield* owner(runtime, fixture.scope, (services) => services.records(staffRead, grants));
      expect(readA.revision).toBe(headA?.revision);
      expect(readA.totalProducts).toBeGreaterThan(0);
    }),
  );

it.live('reads a company without a head as empty, creates it on the first write, and leaves other companies', () =>
  withMerchandise(catalogState, absentHeadChecks),
);
