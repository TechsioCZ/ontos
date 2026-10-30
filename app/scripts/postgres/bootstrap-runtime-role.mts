/// <reference types="node" />
import { DATABASE_IDENTITIES, APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';

import { Config, Effect, Exit, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { loadDatabaseIdentityConnections } from '../../packages/core-runtime/src/db/config.ts';
import type { DatabaseConfigValue } from '../../packages/core-runtime/src/db/config.ts';

import type { DatabaseIdentity } from '../../packages/core-runtime/src/db/database-identities.ts';
import type { RuntimeRoleBootstrapError } from './database-login-roles.mts';
import {
  RuntimeRoleBootstrapModeSchema,
  bootstrapFailure,
  bootstrapRuntimeRoles,
  connectAdmin,
} from './runtime-role-bootstrap.mts';

const RUNTIME_ROLES = DATABASE_IDENTITIES.map(({ role }) => role);

const readRuntimePassword = (
  identity: DatabaseIdentity,
  connection: DatabaseConfigValue,
): Effect.Effect<Redacted.Redacted, RuntimeRoleBootstrapError> =>
  Schema.decodeEffect(Schema.URLFromString)(connection.connectionString).pipe(
    Effect.flatMap((url) =>
      Effect.try({
        catch: (cause) => cause,
        try: () => url.searchParams.getAll('password').at(-1) ?? decodeURIComponent(url.password),
      }),
    ),
    Effect.mapError(() => bootstrapFailure(`Unable to read the ${identity.urlKey} PostgreSQL role credentials`)),
    Effect.flatMap((password) =>
      password.length === 0
        ? Effect.fail(bootstrapFailure(`${identity.urlKey} must include the ${identity.role} login password`))
        : Effect.succeed(Redacted.make(password)),
    ),
  );

const main = Effect.gen(function* mainEffect() {
  const mode = yield* Config.schema(RuntimeRoleBootstrapModeSchema, 'DATABASE_LOGIN_ROLE_POLICY').pipe(
    Config.withDefault('reconcile'),
    Effect.mapError(() => bootstrapFailure('DATABASE_LOGIN_ROLE_POLICY must be reconcile or initialize-local')),
  );
  const environment = yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(
    Config.withDefault('development'),
    Effect.mapError(() => bootstrapFailure('Unable to read the deployment environment')),
  );
  if (mode === 'initialize-local' && environment !== 'development') {
    return yield* bootstrapFailure('PostgreSQL role initialization is only allowed in development');
  }
  const connections = yield* loadDatabaseIdentityConnections({ enrollment: APP_DATABASE_IDENTITY_ENROLLMENT }).pipe(
    Effect.mapError((failure) => bootstrapFailure(failure.reason)),
  );
  const passwords = new Map<string, Redacted.Redacted>();
  for (const identity of DATABASE_IDENTITIES) {
    const connection = connections.runtime[identity.id];
    if (connection === undefined) {
      return yield* bootstrapFailure(`The enrolled ${identity.id} database connection is unavailable`);
    }
    passwords.set(identity.role, yield* readRuntimePassword(identity, connection));
  }
  const client = yield* connectAdmin(Redacted.make(connections.admin.connectionString));
  yield* bootstrapRuntimeRoles(client, connections, passwords, mode);
  yield* Effect.sync(() => console.log(`Verified least-privilege PostgreSQL roles ${RUNTIME_ROLES.join(', ')}`));
  return yield* Effect.void;
}).pipe(
  Effect.scoped,
  Effect.provide(Reactivity.layer),
  Effect.tapError((failure) => Effect.logError(failure.reason)),
);

const exit = await Effect.runPromiseExit(main);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
