import type { ResolvedPrincipalIdentity } from '@app/core-runtime';
import { GatewayTrustedPrincipalContextSchema } from '@app/shared-contracts';
import { PgClient } from '@effect/sql-pg';
import { Effect, Schema, Stream } from 'effect';
import { Statement } from 'effect/sql';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import type { SqlClient, SqlConnection } from 'effect/sql';

/** Controlled authentication rows only; no database, network or business Current authority. */
export const relayUnitPrincipal = Schema.decodeUnknownSync(GatewayTrustedPrincipalContextSchema)({
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-api-key:original-key',
  authenticationNamespaceId: 'ontos.staff.better-auth.v1',
  authMethod: 'api_key',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000001',
});
export const relayUnitIdentity: ResolvedPrincipalIdentity = {
  authBindingId: relayUnitPrincipal.authBindingId ?? '',
  displayName: 'Controlled original actor',
  principalId: relayUnitPrincipal.principalId,
  principalKind: 'human',
  tenantId: relayUnitPrincipal.tenantId,
};
export const relayUnitNow = 1_700_000_000;
export interface RelayUnitSession {
  actionId: string | null;
  activeLegalEntityId: string | null;
  activeTenantId: string;
  banExpires: Date | null;
  banned: boolean;
  expiresAt: Date;
  impersonatedBy: string | null;
  originalAuthBindingId: string | null;
  originalPrincipalId: string | null;
  originalSessionId: string | null;
  reason: string | null;
  targetPrincipalId: string | null;
  userId: string;
}
export const unitSession: RelayUnitSession = {
  actionId: null,
  activeLegalEntityId: relayUnitPrincipal.legalEntityId ?? null,
  activeTenantId: relayUnitPrincipal.tenantId,
  banExpires: null,
  banned: false,
  expiresAt: new Date((relayUnitNow + 300) * 1000),
  impersonatedBy: null,
  originalAuthBindingId: null,
  originalPrincipalId: null,
  originalSessionId: null,
  reason: null,
  targetPrincipalId: null,
  userId: 'original-user',
};
export type RelayUnitRows = readonly (readonly (readonly unknown[])[])[];

export const controlledAuthConnection = (batches: RelayUnitRows, unavailable = false) => {
  let cursor = 0;
  const queries: string[] = [];
  const executeValues: SqlConnection.Connection['executeValues'] = (query) => {
    queries.push(query);
    if (unavailable) {
      return Effect.fail(
        new SqlError({
          reason: new ConnectionError({
            cause: 'Controlled unit connection failure',
            message: 'Controlled Auth SQL unavailable',
          }),
        }),
      );
    }
    if (
      !query.startsWith('select ') ||
      (!query.includes('"auth"."apikey"') && !query.includes('"auth"."session"')) ||
      cursor >= batches.length
    ) {
      return Effect.die('Unexpected SQL outside controlled Auth SELECT fixtures');
    }
    const rows = batches[cursor] ?? [];
    cursor += 1;
    return Effect.succeed(rows);
  };
  const connection: SqlConnection.Connection = {
    execute: () => Effect.die('Object SQL execution is not part of this fixture'),
    executeRaw: () => Effect.die('Raw SQL execution is not part of this fixture'),
    executeStream: () => Stream.die('Streaming SQL is not part of this fixture'),
    executeUnprepared: () => Effect.die('Unprepared SQL is not part of this fixture'),
    executeValues,
    executeValuesUnprepared: () => Effect.die('Unprepared values are not part of this fixture'),
  };
  return { connection, queries };
};

/** Retain the real Effect SQL/Drizzle path; unused PostgreSQL operations fail closed. */
export const controlledPgClient = (client: SqlClient.SqlClient): PgClient.PgClient => {
  const extension: Pick<PgClient.PgClient, typeof PgClient.TypeId | 'config' | 'json' | 'listen' | 'notify'> = {
    config: {},
    json: () => Statement.fragment([Statement.literal('null')]),
    listen: () => Effect.die('LISTEN is not part of this fixture'),
    notify: () => Effect.die('NOTIFY is not part of this fixture'),
    [PgClient.TypeId]: PgClient.TypeId,
  };
  return Object.assign(client, extension);
};
