import assert from 'node:assert/strict';
import test from 'node:test';

import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { Effect } from 'effect';
import { Client } from 'pg';

import {
  classifyContactsJournalState,
  prepareContactsMigration,
} from '../../scripts/prepare-contacts-migration.mts';

interface JournalClientFixture {
  readonly client: Client;
  readonly queries: string[];
}

const journalClient = (
  legacy: boolean,
  contacts: boolean,
  renameFailure?: Error
): JournalClientFixture => {
  const queries: string[] = [];
  const client = new Client();
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

test('classifies fresh, legacy, migrated, and ambiguous Contacts journal states', () => {
  assert.equal(classifyContactsJournalState(false, false), 'fresh');
  assert.equal(classifyContactsJournalState(true, false), 'legacy');
  assert.equal(classifyContactsJournalState(false, true), 'contacts');
  assert.equal(classifyContactsJournalState(true, true), 'ambiguous');
});

test('atomically renames the legacy journal before the Contacts migration chain', () =>
  runEffectTestPromise(
    Effect.gen(function* atomicallyRenamesLegacyJournal() {
      const fixture = journalClient(true, false);

      assert.equal(yield* prepareContactsMigration(fixture.client), 'legacy');
      assert.deepEqual(fixture.queries, [
        'begin',
        `select
        to_regclass('drizzle.__drizzle_migrations_crm') is not null as legacy,
        to_regclass('drizzle.__drizzle_migrations_contacts') is not null as contacts`,
        'alter table drizzle.__drizzle_migrations_crm rename to __drizzle_migrations_contacts',
        'commit',
      ]);
    })
  ));

test('fresh and already-migrated journal states are committed no-ops', () =>
  runEffectTestPromise(
    Effect.forEach(
      [
        [false, false, 'fresh'],
        [false, true, 'contacts'],
      ] as const,
      ([legacy, contacts, expected]) =>
        Effect.gen(function* commitsJournalStateNoOp() {
          const fixture = journalClient(legacy, contacts);
          assert.equal(
            yield* prepareContactsMigration(fixture.client),
            expected
          );
          assert.equal(fixture.queries[0], 'begin');
          assert.equal(fixture.queries.at(-1), 'commit');
          assert.equal(
            fixture.queries.some((query) => query.startsWith('alter table')),
            false
          );
        }),
      { concurrency: 'unbounded', discard: true }
    )
  ));

test('ambiguous or failed journal handoff rolls back without claiming success', () =>
  runEffectTestPromise(
    Effect.gen(function* rollsBackFailedJournalHandoff() {
      const ambiguous = journalClient(true, true);
      const ambiguousFailure = yield* Effect.flip(
        prepareContactsMigration(ambiguous.client)
      );
      assert.match(
        ambiguousFailure.message,
        /both CRM and Contacts journals exist/u
      );
      assert.equal(ambiguousFailure.cause, 'ambiguous');
      assert.equal(ambiguous.queries.at(-1), 'rollback');
      assert.equal(
        ambiguous.queries.some((query) => query.startsWith('alter table')),
        false
      );

      const renameError = new Error('rename failed');
      const renameFailure = journalClient(true, false, renameError);
      const failure = yield* Effect.flip(
        prepareContactsMigration(renameFailure.client)
      );
      assert.match(failure.message, /PostgreSQL query failed/u);
      assert.equal(failure.cause, renameError);
      assert.equal(renameFailure.queries.at(-1), 'rollback');
      assert.equal(renameFailure.queries.includes('commit'), false);
    })
  ));
