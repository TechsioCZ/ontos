import { Effect } from 'effect';

/**
 * The provider user every module credential belongs to. It has no account and no password, and no principal binding
 * names it. It never holds a session: the session-create hook refuses one for it, and support impersonation refuses
 * it as a target, so no Better Auth endpoint (`/api-key/*` included) can ever act as it.
 */
export const PLATFORM_KEY_OWNER = Object.freeze({
  email: 'module-credentials@ontos-platform.invalid',
  id: 'ontos-platform-module-credentials',
  name: 'OntOS platform module credentials',
});

/** Whether a provider user is the platform's module-credential owner. */
export const isPlatformKeyOwner = (userId: string): boolean => userId === PLATFORM_KEY_OWNER.id;

/** Refuses a session for the platform key owner; every other user goes on to the ordinary principal resolution. */
export const refusePlatformKeyOwnerSession = <E>(userId: string, refusal: () => E): Effect.Effect<void, E> =>
  isPlatformKeyOwner(userId) ? Effect.fail(refusal()) : Effect.void;
