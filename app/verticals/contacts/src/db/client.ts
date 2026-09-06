import { DatabaseConfig, makeDatabasePoolConfiguration } from '@app/core-runtime';
import type { DatabasePoolDeadlines } from '@app/core-runtime';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Context, Effect, Layer, Redacted } from 'effect';
import type { Scope } from 'effect';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { ContactsDatabaseConnectionError } from './connection-error.ts';
import { contactsRelations } from './schema.ts';
import type { ContactsDatabaseExecutor } from './types.ts';

export class ContactsDatabase extends Context.Service<
  ContactsDatabase,
  {
    readonly executor: ContactsDatabaseExecutor;
  }
>()('@app/contacts/db/client/ContactsDatabase') {}

export interface PoolResource {
  readonly end: () => Promise<void>;
}

export const acquirePoolResource = <Resource extends PoolResource>(
  acquire: () => Resource,
): Effect.Effect<Resource, ContactsDatabaseConnectionError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      catch: () =>
        new ContactsDatabaseConnectionError({
          reason: 'Unable to initialize the Contacts PostgreSQL connection pool',
        }),
      try: acquire,
    }),
    (pool) => Effect.promise(() => pool.end()),
  );

export type PoolFactory = (configuration: PoolConfig) => Pool;

const defaultPoolFactory: PoolFactory = (configuration) => new Pool(configuration);

type ContextServiceContract<Service> =
  Service extends Context.Key<infer _Identifier, infer Contract> ? Contract : never;

export const makeContactsDatabase = (
  configuration: ContextServiceContract<typeof DatabaseConfig> & {
    readonly poolDeadlines?: Partial<DatabasePoolDeadlines>;
  },
  poolFactory: PoolFactory = defaultPoolFactory,
): Effect.Effect<
  ContextServiceContract<typeof ContactsDatabase>,
  ContactsDatabaseConnectionError,
  Scope.Scope
> =>
  Effect.gen(function* makeContactsDatabase() {
    const poolConfiguration = yield* makeDatabasePoolConfiguration(
      Redacted.value(configuration.connectionString),
      configuration.poolDeadlines,
    ).pipe(
      Effect.mapError((error) => new ContactsDatabaseConnectionError({ reason: error.reason })),
    );
    const pool = yield* acquirePoolResource(() => poolFactory(poolConfiguration));
    return {
      executor: drizzle({
        client: pool,
        relations: contactsRelations,
      }),
    };
  });

export const ContactsDatabaseLive = Layer.effect(
  ContactsDatabase,
  Effect.gen(function* makeContactsDatabaseService() {
    const configuration = yield* DatabaseConfig;
    return yield* makeContactsDatabase(configuration);
  }),
);
