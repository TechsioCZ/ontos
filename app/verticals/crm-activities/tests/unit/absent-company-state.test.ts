import { randomUUID } from 'node:crypto';
import { TrustedPrincipalContextSchema, defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { ActivityRevisionConflict, ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { relationshipsRelations } from '../../src/database/schema.ts';
import {
  EMPTY_RELATIONSHIPS_STATE,
  finishCrmActivitiesRecords,
  persistenceService,
} from '../../src/services/persistence.service.ts';

/*
 * A company whose state row was never written. Real Drizzle SQL runs against a scripted connection that holds the
 * company's one row in memory, so each case shows exactly which statements a read and a first write issue.
 */

const tenantId = randomUUID();
const legalEntityId = randomUUID();
const principalId = randomUUID();
const installAndReadScopeSql =
  "select current_user::text as role, set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id";
const stateTable = '"crm_activities"."relationships_states"';

interface StoredRow {
  readonly revision: number;
}

/** `concurrentWinner` is a first write that commits between this transaction's read and its insert. */
const harness = (options: { readonly concurrentWinner?: boolean; readonly initial?: StoredRow } = {}) =>
  Effect.gen(function* makeHarness() {
    let row = options.initial;
    const statements: string[] = [];
    const services = yield* Layer.build(
      scriptedPgClientLayer(
        Effect.succeed(
          testSqlConnection((sql, params) => {
            statements.push(sql);
            if (/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/u.test(sql)) {
              return Effect.succeed([]);
            }
            // Main's scope authority probes the connected role before it installs a scope.
            if (sql === 'select current_user::text as role') {
              return Effect.succeed([{ role: 'ontos_runtime' }]);
            }
            // A session-setting role installs its scope and reads back the connected role in one statement.
            if (sql === installAndReadScopeSql) {
              expect(params).toEqual([tenantId, legalEntityId]);
              return Effect.succeed([{ legal_entity_id: legalEntityId, role: 'ontos_runtime', tenant_id: tenantId }]);
            }
            if (sql.includes('"core"."principals"')) {
              return Effect.succeed([{ status: 'active', tenantId }]);
            }
            if (sql.startsWith('insert into') && sql.includes(stateTable)) {
              if (options.concurrentWinner === true) {
                row = { revision: 1 };
              }
              if (row !== undefined) {
                return Effect.succeed([]);
              }
              row = { revision: 1 };
              return Effect.succeed([{ revision: 1 }]);
            }
            if (sql.startsWith('update') && sql.includes(stateTable)) {
              // The owner already compared the revision it read; the stored row moves one revision on.
              row = row === undefined ? row : { revision: row.revision + 1 };
              return Effect.succeed(row === undefined ? [] : [{ revision: row.revision }]);
            }
            if (sql.includes('jsonb_set(')) {
              return Effect.succeed(row === undefined ? [] : [{ revision: row.revision, state: { activities: [] } }]);
            }
            if (sql.startsWith('select') && sql.includes(stateTable)) {
              // Values mode follows the table's column order.
              return Effect.succeed(
                row === undefined
                  ? []
                  : [
                      {
                        legalEntityId,
                        revision: row.revision,
                        state: { activities: [] },
                        tenantId,
                        updatedAt: '2026-11-10T10:00:00Z',
                      },
                    ],
              );
            }
            return Effect.die(`Unexpected SQL: ${sql}`);
          }),
        ),
      ).pipe(Layer.provide(Reactivity.layer)),
    );
    const db = yield* makeWithDefaults({ relations: relationshipsRelations }).pipe(
      Effect.provideService(PgClient.PgClient, Context.get(services, PgClient.PgClient)),
    );
    return { db, row: () => row, statements };
  });

const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: randomUUID(),
    authContextRef: 'session:absent-company-state',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  }),
  correlationId: 'absent-company-state',
};

const partyRef = {
  moduleId: 'party.registry',
  resourceId: randomUUID(),
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const recordActivityAt = (expectedRevision: number) =>
  Schema.decodeSync(ApplyCommandPayloadSchema)({
    command: {
      _tag: 'RecordActivity',
      kind: 'CALL',
      occurredAt: '2026-11-10T09:00:00Z',
      ownerPrincipalRef: { principalId, tenantId },
      partyRef,
      summary: 'První hovor ve firmě',
    },
    expectedRevision,
  });

/** One owner transaction: install the caller's scope, then run `body` with the owner's services. */
const inTransaction = <A, E>(
  db: Effect.Success<ReturnType<typeof harness>>['db'],
  expectedRevision: number,
  body: (
    services: Effect.Success<ReturnType<typeof persistenceService>>,
    write: () => ReturnType<Effect.Success<ReturnType<typeof persistenceService>>['apply']>,
  ) => Effect.Effect<A, E>,
) =>
  db.transaction((tx) =>
    Effect.gen(function* ownerTransaction() {
      const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
      const resourceId = randomUUID();
      const payload = recordActivityAt(expectedRevision);
      const services = yield* persistenceService(scoped, {
        prepared: { actionInvocationId: resourceId, partyRef, payload },
        scope,
      });
      return yield* body(services, () => services.apply(payload.command, expectedRevision, resourceId));
    }),
  );

const grants = { predicate: { groups: [] }, readAll: true, writeAll: true } as const;

it.effect('reads a company without a state row as no activities at revision 0, and writes nothing', () =>
  Effect.gen(function* emptyRead() {
    const { db, row, statements } = yield* harness();
    const loaded = yield* inTransaction(db, 0, (services) => services.loadRecords(grants.predicate));
    expect(loaded).toEqual(EMPTY_RELATIONSHIPS_STATE);
    const response = yield* finishCrmActivitiesRecords({}, loaded, grants, scope);
    expect(response).toMatchObject({ items: [], revision: 0 });
    expect(row()).toBeUndefined();
    expect(statements.some((sql) => sql.startsWith('insert') || sql.startsWith('update'))).toBe(false);
  }),
);

it.effect('creates the row on the first write, at revision 1', () =>
  Effect.gen(function* firstWrite() {
    const { db, row, statements } = yield* harness();
    const result = yield* inTransaction(db, 0, (_services, write) => write());
    expect(result.revision).toBe(1);
    expect(row()).toEqual({ revision: 1 });
    expect(statements.filter((sql) => sql.startsWith('insert into') && sql.includes(stateTable))).toHaveLength(1);
    expect(statements.some((sql) => sql.startsWith('update') && sql.includes(stateTable))).toBe(false);
  }),
);

it.effect('refuses the losing concurrent first write with the revision conflict, not an error', () =>
  Effect.gen(function* lostRace() {
    const { db } = yield* harness({ concurrentWinner: true });
    const failure = yield* inTransaction(db, 0, (_services, write) => write()).pipe(Effect.flip);
    expect(Schema.is(ActivityRevisionConflict)(failure)).toBe(true);
  }),
);

it.effect('keeps a stored row on the compare-and-set update and never inserts', () =>
  Effect.gen(function* storedRow() {
    const { db, statements } = yield* harness({ initial: { revision: 4 } });
    const stale = yield* inTransaction(db, 0, (_services, write) => write()).pipe(Effect.flip);
    expect(Schema.is(ActivityRevisionConflict)(stale)).toBe(true);
    const loaded = yield* inTransaction(db, 4, (services) => services.loadRecords(grants.predicate));
    expect(loaded.revision).toBe(4);
    const written = yield* inTransaction(db, 4, (_services, write) => write());
    expect(written.revision).toBe(5);
    expect(statements.filter((sql) => sql.startsWith('update') && sql.includes(stateTable))).toHaveLength(1);
    expect(statements.some((sql) => sql.startsWith('insert'))).toBe(false);
  }),
);
