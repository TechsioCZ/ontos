// expect-count: 17
import { betterAuth } from 'better-auth/minimal';
import { mcp } from '@better-auth/mcp';

declare const buildOptions: (options: unknown) => unknown;
declare const extra: unknown;

export const auth = betterAuth({
  databaseHooks: {
    session: { create: {
      before: async (session) => {
        const store = { load: async () => 'first-party' };
        return { data: session, store };
      },
      custom: async () => 'not a hook',
    } },
    custom: { create: { before: async () => 'not an SDK model' } },
  },
  service: { load: async () => 'first-party' },
  plugins: [mcp({
    resource: 'https://example.invalid/mcp',
    customAccessTokenClaims: async (input) => {
      const service = { load: async () => 'first-party' };
      return { scopes: input.scopes, service };
    },
    postLogin: {
      consentReferenceId: async (context) => {
        const service = { load: async () => 'first-party' };
        return service;
      },
      shouldRedirect: async (context) => {
        const service = { load: async () => 'first-party' };
        return service;
      },
      load: async () => 'extra callback',
      service: { shouldRedirect: async () => true },
      customAccessTokenClaims: async () => ({}),
    },
    consentReferenceId: async () => 'wrong depth',
    shouldRedirect: async () => true,
    service: { customAccessTokenClaims: async () => ({}) },
  })],
});

// Calling a custom builder with SDK-looking options does not give it an SDK contract.
export const built = mcp(buildOptions({ customAccessTokenClaims: async () => ({}) }));
export const builtAuth = betterAuth(buildOptions({
  databaseHooks: { session: { create: { before: async () => ({ data: {} }) } } },
}));

// The SDK constructors take one options argument, not a callback-bearing second argument.
export const extraMcp = mcp(extra, { customAccessTokenClaims: async () => ({}) });
export const extraAuth = betterAuth(extra, {
  databaseHooks: { session: { create: { before: async () => ({ data: {} }) } } },
});
