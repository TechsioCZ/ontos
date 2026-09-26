import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer, Redacted } from 'effect';

import { acquireOutlivingCleanup } from '../../../../packages/core-runtime/tests/support/database.ts';

/** A native client for a fixture whose cleanup runs as a finalizer of the same scope. */
export const acquireFixturePgClient = (connectionString: string, maxConnections?: number) =>
  acquireOutlivingCleanup(Layer.build(PgClient.layer({ maxConnections, url: Redacted.make(connectionString) }))).pipe(
    Effect.map(Context.get(PgClient.PgClient)),
  );
