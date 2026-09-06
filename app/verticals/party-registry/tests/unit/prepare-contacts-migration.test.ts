// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
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
  renameFailure?: Error,
): JournalClientFixture => {
  const queries: string[] = [];
  const client = new Client();
  Object.defineProperty(client, 'query', {
    value: async (query: string) => {
      queries.push(query);
      if (query.startsWith('select')) {
        return { rows: [{ contacts, legacy }] };
      }
      if (query.startsWith('alter table') && renameFailure !== undefined) {
        throw renameFailure;
      }
      return { rows: [] };
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

test('atomically renames the legacy journal before the Contacts migration chain', async () => {
  const fixture = journalClient(true, false);

  await assert.doesNotReject(async () => {
    assert.equal(await prepareContactsMigration(fixture.client), 'legacy');
  });
  assert.deepEqual(fixture.queries, [
    'begin',
    `select
        to_regclass('drizzle.__drizzle_migrations_crm') is not null as legacy,
        to_regclass('drizzle.__drizzle_migrations_contacts') is not null as contacts`,
    'alter table drizzle.__drizzle_migrations_crm rename to __drizzle_migrations_contacts',
    'commit',
  ]);
});

test('fresh and already-migrated journal states are committed no-ops', async () => {
  await Promise.all(
    (
      [
        [false, false, 'fresh'],
        [false, true, 'contacts'],
      ] as const
    ).map(async ([legacy, contacts, expected]) => {
      const fixture = journalClient(legacy, contacts);
      assert.equal(await prepareContactsMigration(fixture.client), expected);
      assert.equal(fixture.queries[0], 'begin');
      assert.equal(fixture.queries.at(-1), 'commit');
      assert.equal(
        fixture.queries.some((query) => query.startsWith('alter table')),
        false,
      );
    }),
  );
});

test('ambiguous or failed journal handoff rolls back without claiming success', async () => {
  const ambiguous = journalClient(true, true);
  await assert.rejects(
    prepareContactsMigration(ambiguous.client),
    /both CRM and Contacts journals exist/u,
  );
  assert.equal(ambiguous.queries.at(-1), 'rollback');
  assert.equal(
    ambiguous.queries.some((query) => query.startsWith('alter table')),
    false,
  );

  const renameFailure = journalClient(true, false, new Error('rename failed'));
  await assert.rejects(prepareContactsMigration(renameFailure.client), /rename failed/u);
  assert.equal(renameFailure.queries.at(-1), 'rollback');
  assert.equal(renameFailure.queries.includes('commit'), false);
});
