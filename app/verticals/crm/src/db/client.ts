import { DatabaseConfig } from '@app/core-runtime';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Context, Effect, Layer } from 'effect';
import type { Scope } from 'effect';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { CrmDatabaseConnectionError } from './connection-error.ts';
import { crmDatabaseSchema } from './schema.ts';
import type { CrmDatabaseExecutor } from './types.ts';

export class CrmDatabase extends Context.Service<
  CrmDatabase,
  {
    readonly executor: CrmDatabaseExecutor;
  }
>()('@app/crm/db/client/CrmDatabase') {}

export interface PoolResource {
  readonly end: () => Promise<void>;
}

export const acquirePoolResource = <Resource extends PoolResource>(
  acquire: () => Resource,
): Effect.Effect<Resource, CrmDatabaseConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      catch: () =>
        new CrmDatabaseConnectionError({
          reason: 'Unable to initialize the CRM PostgreSQL connection pool',
        }),
      try: acquire,
    }),
    (pool) => Effect.promise(() => pool.end()),
  );

export type PoolFactory = (configuration: PoolConfig) => Pool;

const defaultPoolFactory: PoolFactory = (configuration) => new Pool(configuration);

type ContextServiceContract<Service> =
  Service extends Context.Key<infer _Identifier, infer Contract> ? Contract : never;

export const makeCrmDatabase = (
  configuration: ContextServiceContract<typeof DatabaseConfig>,
  poolFactory: PoolFactory = defaultPoolFactory,
): Effect.Effect<
  ContextServiceContract<typeof CrmDatabase>,
  CrmDatabaseConnectionError,
  Scope.Scope
> =>
  acquirePoolResource(() =>
    poolFactory({
      connectionString: configuration.connectionString,
    }),
  ).pipe(
    Effect.map((pool) => ({
      executor: drizzle({
        client: pool,
        schema: crmDatabaseSchema,
      }),
    })),
  );

export const CrmDatabaseLive = Layer.effect(
  CrmDatabase,
  Effect.gen(function* makeCrmDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makeCrmDatabase(configuration);
  }),
);
