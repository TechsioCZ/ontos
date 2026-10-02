import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ApplicationCompositionAuthorityError,
  lockApplicationCompositionAuthority,
  lockApplicationCompositionPublication,
} from '../../src/modules/application-composition-authority.ts';
import { makeTestDatabase } from '../support/database.ts';

const revision = 'a'.repeat(64);
const admittedRow = {
  phase: 'active',
  revision,
  subscriptionsJson: [],
  unexpired: true,
} as const;

const scriptedRows = (statement: string, authorityRows: readonly object[]) => {
  if (statement.includes('transaction_isolation')) {
    return Effect.succeed([{ isolation: 'read committed' }]);
  }
  return Effect.succeed(statement.includes('from "core"."application_composition_authority"') ? authorityRows : []);
};

it.effect('owner writes hold native shared publication lock until their transaction commits', () =>
  Effect.gen(function* admittedOwnerTransaction() {
    const statements: string[] = [];
    const database = yield* makeTestDatabase((statement) => {
      statements.push(statement);
      return scriptedRows(statement, [admittedRow]);
    });
    expect(
      yield* database.transaction((transaction) => lockApplicationCompositionAuthority(transaction, revision, 'write')),
    ).toEqual([]);
    expect(statements[0]).toMatch(/begin/iu);
    expect(statements[1]).toContain('transaction_isolation');
    expect(statements[2]).toContain('pg_advisory_xact_lock_shared');
    expect(statements[3]).toContain('clock_timestamp()');
    expect(statements.at(-1)).toMatch(/commit/iu);
  }),
);

it.effect('missing, expired, or superseded authority rejects the owner transaction', () =>
  Effect.gen(function* invalidAuthorityTransactions() {
    for (const rows of [[], [{ ...admittedRow, unexpired: false }], [{ ...admittedRow, revision: 'b'.repeat(64) }]]) {
      const statements: string[] = [];
      const database = yield* makeTestDatabase((statement) => {
        statements.push(statement);
        return scriptedRows(statement, rows);
      });
      const failure = yield* database
        .transaction((transaction) => lockApplicationCompositionAuthority(transaction, revision, 'write'))
        .pipe(Effect.flip);
      expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
      expect(statements.at(-1)).toMatch(/rollback/iu);
    }
  }),
);

it.effect('draining stops producers but keeps old-release matching and worker writes live', () =>
  Effect.gen(function* drainingAuthorityTransactions() {
    const database = yield* makeTestDatabase((statement) =>
      scriptedRows(statement, [{ ...admittedRow, phase: 'draining' }]),
    );
    const producerFailure = yield* database
      .transaction((transaction) => lockApplicationCompositionAuthority(transaction, revision, 'write'))
      .pipe(Effect.flip);
    expect(Schema.is(ApplicationCompositionAuthorityError)(producerFailure)).toBe(true);
    for (const operation of ['match', 'worker'] as const) {
      expect(
        yield* database.transaction((transaction) =>
          lockApplicationCompositionAuthority(transaction, revision, operation),
        ),
      ).toEqual([]);
    }
  }),
);

it.effect('unsupported transaction snapshots cannot bypass either side of the publication fence', () =>
  Effect.gen(function* unsupportedIsolationTransactions() {
    for (const isolation of ['repeatable read', 'serializable']) {
      const statements: string[] = [];
      const database = yield* makeTestDatabase((statement) => {
        statements.push(statement);
        return Effect.succeed(statement.includes('transaction_isolation') ? [{ isolation }] : []);
      });
      for (const lock of [
        (transaction: Parameters<typeof lockApplicationCompositionAuthority>[0]) =>
          lockApplicationCompositionAuthority(transaction, revision, 'write').pipe(Effect.asVoid),
        (transaction: Parameters<typeof lockApplicationCompositionAuthority>[0]) =>
          lockApplicationCompositionPublication(transaction).pipe(Effect.asVoid),
      ]) {
        const failure = yield* database.transaction(lock).pipe(Effect.flip);
        expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
      }
      expect(statements.some((statement) => statement.includes('pg_advisory_xact_lock'))).toBe(false);
    }
  }),
);

it.effect('sealed and migrated authority reject every old-release operation and draining rejects new reads', () =>
  Effect.gen(function* retiredAuthorityOperations() {
    for (const phase of ['sealed', 'migrated']) {
      const retired = yield* makeTestDatabase((statement) => scriptedRows(statement, [{ ...admittedRow, phase }]));
      for (const operation of ['read', 'write', 'match', 'worker'] as const) {
        const failure = yield* retired
          .transaction((transaction) => lockApplicationCompositionAuthority(transaction, revision, operation))
          .pipe(Effect.flip);
        expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
        expect(failure).toMatchObject({ reason: expect.stringMatching(/sealed/u) });
      }
    }
    const draining = yield* makeTestDatabase((statement) =>
      scriptedRows(statement, [{ ...admittedRow, phase: 'draining' }]),
    );
    const failedRead = yield* draining
      .transaction((transaction) => lockApplicationCompositionAuthority(transaction, revision, 'read'))
      .pipe(Effect.flip);
    expect(Schema.is(ApplicationCompositionAuthorityError)(failedRead)).toBe(true);
  }),
);
