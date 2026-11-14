import { Console, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../database/identity-enrollment.ts';
import { verifyCoreDatabaseSchema } from '../packages/core-runtime/scripts/verify-db-schema.mts';
import { CoreDatabaseLive } from '../packages/core-runtime/src/db/client.ts';
import { DatabaseConfigLive } from '../packages/core-runtime/src/db/config.ts';
import { CORE_SCHEMA_NAME } from '../packages/core-runtime/src/db/schema.ts';

const DatabaseRuntimeLive = CoreDatabaseLive.pipe(Layer.provide(DatabaseConfigLive));

await Effect.runPromise(
  verifyCoreDatabaseSchema(APP_DATABASE_IDENTITY_ENROLLMENT).pipe(
    Effect.tap(({ tableCount }) =>
      Console.log(`Verified ${tableCount} typed tables in PostgreSQL schema ${CORE_SCHEMA_NAME}`),
    ),
    Effect.provide(Layer.merge(Reactivity.layer, DatabaseRuntimeLive)),
  ),
);
