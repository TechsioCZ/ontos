import { Layer } from 'effect';
import { AuthConfigLive } from './config.ts';
import { AuthDatabaseLive } from './db/client.ts';

/** Shell Auth composition layer that keeps its database service owner-private. */
const authDatabaseLive = AuthDatabaseLive.pipe(Layer.provide(AuthConfigLive));

export const AuthPersistenceLive = Layer.merge(AuthConfigLive, authDatabaseLive);
