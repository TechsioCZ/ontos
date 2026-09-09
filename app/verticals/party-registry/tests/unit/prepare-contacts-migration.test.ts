import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { Client } from 'pg';

import { classifyContactsJournalState, prepareContactsMigration } from '../../scripts/prepare-contacts-migration.mts';

interface JournalClientFixture {
  readonly client: Client;
  readonly queries: string[];
}

const journalClient = (legacy: boolean, contacts: boolean, renameFailure?: Error): JournalClientFixture => {
  const queries: string[] = [];
  const client = new Client();
  // Accepted foreign API fixture: pg Client.query returns Promises, consumed by the
  // production Effect.tryPromise boundary; this is not an Effect test helper.
  Object.defineProperty(client, 'query', {
    value: (query: string) => {
      queries.push(query);
      if (query.startsWith('select')) {
        return Promise.resolve({ rows: [{ contacts, legacy }] });
      }
      if (query.startsWith('alter table') && renameFailure !== undefined) {
        return Promise.reject(renameFailure);
      }
      return Promise.resolve({ rows: [] });
    },
  });
  return { client, queries };
};

it('classifies fresh, legacy, migrated, and ambiguous Contacts journal states', () => {
  expect(classifyContactsJournalState(false, false)).toBe('fresh');
  expect(classifyContactsJournalState(true, false)).toBe('legacy');
  expect(classifyContactsJournalState(false, true)).toBe('contacts');
  expect(classifyContactsJournalState(true, true)).toBe('ambiguous');
});

it.effect('atomically renames the legacy journal before the Contacts migration chain', () =>
  Effect.gen(function* atomicallyRenamesLegacyJournal() {
    const fixture = journalClient(true, false);

    expect(yield* prepareContactsMigration(fixture.client)).toBe('legacy');
    expect(fixture.queries).toEqual([
      'begin',
      `select
        to_regclass('drizzle.__drizzle_migrations_crm') is not null as legacy,
        to_regclass('drizzle.__drizzle_migrations_contacts') is not null as contacts`,
      'alter table drizzle.__drizzle_migrations_crm rename to __drizzle_migrations_contacts',
      'commit',
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
        const fixture = journalClient(legacy, contacts);
        expect(yield* prepareContactsMigration(fixture.client)).toBe(expected);
        expect(fixture.queries[0]).toBe('begin');
        expect(fixture.queries.at(-1)).toBe('commit');
        expect(fixture.queries.some((query) => query.startsWith('alter table'))).toBe(false);
      }),
    { concurrency: 'unbounded', discard: true },
  ),
);

it.effect('ambiguous or failed journal handoff rolls back without claiming success', () =>
  Effect.gen(function* rollsBackFailedJournalHandoff() {
    const ambiguous = journalClient(true, true);
    const ambiguousFailure = yield* Effect.flip(prepareContactsMigration(ambiguous.client));
    expect(ambiguousFailure.message).toMatch(/both CRM and Contacts journals exist/u);
    expect(ambiguousFailure.cause).toBe('ambiguous');
    expect(ambiguous.queries.at(-1)).toBe('rollback');
    expect(ambiguous.queries.some((query) => query.startsWith('alter table'))).toBe(false);

    const renameError = new Error('rename failed');
    const renameFailure = journalClient(true, false, renameError);
    const failure = yield* Effect.flip(prepareContactsMigration(renameFailure.client));
    expect(failure.message).toMatch(/PostgreSQL query failed/u);
    expect(failure.cause).toBe(renameError);
    expect(renameFailure.queries.at(-1)).toBe('rollback');
    expect(renameFailure.queries.includes('commit')).toBe(false);
  }),
);
