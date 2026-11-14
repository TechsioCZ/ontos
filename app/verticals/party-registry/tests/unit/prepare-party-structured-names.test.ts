// @effect-diagnostics strictEffectProvide:off -- Test-owned scripted database entrypoint; expires: 2026-12-31.
import { fileURLToPath } from 'node:url';

import { NodeFileSystem } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Effect, FileSystem, Layer } from 'effect';
import { expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/reactivity';
import { SqlError, UnknownError } from 'effect/sql/SqlError';

import { scriptedPgClientLayer } from '../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../packages/core-runtime/tests/support/sql-connection.ts';
import {
  PARTY_ASSERTION_HISTORY_ARCHIVE_SQL,
  PARTY_ASSERTION_HISTORY_CONSERVATION_SQL,
  PARTY_ASSERTION_HISTORY_DEFER_SQL,
  PARTY_ASSERTION_HISTORY_VALIDATE_SQL,
  PARTY_ASSERTION_HISTORY_MIGRATION_SQL,
  PARTY_ASSERTION_HISTORY_REGISTRATION_SQL,
  PARTY_ASSERTION_HISTORY_REMOVE_SQL,
  PARTY_ASSERTION_HISTORY_RETARGET_SQL,
  PARTY_ASSERTION_HISTORY_SEED_SQL,
  PARTY_ASSERTION_HISTORY_STRUCTURE_SQL,
  PARTY_STRUCTURED_NAMES_PREPARATION_SQL,
  PARTY_STRUCTURED_NAMES_PROBE_SQL,
  preparePartyStructuredNames,
} from '../../scripts/prepare-party-structured-names.mts';

const structuredKeys = ['firstName', 'lastName', 'businessName'] as const;

const migrationFolder = '20261109093237_party-fact-assertion-identities';

// Relations the snapshot preparation must never write: fact assertions, Party identity and the candidate
// case's own party links.
const protectedSnapshotRelations = [
  'party.parties',
  'party_fact_assertions',
  'party_official_identifiers',
  'party_identifier_claims',
  'party_contact_points',
  'party_contact_point_purposes',
  'party_match_decisions',
  'duplicate_candidate_case_parties',
] as const;

// The assertion-history preparation is confined to the assertion tables it owns; every other Party
// relation, and every correction row, stays untouched.
const untouchedHistoryRelations = [
  'party_aliases',
  'party_contact_point',
  'party_match_decisions',
  'party_merges',
  'party_official_identifiers',
  'party_relationships',
  'duplicate_candidate_case',
] as const;

interface ScriptedRows {
  readonly archived?: number;
  readonly assertions?: boolean;
  readonly collisions?: number;
  readonly foreignKind?: number;
  readonly prepared?: number;
  readonly present: boolean;
  readonly registered?: boolean;
  readonly remaining?: number;
  readonly removed?: number;
  readonly unregistered?: number;
}

interface ScriptedFailures {
  readonly preparation?: SqlError;
  readonly probe?: SqlError;
  /** The exact statement text that fails, so a mid-history failure is reproducible. */
  readonly statement?: string;
}

const statementFailure = () => new SqlError({ reason: new UnknownError({ cause: new Error('statement failed') }) });

// Runs the preparation through Effect's own transaction controls over a scripted connection.
const runPreparation = (rows: ScriptedRows, failures: ScriptedFailures = {}) => {
  const queries: string[] = [];
  const execute = (query: string) => {
    queries.push(query);
    if (query === PARTY_STRUCTURED_NAMES_PROBE_SQL) {
      return failures.probe === undefined
        ? Effect.succeed([
            {
              assertions: rows.assertions ?? true,
              present: rows.present,
              registered: rows.registered ?? false,
            },
          ])
        : Effect.fail(failures.probe);
    }
    if (query === PARTY_STRUCTURED_NAMES_PREPARATION_SQL) {
      return failures.preparation === undefined
        ? Effect.succeed([{ prepared: rows.prepared ?? 0 }])
        : Effect.fail(failures.preparation);
    }
    if (failures.statement === query) {
      return Effect.fail(statementFailure());
    }
    if (query === PARTY_ASSERTION_HISTORY_REGISTRATION_SQL) {
      return Effect.succeed([{ unregistered: rows.unregistered ?? 0 }]);
    }
    if (query === PARTY_ASSERTION_HISTORY_ARCHIVE_SQL) {
      return Effect.succeed([{ archived: rows.archived ?? 0 }]);
    }
    if (query === PARTY_ASSERTION_HISTORY_REMOVE_SQL) {
      return Effect.succeed([{ removed: rows.removed ?? 0 }]);
    }
    if (query === PARTY_ASSERTION_HISTORY_CONSERVATION_SQL) {
      return Effect.succeed([
        {
          collisions: rows.collisions ?? 0,
          foreignKind: rows.foreignKind ?? 0,
          remaining: rows.remaining ?? 0,
        },
      ]);
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

/** The exact statement order a fully populated current store walks, inside one serialized transaction. */
const historyStatementOrder = [
  PARTY_STRUCTURED_NAMES_PROBE_SQL,
  PARTY_STRUCTURED_NAMES_PREPARATION_SQL,
  ...PARTY_ASSERTION_HISTORY_STRUCTURE_SQL,
  PARTY_ASSERTION_HISTORY_SEED_SQL,
  PARTY_ASSERTION_HISTORY_REGISTRATION_SQL,
  ...PARTY_ASSERTION_HISTORY_RETARGET_SQL,
  PARTY_ASSERTION_HISTORY_ARCHIVE_SQL,
  PARTY_ASSERTION_HISTORY_REMOVE_SQL,
  PARTY_ASSERTION_HISTORY_CONSERVATION_SQL,
  PARTY_ASSERTION_HISTORY_VALIDATE_SQL,
  PARTY_ASSERTION_HISTORY_DEFER_SQL,
];

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

it('conserves the whole retired assertion and never relabels a fact kind', () => {
  expect(PARTY_ASSERTION_HISTORY_ARCHIVE_SQL).toContain('to_jsonb(assertion)');
  expect(PARTY_ASSERTION_HISTORY_ARCHIVE_SQL).toContain(`where assertion.fact_kind = 'DISPLAY_NAME'`);
  expect(PARTY_ASSERTION_HISTORY_ARCHIVE_SQL).toContain('returning 1');
  // The archive is copied, never rewritten: no update, no member removal, no renamed fact kind.
  expect(PARTY_ASSERTION_HISTORY_ARCHIVE_SQL).not.toContain('update ');
  expect(PARTY_ASSERTION_HISTORY_ARCHIVE_SQL).not.toContain('set ');
  expect(PARTY_ASSERTION_HISTORY_ARCHIVE_SQL).not.toContain('BUSINESS_NAME');
  expect(PARTY_ASSERTION_HISTORY_ARCHIVE_SQL).not.toContain(`'business_name'`);
  // A current-store copy is removed only when the archive holds its exact bytes, tenant and party.
  expect(PARTY_ASSERTION_HISTORY_REMOVE_SQL).toContain('archived.original_assertion = to_jsonb(assertion)');
  expect(PARTY_ASSERTION_HISTORY_REMOVE_SQL).toContain('archived.tenant_id = assertion.tenant_id');
  expect(PARTY_ASSERTION_HISTORY_REMOVE_SQL).toContain('archived.party_id = assertion.party_id');
  expect(PARTY_ASSERTION_HISTORY_REMOVE_SQL).toContain(`assertion.fact_kind = 'DISPLAY_NAME'`);
  expect(PARTY_ASSERTION_HISTORY_REMOVE_SQL).not.toContain('update ');
  expect(PARTY_ASSERTION_HISTORY_REMOVE_SQL).not.toContain('BUSINESS_NAME');
  // Nothing legacy may survive, no identity may be both current and archived, no copy may be foreign.
  expect(PARTY_ASSERTION_HISTORY_CONSERVATION_SQL).toContain(`fact_kind = 'DISPLAY_NAME'`);
  expect(PARTY_ASSERTION_HISTORY_CONSERVATION_SQL).toContain('as collisions');
  expect(PARTY_ASSERTION_HISTORY_CONSERVATION_SQL).toContain('as "foreignKind"');
  expect(PARTY_ASSERTION_HISTORY_CONSERVATION_SQL).toContain(`->> 'fact_kind' is distinct from 'DISPLAY_NAME'`);
});

it('registers identities and retargets references without touching corrections or other Party relations', () => {
  expect(PARTY_ASSERTION_HISTORY_SEED_SQL).toContain('insert into "party"."party_fact_assertion_identities"');
  expect(PARTY_ASSERTION_HISTORY_SEED_SQL).toContain('from "party"."party_fact_assertions" as assertion');
  expect(PARTY_ASSERTION_HISTORY_SEED_SQL).toContain('where not exists');
  expect(PARTY_ASSERTION_HISTORY_REGISTRATION_SQL).toContain('as unregistered');

  // Every reference moves to the registry, keeps its name and RESTRICT, and drops nothing.
  expect(PARTY_ASSERTION_HISTORY_RETARGET_SQL).toHaveLength(4);
  for (const statement of PARTY_ASSERTION_HISTORY_RETARGET_SQL) {
    expect(statement).toContain('drop constraint if exists');
    expect(statement).toContain(
      'references "party"."party_fact_assertion_identities" ("tenant_id", "assertion_id") on delete restrict',
    );
    expect(statement).toContain('foreign key');
  }
  expect(PARTY_ASSERTION_HISTORY_RETARGET_SQL.join('\n')).toContain('"party_corrections"');
  expect(PARTY_ASSERTION_HISTORY_RETARGET_SQL.join('\n')).not.toContain('update "party"."party_corrections"');
  expect(PARTY_ASSERTION_HISTORY_RETARGET_SQL.join('\n')).not.toContain('insert into "party"."party_corrections"');
  expect(PARTY_ASSERTION_HISTORY_RETARGET_SQL.join('\n')).not.toContain('delete from "party"."party_corrections"');

  const history = PARTY_ASSERTION_HISTORY_MIGRATION_SQL.join('\n');
  for (const relation of untouchedHistoryRelations) {
    expect(history, relation).not.toContain(relation);
  }
  // No appended migration statement removes or rewrites an existing assertion row.
  expect(PARTY_ASSERTION_HISTORY_MIGRATION_SQL.some((statement) => statement.includes('delete from'))).toBe(false);
  // `for update` appears in the registry's RLS policy; no statement updates a Party row.
  expect(PARTY_ASSERTION_HISTORY_MIGRATION_SQL.some((statement) => /update\s+"?party/iu.test(statement))).toBe(false);
  for (const statement of PARTY_ASSERTION_HISTORY_MIGRATION_SQL) {
    expect(statement, statement.slice(0, 40)).not.toContain('drop table');
    expect(statement, statement.slice(0, 40)).not.toContain('truncate');
    expect(statement, statement.slice(0, 40)).not.toContain('drop column');
  }
  // Only the conservation-checked delete removes a legacy current-store copy.
  expect(PARTY_ASSERTION_HISTORY_REMOVE_SQL).toContain('delete from "party"."party_fact_assertions" as assertion');
});

it('installs every structural statement idempotently', () => {
  expect(PARTY_ASSERTION_HISTORY_STRUCTURE_SQL.length).toBeGreaterThan(0);
  for (const [index, statement] of PARTY_ASSERTION_HISTORY_STRUCTURE_SQL.entries()) {
    const previous = PARTY_ASSERTION_HISTORY_STRUCTURE_SQL[index - 1] ?? '';
    const idempotent =
      statement.includes('create table if not exists') ||
      statement.includes('create or replace function') ||
      statement.includes('drop policy if exists') ||
      statement.includes('drop trigger if exists') ||
      statement.includes('enable row level security') ||
      statement.includes('force row level security') ||
      statement.includes('revoke execute') ||
      // A bare CREATE POLICY or CREATE TRIGGER is only idempotent behind its own drop guard.
      (statement.startsWith('create policy') && previous.startsWith('drop policy if exists')) ||
      (statement.startsWith('create trigger') && previous.startsWith('drop trigger if exists')) ||
      (statement.startsWith('create constraint trigger') && previous.startsWith('drop trigger if exists'));
    expect(idempotent, statement.slice(0, 60)).toBe(true);
  }
  const structure = PARTY_ASSERTION_HISTORY_STRUCTURE_SQL.join('\n');
  // Both new tables are governed by the module gateway tenant scope and force row-level security.
  expect(structure.match(/enable row level security/gu)).toHaveLength(2);
  expect(structure.match(/force row level security/gu)).toHaveLength(2);
  expect(structure.match(/create policy/gu)).toHaveLength(8);
  // One accessor per policy expression: select, insert, delete once each and update twice.
  expect(structure.match(/trust\.current_tenant_id\(\)/gu)?.length).toBe(10);
  expect(structure).not.toContain('current_setting');
  expect(structure).toContain('"party_registry_runtime"');
  // The archive is immutable, the registry refuses identity reuse, and the collision guard defers to commit.
  expect(structure).toContain('Party historical name assertions are immutable');
  expect(structure).toContain('A Party fact assertion identity belongs to another tenant or party');
  expect(structure).toContain('A Party fact assertion identity cannot be reused once it is archived');
  expect(structure).toContain('A Party fact assertion identity cannot be current and archived at once');
  expect(structure).toContain('deferrable initially deferred');
  // Trigger routines are invoker routines: no SECURITY DEFINER, and PUBLIC loses EXECUTE.
  expect(structure).not.toContain('security definer');
  expect(structure).toContain('from public');
});

it.layer(NodeFileSystem.layer)('party assertion history migration source', (suite) => {
  suite.effect('ships the appended native migration from the same statement source', () =>
    Effect.gen(function* migrationMatchesPreparationSource() {
      const fs = yield* FileSystem.FileSystem;
      const directory = fileURLToPath(new URL(`../../drizzle/${migrationFolder}/`, import.meta.url));
      const text = yield* fs.readFileString(`${directory}migration.sql`);
      expect(text).toBe(`${PARTY_ASSERTION_HISTORY_MIGRATION_SQL.join('--> statement-breakpoint\n')}\n`);
      // The migration cannot archive: archival happens only inside the preparation transaction.
      expect(text).not.toContain(PARTY_ASSERTION_HISTORY_ARCHIVE_SQL);
      expect(text).not.toContain(PARTY_ASSERTION_HISTORY_REMOVE_SQL);
      expect(text).not.toContain(PARTY_ASSERTION_HISTORY_CONSERVATION_SQL);
      // The seed precedes the retarget, so the retarget always validates a populated registry.
      expect(text.indexOf(PARTY_ASSERTION_HISTORY_SEED_SQL)).toBeLessThan(
        text.indexOf(PARTY_ASSERTION_HISTORY_RETARGET_SQL[0] ?? ''),
      );
    }),
  );
});

it.effect('a fresh database without the candidate table is a committed no-op', () =>
  Effect.gen(function* freshDatabaseNoOp() {
    const { queries, state } = yield* runPreparation({ present: false });

    expect(state).toBe('absent');
    expect(queries).toEqual(['BEGIN', PARTY_STRUCTURED_NAMES_PROBE_SQL, 'COMMIT']);
    expect(queries.includes(PARTY_STRUCTURED_NAMES_PREPARATION_SQL)).toBe(false);
    expect(queries.includes(PARTY_ASSERTION_HISTORY_SEED_SQL)).toBe(false);
  }),
);

it.effect('prepares legacy rows inside the serialized convergence transaction', () =>
  Effect.gen(function* preparesLegacyRows() {
    const { queries, state } = yield* runPreparation({ present: true, prepared: 3 });

    expect(state).toBe('prepared');
    expect(queries).toEqual(['BEGIN', ...historyStatementOrder, 'COMMIT']);
  }),
);

it.effect('installs the assertion history structures before any fact kind narrows', () =>
  Effect.gen(function* installsHistoryStructures() {
    const { queries, state } = yield* runPreparation({ present: true });

    expect(state).toBe('installed');
    expect(queries).toEqual(['BEGIN', ...historyStatementOrder, 'COMMIT']);
    const seed = queries.indexOf(PARTY_ASSERTION_HISTORY_SEED_SQL);
    const retarget = queries.indexOf(PARTY_ASSERTION_HISTORY_RETARGET_SQL[0] ?? '');
    const archive = queries.indexOf(PARTY_ASSERTION_HISTORY_ARCHIVE_SQL);
    const remove = queries.indexOf(PARTY_ASSERTION_HISTORY_REMOVE_SQL);
    const conservation = queries.indexOf(PARTY_ASSERTION_HISTORY_CONSERVATION_SQL);
    // Registry first, then retarget, then copy, then remove, then prove conservation.
    expect(seed).toBeGreaterThan(-1);
    expect(seed).toBeLessThan(retarget);
    expect(retarget).toBeLessThan(archive);
    expect(archive).toBeLessThan(remove);
    expect(remove).toBeLessThan(conservation);
  }),
);

it.effect('archives legacy display-name assertions losslessly and reports prepared', () =>
  Effect.gen(function* archivesLegacyNames() {
    const { state } = yield* runPreparation({ archived: 2, present: true, removed: 2 });

    expect(state).toBe('prepared');
  }),
);

it.effect('a second preparation rewrites nothing and reports unchanged', () =>
  Effect.gen(function* secondPreparationIsNoOp() {
    const first = yield* runPreparation({ archived: 2, present: true, prepared: 2, removed: 2 });
    const second = yield* runPreparation({ present: true, registered: true });

    expect(first.state).toBe('prepared');
    expect(second.state).toBe('unchanged');
    // Every statement is byte-stable, so the second run issues exactly the same SQL and writes no row.
    expect(second.queries).toEqual(first.queries);
  }),
);

it.effect('refuses an identity that already belongs to another tenant or party', () =>
  Effect.gen(function* refusesCrossTenantIdentityReuse() {
    const { failure, queries } = yield* Effect.flip(runPreparation({ present: true, unregistered: 1 }));

    expect(failure.message).toBe('PostgreSQL Party assertion identity registration failed');
    expect(failure.message).not.toContain('select');
    expect(queries.at(-1)).toBe('ROLLBACK');
    expect(queries.includes('COMMIT')).toBe(false);
    expect(queries.includes(PARTY_ASSERTION_HISTORY_ARCHIVE_SQL)).toBe(false);
    expect(queries.includes(PARTY_ASSERTION_HISTORY_RETARGET_SQL[0] ?? '')).toBe(false);
  }),
);

it.effect('refuses a legacy copy the archive could not conserve', () =>
  Effect.gen(function* refusesUnconservedCopy() {
    const { failure, queries } = yield* Effect.flip(runPreparation({ archived: 2, present: true, removed: 1 }));

    expect(failure.message).toBe('PostgreSQL Party historical name archival failed');
    expect(queries.at(-1)).toBe('ROLLBACK');
    expect(queries.includes(PARTY_ASSERTION_HISTORY_CONSERVATION_SQL)).toBe(false);
  }),
);

it.effect('refuses an archive that still collides with the current store', () =>
  Effect.gen(function* refusesArchiveCollision() {
    const { failure, queries } = yield* Effect.flip(
      runPreparation({ archived: 1, present: true, remaining: 1, removed: 1 }),
    );

    expect(failure.message).toBe('PostgreSQL Party historical name conservation check failed');
    expect(queries.at(-1)).toBe('ROLLBACK');
    expect(queries.includes('COMMIT')).toBe(false);
  }),
);

it.effect('refuses a foreign archived fact kind', () =>
  Effect.gen(function* refusesForeignArchivedKind() {
    const { failure } = yield* Effect.flip(runPreparation({ archived: 1, foreignKind: 1, present: true, removed: 1 }));

    expect(failure.message).toBe('PostgreSQL Party historical name conservation check failed');
  }),
);

it.effect('probe failure stays typed, exposes no SQL, and rolls back the outer transaction', () =>
  Effect.gen(function* rollsBackProbeFailure() {
    const probeError = new SqlError({ reason: new UnknownError({ cause: new Error('probe failed') }) });
    const { failure, queries } = yield* Effect.flip(runPreparation({ present: true }, { probe: probeError }));

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
      runPreparation({ present: true }, { preparation: preparationError }),
    );

    expect(failure.message).toBe('PostgreSQL candidate snapshot preparation failed');
    expect(failure.message).not.toContain('update');
    expect(failure.cause).toBe(preparationError);
    expect(queries.at(-1)).toBe('ROLLBACK');
    expect(queries.includes('COMMIT')).toBe(false);
    expect(queries.includes(PARTY_ASSERTION_HISTORY_SEED_SQL)).toBe(false);
  }),
);

it.effect('a structural failure stays typed and rolls back before any legacy row is archived', () =>
  Effect.gen(function* rollsBackStructuralFailure() {
    const { failure, queries } = yield* Effect.flip(
      runPreparation({ present: true }, { statement: PARTY_ASSERTION_HISTORY_STRUCTURE_SQL[0] ?? '' }),
    );

    expect(failure.message).toBe('PostgreSQL Party assertion history installation failed');
    expect(failure.message).not.toContain('create table');
    expect(queries.at(-1)).toBe('ROLLBACK');
    expect(queries.includes(PARTY_ASSERTION_HISTORY_SEED_SQL)).toBe(false);
    expect(queries.includes(PARTY_ASSERTION_HISTORY_ARCHIVE_SQL)).toBe(false);
  }),
);

it.effect('drains deferred archive checks before native DDL and rolls back if they refuse', () =>
  Effect.gen(function* drainsArchiveChecks() {
    const { failure, queries } = yield* Effect.flip(
      runPreparation({ archived: 1, present: true, removed: 1 }, { statement: PARTY_ASSERTION_HISTORY_VALIDATE_SQL }),
    );
    expect(failure.message).toBe('PostgreSQL Party historical name conservation check failed');
    expect(queries.indexOf(PARTY_ASSERTION_HISTORY_VALIDATE_SQL)).toBeGreaterThan(
      queries.indexOf(PARTY_ASSERTION_HISTORY_REMOVE_SQL),
    );
    expect(queries).not.toContain(PARTY_ASSERTION_HISTORY_DEFER_SQL);
    expect(queries.at(-1)).toBe('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
  }),
);

it('keeps registered identities attached to their Party and refuses archival identity substitution', () => {
  const structure = PARTY_ASSERTION_HISTORY_STRUCTURE_SQL.join('\n');
  expect(structure).toContain('constraint "party_fact_assertion_identities_tenant_party_fk" foreign key');
  expect(structure).toContain('references "party"."parties" ("tenant_id", "party_id") on delete restrict');
  expect(structure).toContain('before insert or update of assertion_id, tenant_id, party_id');
  expect(structure).toContain("new.original_assertion ->> 'assertion_id' is distinct from new.assertion_id::text");
  expect(structure).toContain("new.original_assertion ->> 'tenant_id' is distinct from new.tenant_id::text");
  expect(structure).toContain("new.original_assertion ->> 'party_id' is distinct from new.party_id::text");
});

it.effect('no statement writes fact assertions or identity tables outside the assertion history path', () =>
  Effect.gen(function* writesOnlyOwnedRelations() {
    const { queries } = yield* runPreparation({ present: true, prepared: 1 });
    const statements = queries.filter((query) => !['BEGIN', 'COMMIT', 'ROLLBACK'].includes(query));

    expect(statements).toEqual(historyStatementOrder);
    for (const relation of protectedSnapshotRelations) {
      expect(PARTY_STRUCTURED_NAMES_PREPARATION_SQL).not.toContain(relation);
    }
    expect(PARTY_STRUCTURED_NAMES_PREPARATION_SQL).not.toContain('insert into');
    expect(PARTY_STRUCTURED_NAMES_PREPARATION_SQL).not.toContain('delete from');
    expect(PARTY_STRUCTURED_NAMES_PREPARATION_SQL).not.toContain('alter table');
    expect(PARTY_STRUCTURED_NAMES_PREPARATION_SQL).not.toContain('drop ');
    expect(PARTY_STRUCTURED_NAMES_PREPARATION_SQL).not.toContain('truncate');
  }),
);
