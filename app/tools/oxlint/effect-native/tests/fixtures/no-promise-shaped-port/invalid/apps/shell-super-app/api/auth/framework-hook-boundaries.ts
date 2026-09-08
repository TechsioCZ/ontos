// expect-count: 3
import { betterAuth } from 'better-auth';
import { Effect } from 'effect';

// An exempt hook does not bless a first-party service record in its body.
export const provider = betterAuth({ databaseHooks: { session: { create: {
  before: async (session: object) => {
    const store = { load: async () => 'owned operation' };
    return { data: session, store };
  },
} } } });

// Shadowed SDK and Effect names provide no boundary identity.
export function fakeAuth(betterAuth: (options: unknown) => unknown) {
  return betterAuth({ databaseHooks: { session: { create: {
    before: async () => ({ data: {} }),
  } } } });
}
export function fakeEffect(Effect: { tryPromise: (options: unknown) => unknown }) {
  return Effect.tryPromise({ try: async () => 'not an Effect adapter' });
}
