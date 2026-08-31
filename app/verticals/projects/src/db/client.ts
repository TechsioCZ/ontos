import { DatabaseConfig } from '@app/core-runtime';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Context, Effect, Layer } from 'effect';
import type { Scope } from 'effect';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { ProjectsDatabaseConnectionError } from './connection-error.ts';
import { projectsDatabaseSchema } from './schema.ts';
import type { ProjectsDatabaseExecutor } from './types.ts';

export class ProjectsDatabase extends Context.Service<
  ProjectsDatabase,
  {
    readonly executor: ProjectsDatabaseExecutor;
  }
>()('@app/projects/db/client/ProjectsDatabase') {}

export interface PoolResource {
  readonly end: () => Promise<void>;
}

export const acquirePoolResource = <Resource extends PoolResource>(
  acquire: () => Resource,
): Effect.Effect<Resource, ProjectsDatabaseConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      catch: () =>
        new ProjectsDatabaseConnectionError({
          reason: 'Unable to initialize the Projects PostgreSQL connection pool',
        }),
      try: acquire,
    }),
    (pool) => Effect.promise(() => pool.end()),
  );

export type PoolFactory = (configuration: PoolConfig) => Pool;

const defaultPoolFactory: PoolFactory = (configuration) => new Pool(configuration);

type ContextServiceContract<Service> =
  Service extends Context.Key<infer _Identifier, infer Contract> ? Contract : never;

export const makeProjectsDatabase = (
  configuration: ContextServiceContract<typeof DatabaseConfig>,
  poolFactory: PoolFactory = defaultPoolFactory,
): Effect.Effect<
  ContextServiceContract<typeof ProjectsDatabase>,
  ProjectsDatabaseConnectionError,
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
        schema: projectsDatabaseSchema,
      }),
    })),
  );

export const ProjectsDatabaseLive = Layer.effect(
  ProjectsDatabase,
  Effect.gen(function* makeProjectsDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makeProjectsDatabase(configuration);
  }),
);
