/// <reference types="node" />

import type { PgClient } from '@effect/sql-pg';
import { Effect, Redacted, Schema } from 'effect';

export class RuntimeRoleBootstrapError extends Schema.TaggedError<RuntimeRoleBootstrapError>()(
  'RuntimeRoleBootstrapError',
  {
    reason: Schema.String,
  },
) {}

export const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
export const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

// Driver errors may include connection credentials or password-bearing SQL.
export const runtimeRoleQueryFailure = (): RuntimeRoleBootstrapError =>
  new RuntimeRoleBootstrapError({ reason: 'PostgreSQL runtime-role bootstrap query failed' });

const LOGIN_ROLE_ATTRIBUTES = 'nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication';

export type DatabaseLoginCredentials =
  | { readonly kind: 'existing' }
  | { readonly kind: 'password'; readonly password: Redacted.Redacted };

/** Existing credentials permit attribute/grant reconciliation, never CREATE or password assignment. */
export const ensureDatabaseLoginRole = (
  client: PgClient.PgClient,
  input: { readonly credentials: DatabaseLoginCredentials; readonly database: string; readonly role: string },
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.gen(function* ensureDatabaseLoginRoleEffect() {
    const role = quoteIdentifier(input.role);
    const exists = yield* client
      .unsafe<{ exists: boolean }>('select exists(select 1 from pg_catalog.pg_roles where rolname = $1) as exists', [
        input.role,
      ])
      .pipe(Effect.mapError(runtimeRoleQueryFailure));
    if (input.credentials.kind === 'existing') {
      if (!exists[0]?.exists) {
        return yield* new RuntimeRoleBootstrapError({ reason: `Protected PostgreSQL role ${input.role} is missing` });
      }
      yield* client
        .unsafe(`alter role ${role} login ${LOGIN_ROLE_ATTRIBUTES}`)
        .pipe(Effect.mapError(runtimeRoleQueryFailure));
    } else {
      const passwordLiteral = quoteLiteral(Redacted.value(input.credentials.password));
      const verb = exists[0]?.exists ? 'alter' : 'create';
      yield* client
        .unsafe(`${verb} role ${role} login password ${passwordLiteral} ${LOGIN_ROLE_ATTRIBUTES}`)
        .pipe(Effect.mapError(runtimeRoleQueryFailure));
    }
    yield* client
      .unsafe(`grant connect on database ${quoteIdentifier(input.database)} to ${role}`)
      .pipe(Effect.mapError(runtimeRoleQueryFailure));
    return yield* Effect.void;
  });
