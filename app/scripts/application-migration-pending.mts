/// <reference types="node" />
/**
 * Whether the migrator may leave out one owner's `drizzle-kit migrate` child. It decides two things, and on any doubt
 * the child runs exactly as before.
 *
 * 1. The database: would Drizzle 1.0.0-rc.5 apply anything? Drizzle (`drizzle-orm/migrator.js` `readMigrationFiles`,
 *    `pg-core/async/session.js` `migrate`, `migrator.utils.js` `getMigrationsToRun`) runs every local folder entry
 *    holding a `migration.sql` whose NAME no journal row carries, never comparing timestamps. The planner says
 *    "nothing to apply" only when the journal exists with `name` and `hash` columns and holds exactly the local
 *    migrations, each with its name AND the SHA-256 of its SQL, and nothing else. A pending name (also an older one
 *    added late), an absent or unreadable journal, an unnamed or duplicated row, a hash that differs, a row no local
 *    folder carries, a folder entry that is not a reviewed migration name, an old `meta/_journal.json`, a
 *    configuration that is not the workspace's own shape, or no admin URL in the process environment (the value the
 *    child's `defineWorkspaceDrizzleConfig` uses) all run the child.
 * 2. The folder: would `drizzle-kit migrate` refuse it before touching the database? Before it migrates, the CLI runs
 *    `assertOrmCoreVersion`, `assertPackages("drizzle-orm")`, `assertV3OutFolder` and `checkHandler` (every
 *    `snapshot.json` parses and is of the current version; no two snapshot branches conflict). For an owner it would
 *    skip, the planner runs the same checks in process through the owner's own drizzle-kit and its public
 *    `drizzle-kit/cli` `check` (`assertOrmCoreVersion`, `assertV3OutFolder`, `checkHandler`; the version assertion
 *    imports `drizzle-orm`, so a missing package fails it too). Anything but `ok`, or a drizzle-kit that cannot be
 *    loaded, runs the child, which then refuses the boot with its own message.
 *
 * It relies on CI for nothing it decides: CI (`service-integration`, through the required `Workspace gates` check)
 * migrates a fresh database with every owner's drizzle-kit on the path to `main`, but the `demo/sales-crm` stage path
 * has no such gate, so these boot checks stand on their own.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PgClient } from '@effect/sql-pg';
import { Config, Context, Duration, Effect, FileSystem, Layer, Option, Predicate, Redacted, Ref, Schema } from 'effect';

/** A local migration as Drizzle reads it: its folder name and the SHA-256 of its `migration.sql` bytes. */
export interface LocalMigration {
  readonly hash: string;
  readonly name: string;
}

/** One journal row. An empty name is a row Drizzle stored without one. */
export interface JournalRow {
  readonly hash: string;
  readonly name: string;
}

/** The journal as PostgreSQL holds it: its columns (none when the table does not exist) and its rows. */
interface JournalEvidence {
  readonly columns: readonly string[];
  readonly rows: readonly JournalRow[];
}

interface OwnerMigrationDecision {
  /** True only when Drizzle provably runs nothing: the journal holds exactly the local migrations. */
  readonly nothingToApply: boolean;
  /** The local migrations Drizzle would run, by its own name rule; empty when the evidence was uncertain. */
  readonly pending: readonly string[];
  /** One line for the operator: what was found, or why the child runs anyway. */
  readonly reason: string;
}

const spawnBecause = (reason: string): OwnerMigrationDecision => ({ nothingToApply: false, pending: [], reason });

/**
 * The pure decision. `local` is `None` when the folder is not in a shape this decision mirrors exactly; `journal` is
 * `None` when it could not be read. Both mean: run the child as before.
 */
export const decideOwnerMigration = (input: {
  readonly journal: Option.Option<JournalEvidence>;
  readonly local: Option.Option<readonly LocalMigration[]>;
}): OwnerMigrationDecision => {
  if (Option.isNone(input.local)) {
    return spawnBecause('the migration folder is not in the reviewed shape');
  }
  if (Option.isNone(input.journal)) {
    return spawnBecause('the migration journal could not be read');
  }
  const local = input.local.value;
  const { columns, rows } = input.journal.value;
  if (columns.length === 0) {
    return spawnBecause('the migration journal does not exist yet');
  }
  if (!columns.includes('name') || !columns.includes('hash')) {
    return spawnBecause('the migration journal predates named rows');
  }
  if (rows.some((row) => row.name === '')) {
    return spawnBecause('the migration journal holds a row without a name');
  }
  const journaled = new Set(rows.map((row) => row.name));
  // Drizzle's own rule (`getMigrationsToRun`): a local migration runs when no journal row carries its name.
  const pending = local.filter((migration) => !journaled.has(migration.name)).map((migration) => migration.name);
  if (pending.length > 0) {
    return { nothingToApply: false, pending, reason: `${String(pending.length)} pending (${pending.join(', ')})` };
  }
  if (journaled.size !== rows.length) {
    return spawnBecause('the migration journal holds one name twice');
  }
  const byName = new Map(local.map((migration) => [migration.name, migration.hash]));
  if (rows.some((row) => !byName.has(row.name))) {
    return spawnBecause('the migration journal names a migration no local folder carries');
  }
  if (rows.some((row) => byName.get(row.name) !== row.hash)) {
    return spawnBecause('a journaled migration differs from its local SQL');
  }
  return { nothingToApply: true, pending: [], reason: `nothing to apply (${String(rows.length)} journaled)` };
};

const MIGRATION_NAME = /^[0-9]{14}_[a-zA-Z0-9_-]+$/u;
const JOURNAL_NAME = /^__drizzle_migrations_[a-z0-9_]+$/u;
const MIGRATION_FILE = 'migration.sql';

interface OwnerMigrationSource {
  readonly folder: string;
  readonly journalName: string;
}

/** The workspace Drizzle configuration: `defineWorkspaceDrizzleConfig` with one literal `out` and one `table`. */
export const ownerMigrationSourceOf = (configText: string): Option.Option<OwnerMigrationSource> => {
  const tables = [...configText.matchAll(/table:\s*'(?<journal>[^']*)'/gu)];
  const outputs = [...configText.matchAll(/out:\s*'\.\/(?<output>[a-z0-9-]+)'/gu)];
  const journalName = tables[0]?.groups?.journal;
  const folder = outputs[0]?.groups?.output;
  if (
    !configText.includes('defineWorkspaceDrizzleConfig(') ||
    tables.length !== 1 ||
    outputs.length !== 1 ||
    journalName === undefined ||
    folder === undefined ||
    !JOURNAL_NAME.test(journalName)
  ) {
    return Option.none();
  }
  return Option.some({ folder, journalName });
};

/** The folder as `readMigrationFiles` reads it; `None` for anything it would read differently or refuse. */
export const readLocalMigrations = Effect.fn('OwnerMigrationPending.readLocal')(function* readLocalMigrations(
  fs: FileSystem.FileSystem,
  folder: string,
) {
  if (yield* fs.exists(path.join(folder, 'meta', '_journal.json'))) {
    return Option.none<readonly LocalMigration[]>();
  }
  const migrations: LocalMigration[] = [];
  for (const entry of yield* fs.readDirectory(folder)) {
    const file = path.join(folder, entry, MIGRATION_FILE);
    if (!(yield* fs.exists(file))) {
      continue;
    }
    if (!MIGRATION_NAME.test(entry)) {
      return Option.none<readonly LocalMigration[]>();
    }
    // The raw bytes: equal to Drizzle's hash of the decoded text for every UTF-8 file, and any difference only spawns.
    const bytes = yield* fs.readFile(file);
    migrations.push({ hash: createHash('sha256').update(bytes).digest('hex'), name: entry });
  }
  return Option.some<readonly LocalMigration[]>(migrations);
});

/** Per journal read; a slow database costs at most this once, because the first overrun drops the connection. */
const EVIDENCE_TIMEOUT = Duration.seconds(10);

const readJournal = Effect.fn('OwnerMigrationPending.readJournal')(function* readJournal(
  client: PgClient.PgClient,
  journalName: string,
) {
  // The name passed the journal pattern, so it is safe as a literal and as a quoted identifier.
  const columns = yield* client.unsafe<{ readonly column_name: string }>(
    `select a.attname::text as column_name from pg_catalog.pg_attribute as a
     inner join pg_catalog.pg_class as c on c.oid = a.attrelid
     inner join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
     where n.nspname = 'drizzle' and c.relname = '${journalName}' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped`,
  );
  const names = columns.map((row) => row.column_name);
  if (!names.includes('name') || !names.includes('hash')) {
    return { columns: names, rows: [] } satisfies JournalEvidence;
  }
  const rows = yield* client.unsafe<JournalRow>(
    `select coalesce(journal.name, '') as name, journal.hash as hash from drizzle."${journalName}" as journal`,
  );
  return { columns: names, rows: rows.map(({ hash, name }) => ({ hash, name })) } satisfies JournalEvidence;
});

interface FolderCheckOptions {
  readonly dialect: 'postgresql';
  readonly out: string;
}
type FolderCheck = (options: FolderCheckOptions) => Promise<unknown>;

/** drizzle-kit's public SDK (`drizzle-kit/cli`): only its `check`, the CLI's own folder refusals without a process. */
const DrizzleKitSdkSchema = Schema.Struct({
  check: Schema.declare((input: unknown): input is FolderCheck => Predicate.isFunction(input)),
});
const FolderCheckOutcomeSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('ok') }),
  Schema.Struct({ error: Schema.Struct({ code: Schema.String }), status: Schema.Literal('error') }),
]);

/** `None` when drizzle-kit found the folder fine; otherwise why the child must run (and refuse it itself). */
export const folderCheckRefusal = (outcome: unknown): Option.Option<string> => {
  if (!Schema.is(FolderCheckOutcomeSchema)(outcome)) {
    return Option.some('drizzle-kit check answered in an unknown shape');
  }
  return outcome.status === 'ok'
    ? Option.none()
    : Option.some(`drizzle-kit check refused the folder (${outcome.error.code})`);
};

class OwnerFolderCheckError extends Schema.TaggedError<OwnerFolderCheckError>()('OwnerFolderCheckError', {
  reason: Schema.String,
}) {}
const folderCheckUnavailable = (reason: string) => () => new OwnerFolderCheckError({ reason });

const FOLDER_CHECK_TIMEOUT = Duration.seconds(60);

/** The owner's own drizzle-kit SDK, resolved from the owner's directory through the package's public exports. */
const loadOwnerDrizzleKit = (ownerDirectory: string) =>
  Effect.tryPromise({
    catch: folderCheckUnavailable("the owner's drizzle-kit could not be loaded"),
    try: async (): Promise<unknown> => {
      const entry = createRequire(path.join(ownerDirectory, 'package.json')).resolve('drizzle-kit/cli');
      return await import(pathToFileURL(entry).href);
    },
  }).pipe(
    Effect.flatMap((loaded) =>
      Schema.decodeUnknownEffect(DrizzleKitSdkSchema)(loaded).pipe(
        Effect.mapError(folderCheckUnavailable("the owner's drizzle-kit has no check")),
      ),
    ),
  );

/**
 * The folder checks `drizzle-kit migrate` runs before it touches the database, in process. `None`: the folder passed;
 * `Some`: why the child must run instead (it then refuses the boot with drizzle-kit's own message).
 */
export const checkOwnerMigrationFolder = (ownerDirectory: string, folder: string) =>
  loadOwnerDrizzleKit(ownerDirectory).pipe(
    Effect.flatMap((sdk) =>
      Effect.tryPromise({
        catch: folderCheckUnavailable('drizzle-kit check failed to run'),
        try: async () => await sdk.check({ dialect: 'postgresql', out: folder }),
      }),
    ),
    Effect.timeoutOrElse({
      duration: FOLDER_CHECK_TIMEOUT,
      orElse: () => Effect.fail(new OwnerFolderCheckError({ reason: 'drizzle-kit check overran its time budget' })),
    }),
    Effect.map(folderCheckRefusal),
    Effect.catchTag('OwnerFolderCheckError', ({ reason }) => Effect.succeed(Option.some(reason))),
  );

interface OwnerMigrationPlannerService {
  /** Never fails: missing evidence is a decision to run the child. */
  readonly decide: (relativeDirectory: string, config: string) => Effect.Effect<OwnerMigrationDecision>;
}

export class OwnerMigrationPlanner extends Context.Service<OwnerMigrationPlanner, OwnerMigrationPlannerService>()(
  '@app/scripts/OwnerMigrationPlanner',
) {}

const NO_EVIDENCE = 'no database evidence for the journal read';

/** One owner's decision. A journal read that fails or overruns drops the connection for every later owner. */
const decideWith = (
  fs: FileSystem.FileSystem,
  evidence: Ref.Ref<Option.Option<PgClient.PgClient>>,
  appDirectory: string,
  relativeDirectory: string,
  config: string,
) =>
  Effect.gen(function* decideOwner() {
    const ownerDirectory = path.join(appDirectory, relativeDirectory);
    const source = ownerMigrationSourceOf(yield* fs.readFileString(path.join(ownerDirectory, config)));
    if (Option.isNone(source)) {
      return spawnBecause(`${config} is not the workspace Drizzle configuration shape`);
    }
    const local = yield* readLocalMigrations(fs, path.join(ownerDirectory, source.value.folder));
    const client = yield* Ref.get(evidence);
    if (Option.isNone(client)) {
      return spawnBecause(NO_EVIDENCE);
    }
    const journal = yield* readJournal(client.value, source.value.journalName).pipe(
      Effect.timeout(EVIDENCE_TIMEOUT),
      Effect.option,
    );
    if (Option.isNone(journal)) {
      yield* Ref.set(evidence, Option.none());
    }
    const decision = decideOwnerMigration({ journal, local });
    if (!decision.nothingToApply) {
      return decision;
    }
    // Nothing to apply, so the child would only have checked the folder: the same checks run here instead.
    const refusal = yield* checkOwnerMigrationFolder(ownerDirectory, path.join(ownerDirectory, source.value.folder));
    return Option.match(refusal, { onNone: () => decision, onSome: spawnBecause });
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(spawnBecause('the Drizzle configuration or the local migration folder could not be read')),
    ),
    Effect.withSpan('OwnerMigrationPending.decide'),
  );

/**
 * One administrative connection for every owner's journal reads, opened once per migrator run on the URL the child's
 * workspace Drizzle configuration takes from the process environment. Without that URL, or when the connection cannot
 * be opened, the planner has no evidence and every owner spawns as before.
 */
export const OwnerMigrationPlannerLive = (appDirectory: string) =>
  Layer.effect(
    OwnerMigrationPlanner,
    Effect.gen(function* makeOwnerMigrationPlanner() {
      const fs = yield* FileSystem.FileSystem;
      // Any failure here (an invalid setting, an unreachable server) only means no evidence: every owner spawns.
      const client = yield* Effect.gen(function* openEvidenceConnection() {
        const url = Option.filter(
          Option.map(yield* Config.option(Config.Redacted('DATABASE_ADMIN_URL')), (value) =>
            Redacted.value(value).trim(),
          ),
          (value) => value.length > 0,
        );
        if (Option.isNone(url)) {
          return Option.none<PgClient.PgClient>();
        }
        return Option.some(
          yield* PgClient.makeClient({ connectTimeout: EVIDENCE_TIMEOUT, url: Redacted.make(url.value) }).pipe(
            Effect.timeout(EVIDENCE_TIMEOUT),
          ),
        );
      }).pipe(Effect.orElseSucceed(() => Option.none<PgClient.PgClient>()));
      const evidence = yield* Ref.make(client);
      return {
        decide: (relativeDirectory: string, config: string) =>
          decideWith(fs, evidence, appDirectory, relativeDirectory, config),
      } satisfies OwnerMigrationPlannerService;
    }),
  );
