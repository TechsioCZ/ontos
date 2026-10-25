/// <reference types="node" />

import type { PgClient } from '@effect/sql-pg';
import { Effect, Redacted, Schema } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';

export class RuntimeRoleBootstrapError extends Schema.TaggedError<RuntimeRoleBootstrapError>()(
  'RuntimeRoleBootstrapError',
  {
    reason: Schema.String,
  },
) {}

export const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
export const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

export const runtimeRoleQueryFailure = (cause: SqlError): RuntimeRoleBootstrapError =>
  new RuntimeRoleBootstrapError({
    reason: `PostgreSQL runtime-role bootstrap query failed: ${cause.message}`,
  });

const LOGIN_ROLE_ATTRIBUTES = 'nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication';

/** Creates or realigns one runtime login role with least-privilege attributes and database CONNECT. */
export const ensureDatabaseLoginRole = (
  client: PgClient.PgClient,
  input: { readonly database: string; readonly password: Redacted.Redacted; readonly role: string },
): Effect.Effect<void, RuntimeRoleBootstrapError> =>
  Effect.gen(function* ensureDatabaseLoginRoleEffect() {
    const role = quoteIdentifier(input.role);
    const exists = yield* client.unsafe<{ exists: boolean }>(
      'select exists(select 1 from pg_catalog.pg_roles where rolname = $1) as exists',
      [input.role],
    );
    const passwordLiteral = quoteLiteral(Redacted.value(input.password));
    const verb = exists[0]?.exists ? 'alter' : 'create';
    yield* client.unsafe(`${verb} role ${role} login password ${passwordLiteral} ${LOGIN_ROLE_ATTRIBUTES}`);
    yield* client.unsafe(`grant connect on database ${quoteIdentifier(input.database)} to ${role}`);
  }).pipe(Effect.mapError(runtimeRoleQueryFailure));
