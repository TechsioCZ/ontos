import { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/unstable/reactivity';
import { SqlError, UnknownError } from 'effect/unstable/sql/SqlError';

import { scriptedPgClientLayer } from '../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../packages/core-runtime/tests/support/sql-connection.ts';
import { classifyContactsJournalState, prepareContactsMigration } from '../../scripts/prepare-contacts-migration.mts';

const journalSelect = `select
        to_regclass('drizzle.__drizzle_migrations_crm') is not null as legacy,
        to_regclass('drizzle.__drizzle_migrations_contacts') is not null as contacts`;

// Runs the preparation through Effect's own transaction controls over a scripted connection.
const prepareJournal = (legacy: boolean, contacts: boolean, renameFailure?: SqlError) => {
  const queries: string[] = [];
  const execute = (query: string) => {
    queries.push(query);
    if (query.startsWith('select')) {
      return Effect.succeed([{ contacts, legacy }]);
    }
    if (query.startsWith('alter table') && renameFailure !== undefined) {
      return Effect.fail(renameFailure);
    }
    return Effect.succeed([]);
  };
  return Effect.gen(function* prepareScriptedJournal() {
    return yield* prepareContactsMigration(yield* PgClient.PgClient);
  }).pipe(
    Effect.provide(scriptedPgClientLayer(Effect.succeed(testSqlConnection(execute)))),
    Effect.provide(Reactivity.layer),
    Effect.map((state) => ({ queries, state })),
    Effect.mapError((failure) => ({ failure, queries })),
  );
};

it('classifies fresh, legacy, migrated, and ambiguous Contacts journal states', () => {
  expect(classifyContactsJournalState(false, false)).toBe('fresh');
  expect(classifyContactsJournalState(true, false)).toBe('legacy');
  expect(classifyContactsJournalState(false, true)).toBe('contacts');
  expect(classifyContactsJournalState(true, true)).toBe('ambiguous');
});

it.effect('atomically renames the legacy journal before the Contacts migration chain', () =>
  Effect.gen(function* atomicallyRenamesLegacyJournal() {
    const { queries, state } = yield* prepareJournal(true, false);

    expect(state).toBe('legacy');
    expect(queries).toEqual([
      'BEGIN',
      journalSelect,
      'alter table drizzle.__drizzle_migrations_crm rename to __drizzle_migrations_contacts',
      'COMMIT',
    ]);
  }),
);

it.effect('fresh and already-migrated journal states are committed no-ops', () =>
  Effect.forEach(
    [
      [false, false, 'fresh'],
      [false, true, 'contacts'],
    ] as const,
    ([legacy, contacts, expected]) =>
      Effect.gen(function* commitsJournalStateNoOp() {
        const { queries, state } = yield* prepareJournal(legacy, contacts);
        expect(state).toBe(expected);
        expect(queries[0]).toBe('BEGIN');
        expect(queries.at(-1)).toBe('COMMIT');
        expect(queries.some((query) => query.startsWith('alter table'))).toBe(false);
      }),
    { concurrency: 'unbounded', discard: true },
  ),
);

it.effect('ambiguous or failed journal handoff rolls back without claiming success', () =>
  Effect.gen(function* rollsBackFailedJournalHandoff() {
    const ambiguous = yield* Effect.flip(prepareJournal(true, true));
    expect(ambiguous.failure.message).toMatch(/both CRM and Contacts journals exist/u);
    expect(ambiguous.failure.cause).toBe('ambiguous');
    expect(ambiguous.queries.at(-1)).toBe('ROLLBACK');
    expect(ambiguous.queries.some((query) => query.startsWith('alter table'))).toBe(false);

    const renameError = new SqlError({ reason: new UnknownError({ cause: new Error('rename failed') }) });
    const renameFailure = yield* Effect.flip(prepareJournal(true, false, renameError));
    expect(renameFailure.failure.message).toMatch(/PostgreSQL query failed/u);
    expect(renameFailure.failure.cause).toBe(renameError);
    expect(renameFailure.queries.at(-1)).toBe('ROLLBACK');
    expect(renameFailure.queries.includes('COMMIT')).toBe(false);
  }),
);
