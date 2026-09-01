import { DatabaseConfig } from '@app/core-runtime';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Context, Effect, Layer } from 'effect';
import type { Scope } from 'effect';
import { Pool } from 'pg';
import { ProjectsDatabaseConnectionError } from './connection-error.ts';
import { projectsDatabaseSchema } from './schema.ts';
import type { ProjectsDatabaseExecutor } from './types.ts';

export class ProjectsDatabase extends Context.Service<
  ProjectsDatabase,
  { readonly executor: ProjectsDatabaseExecutor }
>()('@app/projects/db/client/ProjectsDatabase') {}

export const makeProjectsDatabase = (configuration: {
  readonly connectionString: string;
}): Effect.Effect<
  { readonly executor: ProjectsDatabaseExecutor },
  ProjectsDatabaseConnectionError,
  Scope.Scope
> =>
  Effect.acquireRelease(
    Effect.try({
      catch: () =>
        new ProjectsDatabaseConnectionError({
          reason: 'Unable to initialize the Projects PostgreSQL pool',
        }),
      try: () => new Pool({ connectionString: configuration.connectionString }),
    }),
    (pool) => Effect.promise(() => pool.end()),
  ).pipe(
    Effect.map((pool) => ({ executor: drizzle({ client: pool, schema: projectsDatabaseSchema }) })),
  );

export const ProjectsDatabaseLive = Layer.effect(
  ProjectsDatabase,
  Effect.gen(function* projectsDatabaseLive() {
    const configuration = yield* DatabaseConfig;
    return yield* makeProjectsDatabase(configuration);
  }),
);
