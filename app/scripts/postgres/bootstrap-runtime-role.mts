/// <reference types="node" />

import { Effect, Exit, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { loadDatabaseIdentityConnections } from '../../packages/core-runtime/src/db/config.ts';
import type { DatabaseConfigValue } from '../../packages/core-runtime/src/db/config.ts';
import { DATABASE_IDENTITIES } from '../../packages/core-runtime/src/db/database-identities.ts';
import type { DatabaseIdentity } from '../../packages/core-runtime/src/db/database-identities.ts';
import type { RuntimeRoleBootstrapError } from './database-login-roles.mts';
import { bootstrapFailure, bootstrapRuntimeRoles, connectAdmin } from './runtime-role-bootstrap.mts';

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
    Effect.mapError((cause) =>
      bootstrapFailure(`Unable to read the ${identity.urlKey} PostgreSQL role credentials: ${String(cause)}`),
    ),
    Effect.flatMap((password) =>
      password.length === 0
        ? Effect.fail(bootstrapFailure(`${identity.urlKey} must include the ${identity.role} login password`))
        : Effect.succeed(Redacted.make(password)),
    ),
  );

const main = Effect.gen(function* mainEffect() {
  const connections = yield* loadDatabaseIdentityConnections().pipe(
    Effect.mapError((failure) => bootstrapFailure(failure.reason)),
  );
  const passwords = new Map<string, Redacted.Redacted>();
  for (const identity of DATABASE_IDENTITIES) {
    passwords.set(identity.role, yield* readRuntimePassword(identity, connections.runtime[identity.id]));
  }
  const client = yield* connectAdmin(Redacted.make(connections.admin.connectionString));
  yield* bootstrapRuntimeRoles(client, connections.admin.database, passwords);
  yield* Effect.sync(() => console.log(`Verified least-privilege PostgreSQL roles ${RUNTIME_ROLES.join(', ')}`));
}).pipe(
  Effect.scoped,
  Effect.provide(Reactivity.layer),
  Effect.tapError((failure) => Effect.logError(failure.reason)),
);

const exit = await Effect.runPromiseExit(main);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
