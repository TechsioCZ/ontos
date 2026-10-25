import { randomBytes } from 'node:crypto';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, Console, Context, Effect, FileSystem, Layer, Option, Redacted } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient } from 'effect/unstable/http';
import type { Reactivity } from 'effect/unstable/reactivity';

import { ensureDatabaseLoginRole } from '../postgres/database-login-roles.mts';
import { ZeropsPublicApi, ZeropsPublicApiLive } from '../zerops-public-api.mts';
import {
  DATABASE_IDENTITY_SECRETS,
  MIGRATOR_SERVICE_HOSTNAME,
  migratorSecretReference,
} from './database-identity-secrets.mts';
import { OpsShellLive } from './ops-shell.mts';
import { StageOperationError } from './stage-operation-error.mts';
import { listZeropsServices, perform, readZeropsValue } from './stage-operations.mts';

/** 48 random bytes, 64 base64url characters; PostgreSQL and URLs take them without escaping. */
const PASSWORD_BYTES = 48;

export const generateDatabasePassword = (): string => randomBytes(PASSWORD_BYTES).toString('base64url');

/** Creates or alters one login role with LOGIN and CONNECT only, through the administrative connection. */
export interface DatabaseLoginRoleAdministration {
  readonly ensure: (input: {
    readonly password: Redacted.Redacted;
    readonly role: string;
  }) => Effect.Effect<void, StageOperationError, Reactivity.Reactivity>;
}

export class DatabaseLoginRoles extends Context.Service<DatabaseLoginRoles, DatabaseLoginRoleAdministration>()(
  '@app/scripts/ops/database-identities/DatabaseLoginRoles',
) {}

const adminDatabase = (url: Redacted.Redacted) =>
  Effect.try({
    catch: () => new StageOperationError({ message: 'DATABASE_ADMIN_URL is not a URL' }),
    try: () => decodeURIComponent(new URL(Redacted.value(url)).pathname.replace(/^\//u, '')),
  }).pipe(
    Effect.filterOrFail(
      (database) => database !== '',
      () => new StageOperationError({ message: 'DATABASE_ADMIN_URL names no database' }),
    ),
  );

/**
 * The live roles connection. It reads DATABASE_ADMIN_URL only when a role is ensured, so every other
 * step runs without it. The operator runs the step from a host on the Zerops VPN.
 */
export const DatabaseLoginRolesLive = Layer.succeed(
  DatabaseLoginRoles,
  DatabaseLoginRoles.of({
    ensure: ({ password, role }) =>
      Effect.gen(function* ensureLoginRole() {
        const url = yield* Config.Redacted('DATABASE_ADMIN_URL').pipe(
          Effect.mapError(
            (cause) =>
              new StageOperationError({
                cause,
                message:
                  'database-identities needs DATABASE_ADMIN_URL, the db18 superuser URL, from a host on the Zerops VPN',
              }),
          ),
        );
        const database = yield* adminDatabase(url);
        const client = yield* PgClient.makeClient({ url }).pipe(
          Effect.mapError(
            (cause) =>
              new StageOperationError({
                cause,
                message: 'the administrative database is unreachable',
              }),
          ),
        );
        yield* ensureDatabaseLoginRole(client, { database, password, role }).pipe(
          Effect.mapError(
            // The cause is dropped: a driver error may echo the statement that carries the password.
            () => new StageOperationError({ message: `the login role ${role} could not be ensured` }),
          ),
        );
      }).pipe(Effect.scoped),
  }),
);

const migratorServiceId = (projectId: string) =>
  listZeropsServices(projectId).pipe(
    Effect.flatMap((services) => {
      const service = services.find(({ hostname }) => hostname === MIGRATOR_SERVICE_HOSTNAME);
      return service === undefined
        ? Effect.fail(
            new StageOperationError({
              message: `Zerops project ${projectId} has no ${MIGRATOR_SERVICE_HOSTNAME} service`,
            }),
          )
        : Effect.succeed(service.id);
    }),
  );

const isStored = (secrets: ReadonlyMap<string, Redacted.Redacted>, key: string) => {
  const value = secrets.get(key);
  return value !== undefined && Redacted.value(value) !== '';
};

const missingSecrets = (projectId: string) =>
  Effect.gen(function* missingSecretsEffect() {
    const serviceId = yield* migratorServiceId(projectId);
    const api = yield* ZeropsPublicApi;
    const stored = yield* api.serviceSecrets(serviceId);
    return {
      missing: DATABASE_IDENTITY_SECRETS.filter(({ secretKey }) => !isStored(stored, secretKey)),
      serviceId,
    };
  });

/**
 * Creates each missing password secret on `migrator`, then creates or alters the three login roles with
 * those passwords. Hyperdrive tests its origin when a config is created, so this runs before it. The roles
 * stay inert until the migrator bootstrap grants them their manifest. No value is ever printed.
 */
export const ensureDatabaseIdentities = (projectId: string) =>
  Effect.gen(function* ensureDatabaseIdentitiesEffect() {
    const { missing, serviceId } = yield* missingSecrets(projectId);
    const api = yield* ZeropsPublicApi;
    for (const { identity, secretKey } of missing) {
      yield* perform(
        `create the sensitive ${MIGRATOR_SERVICE_HOSTNAME} secret ${secretKey} (${String(PASSWORD_BYTES)} random bytes, base64url) for ${identity.role}`,
        api.createServiceSecret(serviceId, secretKey, generateDatabasePassword()),
      );
    }
    if (missing.length === 0) {
      yield* Console.log(
        `the ${MIGRATOR_SERVICE_HOSTNAME} service holds ${DATABASE_IDENTITY_SECRETS.map(({ secretKey }) => secretKey).join(', ')}`,
      );
    }
    const roles = yield* DatabaseLoginRoles;
    for (const { identity, secretKey } of DATABASE_IDENTITY_SECRETS) {
      yield* perform(
        `create or alter the login role ${identity.role} (LOGIN and CONNECT only) with the password ${migratorSecretReference(secretKey)}`,
        Effect.gen(function* ensureRole() {
          const password = yield* readZeropsValue(projectId, migratorSecretReference(secretKey));
          yield* roles.ensure({ password: Redacted.make(Redacted.value(password)), role: identity.role });
        }),
      );
    }
  });

/** The verification item: every identity password exists on `migrator`. */
export const databaseIdentitySecretsState = (projectId: string) =>
  missingSecrets(projectId).pipe(
    Effect.map(({ missing }) =>
      missing.length === 0
        ? Option.none<string>()
        : Option.some(`missing ${missing.map(({ secretKey }) => secretKey).join(', ')}; run database-identities`),
    ),
  );

/** Reads existing migrator secrets without creating or rotating a password or login. */
export const readDatabaseIdentityEnvironment = (projectId: string, runtimeUrl: Redacted.Redacted) =>
  Effect.gen(function* readIdentityEnvironment() {
    const base = yield* Effect.try({
      catch: () => new StageOperationError({ message: 'DATABASE_URL must be a PostgreSQL URL naming a database' }),
      try: () => new URL(Redacted.value(runtimeUrl)),
    }).pipe(
      Effect.filterOrFail(
        (url) => ['postgresql:', 'postgres:'].includes(url.protocol) && url.hostname !== '' && url.pathname.length > 1,
        () => new StageOperationError({ message: 'DATABASE_URL must be a PostgreSQL URL naming a database' }),
      ),
    );
    return yield* Effect.all(
      DATABASE_IDENTITY_SECRETS.map(({ identity, secretKey }) =>
        readZeropsValue(projectId, migratorSecretReference(secretKey)).pipe(
          Effect.map((password) => {
            const url = new URL(base);
            // Driver query parameters must not override the dedicated login or its password.
            for (const key of ['user', 'username', 'password']) {
              url.searchParams.delete(key);
            }
            url.username = identity.role;
            url.password = encodeURIComponent(Redacted.value(password));
            return { key: identity.urlKey, password, value: Redacted.make(url.href) };
          }),
        ),
      ),
    );
  });

/** Exports dedicated URLs only to the runner's private environment file after masking every value. */
export const exportDatabaseIdentityEnvironment = (projectId: string, environmentFile: string) =>
  Effect.gen(function* exportIdentityEnvironment() {
    const values = yield* readDatabaseIdentityEnvironment(projectId, yield* Config.Redacted('DATABASE_URL'));
    const fs = yield* FileSystem.FileSystem;
    for (const { password, value } of values) {
      for (const secret of [Redacted.value(password), Redacted.value(value)]) {
        const escaped = secret.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
        yield* Console.log(`::add-mask::${escaped}`);
      }
    }
    yield* fs.writeFileString(
      environmentFile,
      values.map(({ key, value }) => `${key}=${Redacted.value(value)}\n`).join(''),
      { flag: 'a' },
    );
    yield* Console.log('Loaded the dedicated database identities from existing migrator secrets');
  });

if (import.meta.main) {
  const cli = Command.make(
    'database-identity-environment',
    { environmentFile: Flag.String('github-environment-file') },
    ({ environmentFile }) =>
      Config.String('ZEROPS_PROJECT_ID').pipe(
        Effect.flatMap((projectId) => exportDatabaseIdentityEnvironment(projectId, environmentFile)),
      ),
  );
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run({ version: '1.0.0' })(cli)).pipe(
        Layer.provide(Layer.merge(OpsShellLive, ZeropsPublicApiLive)),
        Layer.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
      ),
    ).pipe(Effect.scoped),
  );
}
