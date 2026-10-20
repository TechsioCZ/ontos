import { randomBytes } from 'node:crypto';

import { PgClient } from '@effect/sql-pg';
import { Config, Console, Context, Effect, Layer, Option, Redacted } from 'effect';
import type { Reactivity } from 'effect/reactivity';

import { ensureDatabaseLoginRole } from '../postgres/database-login-roles.mts';
import { ZeropsPublicApi } from '../zerops-public-api.mts';
import {
  DATABASE_IDENTITY_SECRETS,
  MIGRATOR_SERVICE_HOSTNAME,
  migratorSecretReference,
} from './database-identity-secrets.mts';
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
