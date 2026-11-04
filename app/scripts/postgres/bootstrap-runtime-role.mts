/// <reference types="node" />

import { NodeServices } from '@effect/platform-node';
import { Command, Flag } from 'effect/cli';
import { Effect, Exit, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { loadSelectedDatabaseIdentityConnections } from '../../packages/core-runtime/src/db/config.ts';
import type { DatabaseConfigValue } from '../../packages/core-runtime/src/db/config.ts';
import { DATABASE_IDENTITIES } from '../../packages/core-runtime/src/db/database-identities.ts';
import type { DatabaseIdentity } from '../../packages/core-runtime/src/db/database-identities.ts';
import type { RuntimeRoleBootstrapError } from './database-login-roles.mts';
import { bootstrapFailure, bootstrapRuntimeRoles, connectAdmin } from './runtime-role-bootstrap.mts';

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

const runBootstrap = (identities: readonly string[]) =>
  Effect.gen(function* mainEffect() {
    const connections = yield* loadSelectedDatabaseIdentityConnections({ identityIds: identities }).pipe(
      Effect.mapError((failure) => bootstrapFailure(failure.reason)),
    );
    const passwords = new Map<string, Redacted.Redacted>();
    const selected = DATABASE_IDENTITIES.filter(({ id }) => identities.includes(id));
    for (const identity of selected) {
      const connection = connections.runtime.get(identity.id);
      if (connection === undefined) {
        return yield* bootstrapFailure(`Missing selected PostgreSQL identity ${identity.id}`);
      }
      passwords.set(identity.role, yield* readRuntimePassword(identity, connection));
    }
    const client = yield* connectAdmin(Redacted.make(connections.admin.connectionString));
    yield* bootstrapRuntimeRoles(client, {
      database: connections.admin.database,
      identities: selected.map(({ id }) => id),
      passwords,
    });
    return yield* Effect.sync(() =>
      console.log(`Verified least-privilege PostgreSQL roles ${selected.map(({ role }) => role).join(', ')}`),
    );
  }).pipe(
    Effect.scoped,
    Effect.tapError((failure) => Effect.logError(failure.reason)),
  );

const cli = Command.make(
  'bootstrap-runtime-role',
  {
    identities: Flag.String('identities').pipe(Flag.optional),
  },
  ({ identities }) =>
    runBootstrap(
      Option.match(identities, {
        onNone: () => DATABASE_IDENTITIES.map(({ id }) => id),
        onSome: (selection) => selection.split(','),
      }),
    ),
);
const exit = await Effect.runPromiseExit(
  Command.run({ version: '1.0.0' })(cli).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
