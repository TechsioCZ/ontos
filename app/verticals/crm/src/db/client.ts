import { drizzle } from 'drizzle-orm/node-postgres';
import { Context, Effect, Layer } from 'effect';
import type { Scope } from 'effect';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { CrmDatabaseConfig } from './config.ts';
import type { CrmDatabaseConfigValue } from './config.ts';
import { CrmDatabaseConnectionError } from './connection-error.ts';
import { crmDatabaseSchema } from './schema.ts';
import type { CrmDatabaseExecutor } from './types.ts';

export { CrmDatabaseConnectionError } from './connection-error.ts';

export class CrmDatabase extends Context.Service<
  CrmDatabase,
  {
    readonly executor: CrmDatabaseExecutor;
  }
>()('@app/crm/db/client/CrmDatabase') {}

export interface CrmPoolResource {
  readonly end: () => Promise<void>;
}

export const acquireCrmPoolResource = <Resource extends CrmPoolResource>(
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

export type CrmPoolFactory = (configuration: PoolConfig) => Pool;

const defaultPoolFactory: CrmPoolFactory = (configuration) => new Pool(configuration);

export const makeCrmDatabase = (
  configuration: CrmDatabaseConfigValue,
  poolFactory: CrmPoolFactory = defaultPoolFactory,
): Effect.Effect<
  Context.Service.Shape<typeof CrmDatabase>,
  CrmDatabaseConnectionError,
  Scope.Scope
> =>
  acquireCrmPoolResource(() =>
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
    const configuration = yield* CrmDatabaseConfig;
    return yield* makeCrmDatabase(configuration);
  }),
);
