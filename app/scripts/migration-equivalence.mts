import type { MigrationMeta } from 'drizzle-orm/migrator';
import { Effect, Schema } from 'effect';

export const MigrationHistorySchema = Schema.Literals(['contacts', 'core', 'party']);
export type MigrationHistory = typeof MigrationHistorySchema.Type;

export class MigrationEquivalenceError extends Schema.TaggedError<MigrationEquivalenceError>()(
  'MigrationEquivalenceError',
  { history: MigrationHistorySchema, reason: Schema.String },
) {}

/** These are historical identities, not a general content-hash deduplication rule. */
export const MIGRATION_EQUIVALENCES = [
  {
    demo: '20261024090000_trusted-gateway-scope',
    hash: '2b682c3cbb2b9bbf6888134f707d946a96a35c2c9b2889ba5810f81367eeadcd',
    history: 'core',
    main: '20261020062648_trusted-gateway-scope',
  },
  {
    demo: '20261024090100_dedicated-identity-core-policies',
    hash: 'c48caac1577ba5ef2b8f8c5da2c055132c9b1473ee74e8e9f199749c90a80aed',
    history: 'core',
    main: '20261020063004_dedicated-identity-core-policies',
  },
  {
    demo: '20261024090200_legal-entity-scope',
    hash: 'bf1d792532f81002d15727a7903ca2fd00dbfaca00936aa6aee86632557feb3e',
    history: 'core',
    main: '20261020113601_legal-entity-scope',
  },
  {
    demo: '20261024090300_party-gateway-scope-rls',
    hash: 'a9567fcdc43f015ae0040122d23a8d8024c4534510ea2fbdb61a587fd0aab674',
    history: 'party',
    main: '20261020063911_party-gateway-scope-rls',
  },
  {
    demo: '20261024090400_legal-entity-scope',
    hash: 'a0232c3232de2bba171fdacc4aa07171fff5dadaf69317c9840f3b90aa3c1db8',
    history: 'party',
    main: '20261020113551_legal-entity-scope',
  },
  {
    demo: '20261024090301_contacts-gateway-scope-rls',
    hash: 'a9416ddd7f51c60f13979f4a6688b8915a60b09a8e7896bfdfe65cefaa82abe9',
    history: 'contacts',
    main: '20261020063912_contacts-gateway-scope-rls',
  },
] as const;

export const MIGRATION_MERGES = {
  contacts: '20261027230000_contacts-migration-equivalence',
  core: '20261027230000_core-migration-equivalence',
  party: '20261027230000_party-migration-equivalence',
} as const;

export const MIGRATION_MERGE_SQL =
  '-- Snapshot-only convergence of the reviewed exact migration identities.\nselect 1;\n';

export const MigrationLedgerRowSchema = Schema.Struct({
  created_at: Schema.Union([Schema.Number, Schema.String, Schema.BigInt]),
  hash: Schema.String,
  id: Schema.Union([Schema.Int, Schema.NumberFromString]).pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
  name: Schema.String,
});
export type MigrationLedgerRow = typeof MigrationLedgerRowSchema.Type;

export interface MigrationEquivalencePlan {
  readonly history: MigrationHistory;
  readonly lineage: 'main' | 'demo';
  /** Full selected history, including applied names. Native Drizzle decides which remain pending. */
  readonly migrations: MigrationMeta[];
}

const validateAppliedMigrations = Effect.fn('MigrationConvergence.validateAppliedMigrations')(function* validate(
  history: MigrationHistory,
  byName: ReadonlyMap<string, MigrationMeta>,
  ledger: readonly MigrationLedgerRow[],
) {
  const names = new Set<string>();
  const ids = new Set<number>();
  for (const row of ledger) {
    const local = byName.get(row.name);
    if (
      names.has(row.name) ||
      ids.has(row.id) ||
      local === undefined ||
      local.hash !== row.hash ||
      Number(row.created_at) !== local.folderMillis
    ) {
      return yield* new MigrationEquivalenceError({
        history,
        reason: 'Applied migration identity, timestamp or content hash is not recognized',
      });
    }
    names.add(row.name);
    ids.add(row.id);
  }
  return names;
});

export const planEquivalentMigrations = Effect.fn('MigrationConvergence.planEquivalentMigrations')(function* plan(
  history: MigrationHistory,
  migrations: readonly MigrationMeta[],
  ledger: readonly MigrationLedgerRow[],
) {
  const failure = (reason: string) => new MigrationEquivalenceError({ history, reason });
  const byName = new Map(migrations.map((migration) => [migration.name, migration]));
  if (byName.size !== migrations.length) {
    return yield* failure('Duplicate local migration identity');
  }
  const pairs = MIGRATION_EQUIVALENCES.filter((pair) => pair.history === history);
  for (const pair of pairs) {
    if (byName.get(pair.main)?.hash !== pair.hash || byName.get(pair.demo)?.hash !== pair.hash) {
      return yield* failure('Historical equivalent migration bytes changed or are missing');
    }
  }
  const merge = byName.get(MIGRATION_MERGES[history]);
  if (merge?.sql.join('--> statement-breakpoint') !== MIGRATION_MERGE_SQL) {
    return yield* failure('Snapshot convergence checkpoint is missing or contains unexpected SQL');
  }
  const names = yield* validateAppliedMigrations(history, byName, ledger);
  const mainApplied = pairs.some((pair) => names.has(pair.main));
  const demoApplied = pairs.some((pair) => names.has(pair.demo));
  if (mainApplied && demoApplied) {
    return yield* failure('Both equivalent naming lineages occur in the applied journal');
  }
  const lineage = demoApplied ? 'demo' : 'main';
  let missingPredecessor = false;
  for (const pair of pairs) {
    if (names.has(pair[lineage]) && missingPredecessor) {
      return yield* failure('An equivalent migration has no applied predecessor');
    }
    missingPredecessor ||= !names.has(pair[lineage]);
  }
  if (names.has(MIGRATION_MERGES[history]) && missingPredecessor) {
    return yield* failure('Convergence checkpoint has incomplete historical evidence');
  }
  const excluded = new Set<string>(pairs.map((pair) => (lineage === 'demo' ? pair.main : pair.demo)));
  return {
    history,
    lineage,
    migrations: migrations
      .filter((migration) => !excluded.has(migration.name))
      .map((migration) => ({
        ...migration,
        sql: [...migration.sql],
      })),
  } satisfies MigrationEquivalencePlan;
});
