// @effect-diagnostics strictEffectProvide:off -- Test-owned scripted database entrypoint; expires: 2026-12-31.
import { PgClient } from '@effect/sql-pg';
import { Effect, Layer } from 'effect';
import { expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/reactivity';
import { SqlError, UnknownError } from 'effect/sql/SqlError';

import { scriptedPgClientLayer } from '../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../packages/core-runtime/tests/support/sql-connection.ts';
import {
  PARTY_STRUCTURED_NAMES_PREPARATION_SQL,
  PARTY_STRUCTURED_NAMES_PROBE_SQL,
  preparePartyStructuredNames,
} from '../../scripts/prepare-party-structured-names.mts';

const structuredKeys = ['firstName', 'lastName', 'businessName'] as const;

// Relations that must never be written by this preparation: fact assertions, Party identity and the
// candidate case's own party links.
const protectedRelations = [
  'party.parties',
  'party_fact_assertions',
  'party_official_identifiers',
  'party_identifier_claims',
  'party_contact_points',
  'party_contact_point_purposes',
  'party_match_decisions',
  'duplicate_candidate_case_parties',
] as const;

interface ScriptedPreparation {
  readonly preparationFailure?: SqlError;
  readonly prepared?: number;
  readonly present: boolean;
  readonly probeFailure?: SqlError;
}

// Runs the preparation through Effect's own transaction controls over a scripted connection.
const runPreparation = ({ present, prepared = 0, probeFailure, preparationFailure }: ScriptedPreparation) => {
  const queries: string[] = [];
  const execute = (query: string) => {
    queries.push(query);
    if (query === PARTY_STRUCTURED_NAMES_PROBE_SQL) {
      return probeFailure === undefined ? Effect.succeed([{ present }]) : Effect.fail(probeFailure);
    }
    if (query === PARTY_STRUCTURED_NAMES_PREPARATION_SQL) {
      return preparationFailure === undefined ? Effect.succeed([{ prepared }]) : Effect.fail(preparationFailure);
    }
    return Effect.succeed([]);
  };
  return Effect.gen(function* prepareScriptedPartyStructuredNames() {
    return yield* preparePartyStructuredNames(yield* PgClient.PgClient);
  }).pipe(
    Effect.provide(
      scriptedPgClientLayer(Effect.succeed(testSqlConnection(execute))).pipe(Layer.provideMerge(Reactivity.layer)),
    ),
    Effect.map((state) => ({ queries, state })),
    Effect.mapError((failure) => ({ failure, queries })),
  );
};

it('adds only absent structured keys, as JSON null, to legacy names-array snapshots', () => {
  const statement = PARTY_STRUCTURED_NAMES_PREPARATION_SQL;
  const occurrences = (needle: string) => statement.split(needle).length - 1;

  expect(PARTY_STRUCTURED_NAMES_PROBE_SQL.startsWith('select')).toBe(true);
  expect(statement.startsWith('with prepared_rows as (')).toBe(true);
  // Exactly one write, on the candidate snapshot table alone.
  expect(occurrences('update party.duplicate_candidate_cases')).toBe(1);
  expect(occurrences('jsonb_build_object(')).toBe(1);
  for (const key of structuredKeys) {
    // Existing structured values win: a present key keeps its own value, only an absent key becomes null.
    expect(statement).toContain(
      `case when candidate_snapshot ? '${key}' then candidate_snapshot -> '${key}' else 'null'::jsonb end`,
    );
  }
  expect(occurrences("'null'::jsonb end")).toBe(structuredKeys.length);
  expect(statement).toContain("where jsonb_typeof(candidate_snapshot) = 'object'");
  // Scope is the recognizable legacy shape only, never generic malformed current data.
  expect(statement).toContain("and jsonb_typeof(candidate_snapshot -> 'names') = 'array'");
  expect(statement).toContain("and not candidate_snapshot ?& array['firstName', 'lastName', 'businessName']");
  expect(statement).toContain('returning 1');
  // `names` is only ever read for scoping, never split into facts or removed.
  expect(occurrences("'names'")).toBe(1);
  expect(statement).not.toContain('jsonb_build_array');
  // No member is removed: the jsonb delete operator (`- `) never appears.
  expect(occurrences('candidate_snapshot - ')).toBe(0);
});

it.effect('a fresh database without the candidate table is a committed no-op', () =>
  Effect.gen(function* freshDatabaseNoOp() {
    const { queries, state } = yield* runPreparation({ present: false });

    expect(state).toBe('absent');
    expect(queries).toEqual(['BEGIN', PARTY_STRUCTURED_NAMES_PROBE_SQL, 'COMMIT']);
    expect(queries.includes(PARTY_STRUCTURED_NAMES_PREPARATION_SQL)).toBe(false);
  }),
);

it.effect('prepares legacy rows inside the serialized convergence transaction', () =>
  Effect.gen(function* preparesLegacyRows() {
    const { queries, state } = yield* runPreparation({ present: true, prepared: 3 });

    expect(state).toBe('prepared');
    expect(queries).toEqual([
      'BEGIN',
      PARTY_STRUCTURED_NAMES_PROBE_SQL,
      PARTY_STRUCTURED_NAMES_PREPARATION_SQL,
      'COMMIT',
    ]);
  }),
);

it.effect('a second preparation rewrites nothing and reports unchanged', () =>
  Effect.gen(function* secondPreparationIsNoOp() {
    const first = yield* runPreparation({ present: true, prepared: 2 });
    const second = yield* runPreparation({ present: true, prepared: 0 });

    expect(first.state).toBe('prepared');
    expect(second.state).toBe('unchanged');
    // The statement is byte-stable, so its own `?&` guard leaves already-complete rows out of the write set.
    expect(second.queries).toEqual(first.queries);
  }),
);

it.effect('probe failure stays typed, exposes no SQL, and rolls back the outer transaction', () =>
  Effect.gen(function* rollsBackProbeFailure() {
    const probeError = new SqlError({ reason: new UnknownError({ cause: new Error('probe failed') }) });
    const { failure, queries } = yield* Effect.flip(runPreparation({ present: true, probeFailure: probeError }));

    expect(failure.message).toBe('PostgreSQL candidate snapshot probe failed');
    expect(failure.message).not.toContain('select');
    expect(failure.cause).toBe(probeError);
    expect(queries.at(-1)).toBe('ROLLBACK');
    expect(queries.includes('COMMIT')).toBe(false);
    expect(queries.includes(PARTY_STRUCTURED_NAMES_PREPARATION_SQL)).toBe(false);
  }),
);

it.effect('preparation failure stays typed, exposes no SQL, and rolls back the outer transaction', () =>
  Effect.gen(function* rollsBackPreparationFailure() {
    const preparationError = new SqlError({ reason: new UnknownError({ cause: new Error('update failed') }) });
    const { failure, queries } = yield* Effect.flip(
      runPreparation({ present: true, preparationFailure: preparationError }),
    );

    expect(failure.message).toBe('PostgreSQL candidate snapshot preparation failed');
    expect(failure.message).not.toContain('update');
    expect(failure.cause).toBe(preparationError);
    expect(queries.at(-1)).toBe('ROLLBACK');
    expect(queries.includes('COMMIT')).toBe(false);
  }),
);

it.effect('no statement writes fact assertions or identity tables', () =>
  Effect.gen(function* writesOnlyCandidateSnapshots() {
    const { queries } = yield* runPreparation({ present: true, prepared: 1 });
    const statements = queries.filter((query) => !['BEGIN', 'COMMIT', 'ROLLBACK'].includes(query));

    expect(statements).toEqual([PARTY_STRUCTURED_NAMES_PROBE_SQL, PARTY_STRUCTURED_NAMES_PREPARATION_SQL]);
    for (const statement of statements) {
      for (const relation of protectedRelations) {
        expect(statement).not.toContain(relation);
      }
      expect(statement).not.toContain('insert into');
      expect(statement).not.toContain('delete from');
      expect(statement).not.toContain('alter table');
      expect(statement).not.toContain('drop ');
      expect(statement).not.toContain('truncate');
    }
  }),
);
