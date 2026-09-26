import { findPostgresFailure } from '@app/core-runtime';
import type { PgClient } from '@effect/sql-pg';
import { Effect, Option } from 'effect';

/** Asserts that PostgreSQL itself raised the expected SQLSTATE, not that a driver shape matched. */
export const hasPostgreSqlCode =
  (expected: string) =>
  (error: Parameters<typeof findPostgresFailure>[0]): boolean =>
    Option.exists(findPostgresFailure(error), ({ code }) => code === expected);

/** Binds both roles to one schema; the test scope closes databases before their owned clients. */
export const openBoundaryDatabases = <Database, E, R>(
  openDatabase: (client: PgClient.PgClient) => Effect.Effect<Database, E, R>,
  clients: { readonly admin: PgClient.PgClient; readonly runtime: PgClient.PgClient },
) => Effect.all({ admin: openDatabase(clients.admin), runtime: openDatabase(clients.runtime) });
