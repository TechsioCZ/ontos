// A company without a relationships state row, against PostgreSQL under the runtime role and row-level security: it
// reads as no activities at revision 0, its first write creates the row, a concurrent first write that loses gets
// the revision conflict, and a company that already has a row is untouched.
import { randomUUID } from 'node:crypto';

import {
  TrustedPrincipalContextSchema,
  defineDatabaseIdentityEnrollment,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { and, eq, sql } from 'drizzle-orm';
import { Deferred, Effect, Exit, Fiber, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { ActivityRevisionConflict, ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { relationshipsRelations, relationshipsStates } from '../../src/database/schema.ts';
import { finishCrmActivitiesRecords, persistenceService } from '../../src/services/persistence.service.ts';

type Db = Effect.Success<ReturnType<typeof makeTestDatabaseFromClient<typeof relationshipsRelations>>>;
interface Company {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

const grants = { predicate: { groups: [] }, readAll: true, writeAll: true } as const;

const scopeOf = (company: Company, principalId: string): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: randomUUID(),
    authContextRef: 'session:absent-state-postgres',
    authMethod: 'session',
    ...company,
    principalId,
  }),
  correlationId: randomUUID(),
});

const recordActivityAt = (company: Company, principalId: string, expectedRevision: number) =>
  Schema.decodeSync(ApplyCommandPayloadSchema)({
    command: {
      _tag: 'RecordActivity',
      kind: 'CALL',
      occurredAt: '2026-11-10T09:00:00Z',
      ownerPrincipalRef: { principalId, tenantId: company.tenantId },
      partyRef: {
        moduleId: 'party.registry',
        resourceId: randomUUID(),
        resourceType: 'party.registry.party',
        tenantId: company.tenantId,
      },
      summary: 'První hovor ve firmě',
    },
    expectedRevision,
  });

/** One owner transaction under the runtime role in `company`'s verified scope. */
const owner = <A, E>(
  runtime: Db,
  company: Company,
  principalId: string,
  body: (
    services: Effect.Success<ReturnType<typeof persistenceService>>,
    scope: OperationalScope,
    scoped: Effect.Success<ReturnType<typeof installOperationalScope>>,
  ) => Effect.Effect<A, E>,
  payload?: ReturnType<typeof recordActivityAt>,
) =>
  runtime.transaction((tx) =>
    Effect.gen(function* ownerTransaction() {
      const scope = scopeOf(company, principalId);
      const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
      const services = yield* persistenceService(
        scoped,
        payload?.command.partyRef === undefined
          ? { scope }
          : {
              prepared: { actionInvocationId: scope.correlationId, partyRef: payload.command.partyRef, payload },
              scope,
            },
      );
      return yield* body(services, scope, scoped);
    }),
  );

const read = (runtime: Db, company: Company, principalId: string) =>
  owner(runtime, company, principalId, (services, scope) =>
    services
      .loadRecords(grants.predicate)
      .pipe(Effect.flatMap((loaded) => finishCrmActivitiesRecords({}, loaded, grants, scope))),
  );

const write = (runtime: Db, company: Company, principalId: string, expectedRevision: number) => {
  const payload = recordActivityAt(company, principalId, expectedRevision);
  return owner(
    runtime,
    company,
    principalId,
    (services, scope) => services.apply(payload.command, expectedRevision, scope.correlationId),
    payload,
  );
};

const rowOf = (admin: Db, company: Company) =>
  admin
    .select({ revision: relationshipsStates.revision })
    .from(relationshipsStates)
    .where(
      and(
        eq(relationshipsStates.tenantId, company.tenantId),
        eq(relationshipsStates.legalEntityId, company.legalEntityId),
      ),
    )
    .pipe(Effect.map((rows) => rows[0]));

/**
 * Waits, inside PostgreSQL, until a backend is blocked inserting a state row behind the uncommitted first write.
 * The activity snapshot is cleared on every probe, so each one sees the server's current wait states.
 */
const awaitBlockedInsert = (admin: Db) =>
  admin
    .execute(
      sql.raw(`do $$ begin
        for attempt in 1..400 loop
          perform pg_stat_clear_snapshot();
          exit when exists (select 1 from pg_stat_activity
            where wait_event_type = 'Lock' and query like 'insert into "crm_activities"."relationships_states"%');
          perform pg_sleep(0.025);
        end loop;
      end $$`),
    )
    .pipe(
      Effect.andThen(() =>
        admin.execute<{ readonly waiting: number }>(
          sql.raw(`select count(*)::int as waiting from pg_stat_activity
            where wait_event_type = 'Lock' and query like 'insert into "crm_activities"."relationships_states"%'`),
          'objects',
        ),
      ),
      Effect.map(([row]) => (row?.waiting ?? 0) > 0),
    );

const absentStateChecks = Effect.scoped(
  Effect.gen(function* absentState() {
    const connections = yield* loadDatabaseConnectionPair();
    const admin = yield* makeTestDatabaseFromClient(
      yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 }),
      relationshipsRelations,
    );
    const runtime = yield* makeTestDatabaseFromClient(
      yield* makeTestPgClient(connections.runtime.connectionString, { maxConnections: 3 }),
      relationshipsRelations,
    );
    const tenantId = randomUUID();
    const principalId = randomUUID();
    const companyA: Company = { legalEntityId: randomUUID(), tenantId };
    const companyB: Company = { legalEntityId: randomUUID(), tenantId };
    const companyC: Company = { legalEntityId: randomUUID(), tenantId };
    yield* Effect.addFinalizer(() =>
      Effect.all([
        admin.delete(relationshipsStates).where(eq(relationshipsStates.tenantId, tenantId)),
        admin.execute(sql`delete from core.principals where tenant_id = ${tenantId}`),
        admin.execute(sql`delete from core.tenants where tenant_id = ${tenantId}`),
      ]).pipe(Effect.orDie),
    );
    const slug = `crm-absent-${tenantId.slice(0, 8)}`;
    yield* admin.execute(
      sql`insert into core.tenants (tenant_id, slug, name, status, default_locale)
        values (${tenantId}, ${slug}, 'CRM absent state', 'active', 'cs')`,
    );
    yield* admin.execute(
      sql`insert into core.principals (principal_id, tenant_id, kind, display_name, status)
        values (${principalId}, ${tenantId}, 'human', 'CRM absent state', 'active')`,
    );
    // Company A already has its row, the way the demo reset writes it.
    yield* admin.insert(relationshipsStates).values({ ...companyA, revision: 3, state: { activities: [] } });

    // Reads: no activities at revision 0, and no row is created.
    expect(yield* read(runtime, companyB, principalId)).toMatchObject({ items: [], revision: 0 });
    expect(yield* rowOf(admin, companyB)).toBeUndefined();

    // The first write creates the row at revision 1; a stale second first write is refused; the next one lands.
    expect((yield* write(runtime, companyB, principalId, 0)).revision).toBe(1);
    expect(yield* rowOf(admin, companyB)).toEqual({ revision: 1 });
    const stale = yield* write(runtime, companyB, principalId, 0).pipe(Effect.flip);
    expect(Schema.is(ActivityRevisionConflict)(stale)).toBe(true);
    expect((yield* write(runtime, companyB, principalId, 1)).revision).toBe(2);
    const afterWrites = yield* read(runtime, companyB, principalId);
    expect({ items: afterWrites.items.length, revision: afterWrites.revision }).toEqual({ items: 2, revision: 2 });

    // Concurrent first writes in C: the winner holds its new row uncommitted while the loser's insert waits on it.
    const winnerHolds = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    const winner = yield* Effect.forkChild(
      owner(runtime, companyC, principalId, (_services, _scope, scoped) =>
        Effect.gen(function* winningFirstWrite() {
          yield* scoped.insert(relationshipsStates).values({ ...companyC, revision: 1, state: { activities: [] } });
          yield* Deferred.succeed(winnerHolds, true);
          yield* Deferred.await(release);
        }),
      ),
    );
    yield* Deferred.await(winnerHolds);
    const loser = yield* Effect.forkChild(write(runtime, companyC, principalId, 0).pipe(Effect.flip, Effect.exit));
    const blocked = yield* awaitBlockedInsert(admin);
    yield* Deferred.succeed(release, true);
    yield* Fiber.join(winner);
    const lost = yield* Fiber.join(loser);
    expect(blocked).toBe(true);
    // The loser's insert did nothing once the winner committed: the same refusal a moved revision gets.
    expect(Exit.isSuccess(lost) && Schema.is(ActivityRevisionConflict)(lost.value)).toBe(true);
    expect(yield* rowOf(admin, companyC)).toEqual({ revision: 1 });

    // Company A, which already had its row, is untouched.
    expect(yield* rowOf(admin, companyA)).toEqual({ revision: 3 });
    expect(yield* read(runtime, companyA, principalId)).toMatchObject({ items: [], revision: 3 });
  }),
);

it.live(
  'reads a company without a state row as empty, creates it on the first write, and leaves other companies',
  () => absentStateChecks,
);
