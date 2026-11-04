import { Layer } from 'effect';

import { AuthConfig, AuthConfigLive } from './config.ts';
import { AuthDatabaseLive } from './db/client.ts';

/** Dependency-transparent Shell Auth persistence, composed at the application root. */
export const AuthPersistenceLive = Layer.merge(AuthConfigLive, AuthDatabaseLive);

/** Re-exposes the exact required configuration alongside its real Auth database pool. */
export const AuthPersistenceFromConfigLive = Layer.merge(Layer.effect(AuthConfig, AuthConfig), AuthDatabaseLive);
