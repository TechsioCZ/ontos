import { randomUUID } from 'node:crypto';
import { TrustedPrincipalContextSchema, defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Exit, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { MerchandiseCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { MerchandiseRevisionConflict } from '../../shared/errors/merchandise-revision-conflict.ts';
import { PLAYGROUND_COMPANY, PLAYGROUND_TENANT } from '../../shared/domain/playground-catalog-bootstrap.ts';
import { merchandiseRelations } from '../../src/database/schema.ts';
import { assertMerchandiseSearchPublished } from '../../src/services/catalog-publication.ts';
import { EMPTY_CATALOG_HEAD, lockHeadForWrite } from '../../src/services/merchandise-store.ts';
import { persistenceService } from '../../src/services/persistence.service.ts';
import { TEST_FETCHED_TAX } from '../support/tax-fixtures.ts';

/*
 * A company whose catalog head row was never written. Real Drizzle SQL runs against a scripted connection holding
 * the company's head in memory, so each case shows exactly which head statements a read and a first write issue.
 */

const headTable = '"demo_merchandise"."catalog_heads"';

interface StoredHead {
  readonly checkpoint: { readonly status: string } | null;
  readonly revision: number;
}

/** `concurrentWinner` is a first write that commits between this transaction's locked read and its insert. */
const harness = (options: { readonly concurrentWinner?: boolean; readonly initial?: StoredHead } = {}) =>
  Effect.gen(function* makeHarness() {
    let head = options.initial;
    const statements: string[] = [];
    let scope = { legalEntityId: '', tenantId: '' };
    const services = yield* Layer.build(
      scriptedPgClientLayer(
        Effect.succeed(
          testSqlConnection((sql, params) => {
            statements.push(sql);
            if (/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/u.test(sql)) {
              return Effect.succeed([]);
            }
            if (sql.includes('set_config(')) {
              scope = { legalEntityId: String(params[1]), tenantId: String(params[0]) };
              return Effect.succeed([{}]);
            }
            if (sql.includes('current_user::text as role')) {
              return Effect.succeed([
                { legal_entity_id: scope.legalEntityId, role: 'ontos_runtime', tenant_id: scope.tenantId },
              ]);
            }
            if (sql.startsWith('insert into') && sql.includes(headTable)) {
              if (options.concurrentWinner === true) {
                head = { checkpoint: null, revision: 1 };
              }
              head ??= { checkpoint: null, revision: 0 };
              return Effect.succeed([]);
            }
            if (sql.startsWith('select') && sql.includes(headTable)) {
              // Values mode follows SELECT order: aiChanges, bootstrapCheckpoint, homepageFeaturedProductIds, revision,
              // taxRates.
              return Effect.succeed(
                head === undefined
                  ? []
                  : [
                      {
                        aiChanges: null,
                        bootstrapCheckpoint: head.checkpoint,
                        homepageFeaturedProductIds: [],
                        revision: head.revision,
                        taxRates: null,
                      },
                    ],
              );
            }
            return Effect.die(`Unexpected SQL: ${sql}`);
          }),
        ),
      ).pipe(Layer.provide(Reactivity.layer)),
    );
    const db = yield* makeWithDefaults({ relations: merchandiseRelations }).pipe(
      Effect.provideService(PgClient.PgClient, Context.get(services, PgClient.PgClient)),
    );
    return { db, head: () => head, statements };
  });

const store = { legalEntityId: randomUUID(), tenantId: randomUUID() };
const headInserts = (statements: readonly string[]) =>
  statements.filter((sql) => sql.startsWith('insert into') && sql.includes(headTable));
const lockedReads = (statements: readonly string[]) =>
  statements.filter((sql) => sql.includes(headTable) && sql.endsWith('for update'));

it.effect('creates a missing head at revision 0 inside the write, then holds its lock', () =>
  Effect.gen(function* firstWrite() {
    const { db, head, statements } = yield* harness();
    const locked = yield* db.transaction((tx) => lockHeadForWrite(tx, store));
    expect(locked).toEqual(EMPTY_CATALOG_HEAD);
    expect(head()).toEqual({ checkpoint: null, revision: 0 });
    expect(headInserts(statements)).toHaveLength(1);
    expect(headInserts(statements)[0]).toContain('on conflict ("tenant_id","legal_entity_id") do nothing');
    expect(lockedReads(statements)).toHaveLength(2);
  }),
);

it.effect('locks an existing head exactly as before, without an insert', () =>
  Effect.gen(function* existingHead() {
    const { db, statements } = yield* harness({ initial: { checkpoint: null, revision: 7 } });
    const locked = yield* db.transaction((tx) => lockHeadForWrite(tx, store));
    expect(locked.revision).toBe(7);
    expect(headInserts(statements)).toEqual([]);
    expect(lockedReads(statements)).toHaveLength(1);
  }),
);

it.effect('answers the concurrent winner when another first write committed in between', () =>
  Effect.gen(function* lostRace() {
    const { db } = yield* harness({ concurrentWinner: true });
    const locked = yield* db.transaction((tx) => lockHeadForWrite(tx, store));
    expect(locked.revision).toBe(1);
  }),
);

it.effect('never treats an unfinished import as empty and never inserts over it', () =>
  Effect.gen(function* unverified() {
    const { db, statements } = yield* harness({ initial: { checkpoint: { status: 'IMPORTING' }, revision: 0 } });
    const exit = yield* db.transaction((tx) => lockHeadForWrite(tx, store)).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(headInserts(statements)).toEqual([]);
  }),
);

it.effect('lets search consult the index for a company without a head, but not for an unfinished import', () =>
  Effect.gen(function* searchPublication() {
    const scope: OperationalScope = {
      ...Schema.decodeSync(TrustedPrincipalContextSchema)({
        authBindingId: randomUUID(),
        authContextRef: 'session:absent-head-search',
        authMethod: 'session',
        ...store,
        principalId: randomUUID(),
      }),
      correlationId: 'absent-head-search',
    };
    const absent = yield* harness();
    expect(Exit.isSuccess(yield* assertMerchandiseSearchPublished(absent.db, scope).pipe(Effect.exit))).toBe(true);
    const importing = yield* harness({ initial: { checkpoint: { status: 'IMPORTING' }, revision: 0 } });
    expect(Exit.isFailure(yield* assertMerchandiseSearchPublished(importing.db, scope).pipe(Effect.exit))).toBe(true);
    expect(absent.head()).toBeUndefined();
  }),
);

const createCategoryAt = (expectedRevision: number) =>
  Schema.decodeSync(MerchandiseCommandPayloadSchema)({
    command: { _tag: 'CreateCategory', id: 'nova', name: 'Nová kategorie', parentId: null, slug: 'nova' },
    expectedRevision,
  });

/** One owner write transaction in `company`, stopping at the head: the scripted catalog holds nothing else. */
const writeOnHead = (
  db: Effect.Success<ReturnType<typeof harness>>['db'],
  company: { readonly legalEntityId: string; readonly tenantId: string },
  expectedRevision: number,
) =>
  db.transaction((tx) =>
    Effect.gen(function* ownerWrite() {
      const scope: OperationalScope = {
        ...Schema.decodeSync(TrustedPrincipalContextSchema)({
          authBindingId: randomUUID(),
          authContextRef: 'session:absent-head-write',
          authMethod: 'session',
          ...company,
          principalId: randomUUID(),
        }),
        correlationId: 'absent-head-write',
      };
      const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
      const resourceId = randomUUID();
      const payload = createCategoryAt(expectedRevision);
      const services = yield* persistenceService(scoped, {
        prepared: { actionInvocationId: resourceId, payload, tax: { fetched: TEST_FETCHED_TAX, refused: false } },
        scope,
      });
      return yield* services.apply(payload.command, expectedRevision, resourceId);
    }),
  );

it.effect('refuses the losing first write with the revision conflict problem, not an unavailable error', () =>
  Effect.gen(function* conflictProblem() {
    const { db } = yield* harness({ concurrentWinner: true });
    const failure = yield* writeOnHead(db, store, 0).pipe(Effect.flip);
    expect(Schema.is(MerchandiseRevisionConflict)(failure)).toBe(true);
  }),
);

it.effect('keeps the playground import in charge of creating its own head', () =>
  Effect.gen(function* playground() {
    const { db, head, statements } = yield* harness();
    const exit = yield* writeOnHead(db, { legalEntityId: PLAYGROUND_COMPANY, tenantId: PLAYGROUND_TENANT }, 0).pipe(
      Effect.exit,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(headInserts(statements)).toEqual([]);
    expect(head()).toBeUndefined();
  }),
);
