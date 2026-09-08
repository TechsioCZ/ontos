import { Layer } from 'effect';

import { AuthConfigLive } from './config.ts';
import { AuthDatabaseLive } from './db/client.ts';

/** Dependency-transparent Shell Auth persistence, composed at the application root. */
export const AuthPersistenceLive = Layer.merge(
  AuthConfigLive,
  AuthDatabaseLive
);
