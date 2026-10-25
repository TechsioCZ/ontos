import { Layer } from 'effect';

import { AuthConfigLive } from './config.ts';
import { AuthDatabaseLive } from './db/client.ts';

export { BetterAuthNativeAdapterLive } from './db/client.ts';
export { BetterAuthPersonInvitationIdentityProviderLive } from './db/person-invitation-provider.ts';

/** Dependency-transparent Shell Auth persistence, composed at the application root. */
export const AuthPersistenceLive = Layer.merge(AuthConfigLive, AuthDatabaseLive);
