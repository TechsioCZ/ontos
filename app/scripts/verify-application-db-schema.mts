/// <reference types="node" />

import { fileURLToPath } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Array as EffectArray, Console, Effect, Layer, Option, Order, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { Command, Flag } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { loadAdministrativeDatabaseConnection } from '../packages/core-runtime/src/db/config.ts';
import { assertDatabaseRoleManifestComplete } from './postgres/runtime-role-bootstrap.mts';
import { loadApplicationMigrationInventory } from './application-migration-inventory.mts';
import type { ApplicationMigrationStream } from './application-migration-inventory.mts';
import { resolveApplicationMigrationRequirements } from './application-migration-plan.mts';
import type { ApplicationMigrationRequirements } from './application-migration-plan.mts';
import { readApplicationMigrationRequirements } from './application-migration-runtime.mts';

class ApplicationDatabaseVerificationError extends Schema.TaggedError<ApplicationDatabaseVerificationError>()(
  'ApplicationDatabaseVerificationError',
  { cause: Schema.optionalKey(Schema.Unknown), reason: Schema.String },
) {}

const verificationFailure = (reason: string, cause?: unknown): ApplicationDatabaseVerificationError =>
  new ApplicationDatabaseVerificationError(cause === undefined ? { reason } : { cause, reason });

interface ApplicationVerificationSelection {
  readonly mode: ApplicationMigrationRequirements['mode'];
  readonly streams: readonly ApplicationMigrationStream[];
}

/** Internal owner IDs are resolved against source metadata before any owner configuration is loaded. */
export const resolveApplicationVerificationSelection = Effect.fn('ApplicationDatabaseVerification.select')(
  function* resolveApplicationVerificationSelectionEffect(input: {
    readonly inventory: readonly ApplicationMigrationStream[];
    readonly ownersOption: Option.Option<string>;
    readonly requirements?: ApplicationMigrationRequirements;
    readonly requirementsOption?: Option.Option<string>;
  }): Effect.fn.Return<ApplicationVerificationSelection, ApplicationDatabaseVerificationError> {
    if (
      Option.isSome(input.ownersOption) &&
      input.requirementsOption !== undefined &&
      Option.isSome(input.requirementsOption)
    ) {
      return yield* verificationFailure('Owners and requirements options are mutually exclusive');
    }
    let requirements: ApplicationMigrationRequirements = input.requirements ?? { mode: 'all', owners: [] };
    if (Option.isSome(input.ownersOption)) {
      const owners = input.ownersOption.value;
      requirements =
        owners === ''
          ? { mode: 'none', owners: [] }
          : {
              mode: 'selected',
              owners: owners.split(',').map((ownerId) => ({ migrate: false, ownerId, verify: true })),
            };
    }
    const metadata = input.inventory.map(({ journalName, migrations, optional, ownerId, prerequisites, schemas }) => ({
      journalName,
      migrations,
      optional,
      ownerId,
      prerequisites,
      schemas,
    }));
    const selected = yield* resolveApplicationMigrationRequirements(requirements, metadata).pipe(
      Effect.mapError((cause) => verificationFailure('Invalid application database verifier selection', cause)),
    );
    const byOwner = new Map(input.inventory.map((stream) => [stream.ownerId, stream]));
    const streams: ApplicationMigrationStream[] = [];
    for (const requirement of selected) {
      if (requirement.verify) {
        const stream = byOwner.get(requirement.ownerId);
        if (stream === undefined) {
          return yield* verificationFailure('The selected verifier is absent from the source inventory');
        }
        streams.push(stream);
      }
    }
    return { mode: requirements.mode, streams };
  },
);

export interface ApplicationCatalogExpectation {
  readonly allowedJournals: readonly string[];
  readonly allowedSchemas: readonly string[];
  readonly requiredJournals: readonly string[];
  readonly requiredSchemas: readonly string[];
}

const orderedUnique = (values: readonly string[]) => EffectArray.sort([...new Set(values)], Order.String);

/** Excluded known catalogs can remain installed; only the selected closure must be present. */
export const applicationCatalogExpectation = (input: {
  readonly commerceUsesPrimaryDatabase: boolean;
  readonly inventory: readonly ApplicationMigrationStream[];
  readonly mode: ApplicationMigrationRequirements['mode'];
  readonly selectedStreams: readonly ApplicationMigrationStream[];
}): ApplicationCatalogExpectation => {
  const required = input.selectedStreams.filter(
    (stream) => stream.database === 'primary' || input.commerceUsesPrimaryDatabase,
  );
  const allowed = input.mode === 'all' ? required : input.inventory;
  return {
    allowedJournals: orderedUnique(allowed.map((stream) => stream.journalName)),
    allowedSchemas: orderedUnique(allowed.flatMap((stream) => stream.schemas)),
    requiredJournals: orderedUnique(required.map((stream) => stream.journalName)),
    requiredSchemas: orderedUnique(required.flatMap((stream) => stream.schemas)),
  };
};

export const applicationCatalogMismatch = (
  actual: { readonly journals: readonly string[]; readonly schemas: readonly string[] },
  expected: ApplicationCatalogExpectation,
): string | undefined => {
  const missingSchemas = expected.requiredSchemas.filter((name) => !actual.schemas.includes(name));
  const unknownSchemas = actual.schemas.filter((name) => !expected.allowedSchemas.includes(name));
  if (missingSchemas.length > 0 || unknownSchemas.length > 0) {
    return `Application schema mismatch; missing=[${missingSchemas.join(', ')}], unknown=[${unknownSchemas.join(', ')}]`;
  }
  const missingJournals = expected.requiredJournals.filter((name) => !actual.journals.includes(name));
  const unknownJournals = actual.journals.filter((name) => !expected.allowedJournals.includes(name));
  return missingJournals.length > 0 || unknownJournals.length > 0
    ? `Migration journal mismatch; missing=[${missingJournals.join(', ')}], unknown=[${unknownJournals.join(', ')}]`
    : undefined;
};

interface DatabaseTarget {
  readonly database: string;
  readonly host: string;
  readonly port: number;
}
const sameDatabaseTarget = (left: DatabaseTarget, right: DatabaseTarget): boolean =>
  left.database === right.database && left.host === right.host && left.port === right.port;

const query = <Row extends object>(client: PgClient.PgClient, text: string, reason: string) =>
  client.unsafe<Row>(text).pipe(Effect.mapError((cause) => verificationFailure(reason, cause)));

const verifyApplicationCatalog = (client: PgClient.PgClient, expected: ApplicationCatalogExpectation) =>
  Effect.gen(function* verifyApplicationCatalogEffect() {
    // Native catalogs are the evidence; selection never predicts that an excluded owner is absent.
    const schemas = yield* query<{ schema_name: string }>(
      client,
      `
      select namespace.nspname as schema_name from pg_catalog.pg_namespace as namespace
      where namespace.nspname <> 'information_schema' and namespace.nspname not like 'pg\\_%'
        and namespace.nspname not in ('drizzle', 'public') order by namespace.nspname
    `,
      'Unable to verify the application schema catalog',
    );
    const journals = yield* query<{ table_name: string }>(
      client,
      `
      select relation.relname as table_name from pg_catalog.pg_class as relation
      inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'drizzle' and relation.relkind = 'r' order by relation.relname
    `,
      'Unable to verify the application migration journals',
    );
    const mismatch = applicationCatalogMismatch(
      {
        journals: journals.map((row) => row.table_name),
        schemas: schemas.map((row) => row.schema_name),
      },
      expected,
    );
    if (mismatch !== undefined) {
      return yield* verificationFailure(mismatch);
    }
    return yield* Effect.void;
  });

/** Owner CLIs may start asynchronous runtimes and report failure only through their exit code. */
export const verifyOwnerSchema = Effect.fn('ApplicationDatabase.verifyOwnerSchema')(function* verifyOwnerSchema(
  ownerVerifierPath: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const code = yield* spawner
    .exitCode(
      ChildProcess.make(
        process.execPath,
        [fileURLToPath(new URL(ownerVerifierPath, new URL('../', import.meta.url)))],
        {
          stderr: 'inherit',
          stdout: 'inherit',
        },
      ),
    )
    .pipe(
      Effect.mapError((cause) => verificationFailure(`Owner database verifier ${ownerVerifierPath} failed`, cause)),
    );
  if (code !== 0) {
    return yield* verificationFailure(`Owner database verifier ${ownerVerifierPath} exited with code ${code}`);
  }
  return yield* Effect.void;
});

export const validateVerifierConcurrency = (
  value: number,
): Effect.Effect<number, ApplicationDatabaseVerificationError> =>
  Number.isInteger(value) && value >= 1 && value <= 4
    ? Effect.succeed(value)
    : Effect.fail(verificationFailure('Expected --concurrency with an integer between 1 and 4'));

/** Preserve canonical source order while joining every isolated child, including on cancellation. */
export const verifyOwnerSchemas = (paths: readonly string[], concurrency = 4) =>
  Effect.forEach(paths, verifyOwnerSchema, { concurrency, discard: true });

const verifyRoleManifest = (client: PgClient.PgClient) =>
  assertDatabaseRoleManifestComplete(client).pipe(Effect.mapError((failure) => verificationFailure(failure.reason)));

const verifyApplicationDatabase = (
  ownersOption: Option.Option<string>,
  requirementsOption: Option.Option<string>,
  concurrency: number,
) =>
  Effect.gen(function* verifyApplicationDatabaseEffect() {
    const inventory = yield* loadApplicationMigrationInventory().pipe(
      Effect.mapError((cause) => verificationFailure('Unable to load application migration inventory', cause)),
    );
    const requirements = Option.isNone(ownersOption)
      ? yield* readApplicationMigrationRequirements(Option.getOrUndefined(requirementsOption)).pipe(
          Effect.mapError((cause) =>
            verificationFailure('Unable to read application verification requirements', cause),
          ),
        )
      : { mode: 'all' as const, owners: [] };
    const selection = yield* resolveApplicationVerificationSelection({
      inventory,
      ownersOption,
      requirements,
      requirementsOption,
    });
    if (selection.streams.length === 0) {
      return yield* Console.log('No application database verification required');
    }
    if (selection.streams.some((stream) => stream.database === 'primary')) {
      const configuration = yield* loadAdministrativeDatabaseConnection().pipe(
        Effect.mapError((cause) => verificationFailure('Unable to load the primary database configuration', cause)),
      );
      let commerceUsesPrimaryDatabase = false;
      if (selection.mode === 'all') {
        // The optional owner gateway is deliberately absent from selected primary-owner execution.
        const gateway = yield* Effect.tryPromise({
          catch: (cause) => verificationFailure('Unable to load optional portal database gateway', cause),
          try: async () =>
            await import('../verticals/commerce-customer-context/scripts/portal-auth-database-config.mts'),
        });
        const commerce = yield* gateway
          .loadOptionalCommercePortalAuthDatabaseConfig()
          .pipe(
            Effect.mapError((cause) =>
              verificationFailure('Unable to load optional portal database configuration', cause),
            ),
          );
        commerceUsesPrimaryDatabase =
          Option.isSome(commerce) && sameDatabaseTarget(configuration, commerce.value.admin);
      }
      const expected = applicationCatalogExpectation({
        commerceUsesPrimaryDatabase,
        inventory,
        mode: selection.mode,
        selectedStreams: selection.streams,
      });
      yield* PgClient.makeClient({ url: Redacted.make(configuration.connectionString) }).pipe(
        Effect.mapError((cause) =>
          verificationFailure('Unable to connect to the administrative PostgreSQL database', cause),
        ),
        Effect.flatMap((client) =>
          Effect.gen(function* verifySelectedCatalog() {
            yield* verifyApplicationCatalog(client, expected);
            if (selection.mode === 'all') {
              yield* verifyRoleManifest(client);
            }
          }),
        ),
        Effect.scoped,
      );
      yield* Console.log('Verified application schemas and migration journals for the selected owner closure');
    }
    const paths: string[] = [];
    for (const stream of selection.streams) {
      for (const path of stream.verifierPaths) {
        paths.push(path);
      }
    }
    yield* verifyOwnerSchemas(paths, concurrency);
    return yield* Effect.void;
  }).pipe(Effect.tapError((failure) => Console.error(failure.reason)));

export const verifyApplicationDatabaseCommand = Command.make(
  'verify-application-db-schema',
  {
    concurrency: Flag.Int('concurrency').pipe(Flag.withDefault(4)),
    owners: Flag.String('owners').pipe(Flag.optional),
    requirements: Flag.String('requirements').pipe(Flag.optional),
  },
  ({ concurrency, owners, requirements }) =>
    validateVerifierConcurrency(concurrency).pipe(
      Effect.flatMap((bounded) => verifyApplicationDatabase(owners, requirements, bounded)),
    ),
);
export const main = Command.run(verifyApplicationDatabaseCommand, { version: '1.0.0' });

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(Layer.merge(Reactivity.layer, NodeServices.layer)))).pipe(
      Effect.scoped,
    ),
  );
}
