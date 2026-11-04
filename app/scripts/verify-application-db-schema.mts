/// <reference types="node" />

import { fileURLToPath } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Array as EffectArray, Console, Effect, Layer, Option, Order, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { Command, Flag } from 'effect/cli';

import { loadAdministrativeDatabaseConnection } from '../packages/core-runtime/src/db/config.ts';
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

/** Source-owned script gateways run once in isolation and report their real process exit status. */
const verifyOwnerSchema = (path: string) =>
  Effect.callback<boolean, ApplicationDatabaseVerificationError>((resume) => {
    const { spawn } = process.getBuiltinModule('node:child_process');
    const child = spawn(process.execPath, [fileURLToPath(new URL(`../${path}`, import.meta.url))], {
      stdio: 'inherit',
    });
    const onError = (cause: Error) =>
      resume(Effect.fail(verificationFailure(`Owner database verifier ${path} failed`, cause)));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const outcome = signal ?? `code ${String(code)}`;
      resume(
        code === 0
          ? Effect.succeed(true)
          : Effect.fail(verificationFailure(`Owner database verifier ${path} exited with ${outcome}`)),
      );
    };
    child.once('error', onError);
    child.once('exit', onExit);
    return Effect.sync(() => {
      child.off('error', onError);
      child.off('exit', onExit);
    });
  }).pipe(Effect.asVoid);

const verifyApplicationDatabase = (ownersOption: Option.Option<string>, requirementsOption: Option.Option<string>) =>
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
        Effect.flatMap((client) => verifyApplicationCatalog(client, expected)),
        Effect.scoped,
      );
      yield* Console.log('Verified application schemas and migration journals for the selected owner closure');
    }
    for (const stream of selection.streams) {
      for (const path of stream.verifierPaths) {
        yield* verifyOwnerSchema(path);
      }
    }
    return yield* Effect.void;
  }).pipe(Effect.tapError((failure) => Console.error(failure.reason)));

export const verifyApplicationDatabaseCommand = Command.make(
  'verify-application-db-schema',
  {
    owners: Flag.String('owners').pipe(Flag.optional),
    requirements: Flag.String('requirements').pipe(Flag.optional),
  },
  ({ owners, requirements }) => verifyApplicationDatabase(owners, requirements),
);
export const main = Command.run(verifyApplicationDatabaseCommand, { version: '1.0.0' });

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(Layer.merge(NodeServices.layer, Reactivity.layer)))).pipe(
      Effect.scoped,
    ),
  );
}
