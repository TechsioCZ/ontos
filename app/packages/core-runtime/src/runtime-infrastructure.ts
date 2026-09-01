import { Layer } from 'effect';
import { CoreDatabaseLive } from './db/client.ts';
import { DatabaseConfigLive } from './db/config.ts';

/** Server-composition layer that does not expose the underlying database capability. */
export const CorePersistenceLive = CoreDatabaseLive.pipe(Layer.provide(DatabaseConfigLive));
