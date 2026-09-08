// Ratified owner-private composition module (`compositionFiles`): allowed only when explicitly listed.
import { Layer } from 'effect';

import { CoreDatabaseLive, DatabaseConfigLive } from './db.ts';

export const CorePersistenceLive = CoreDatabaseLive.pipe(Layer.provide(DatabaseConfigLive));
