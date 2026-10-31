// expect-count: 8
import { betterAuth } from 'better-auth/minimal';
import { mcp } from '@better-auth/mcp';

declare const extra: unknown;

// The verified OAuth callbacks take one context argument, not additional required arguments or rest protocols.
export const wrongCallbackSignatures = mcp({
  customAccessTokenClaims: async (input, ownedService) => ({}),
  postLogin: {
    consentReferenceId: async (context, ownedService) => 'owned',
    shouldRedirect: async (...contexts) => true,
  },
});
export const wrongHookSignature = betterAuth({
  databaseHooks: { session: { create: { before: async (session, context, service) => ({ data: session }) } } },
});

// Both constructors have exactly one options argument; an extra argument is not an SDK construction shape.
export const extraMcp = mcp({ customAccessTokenClaims: async () => ({}) }, extra);
export const extraAuth = betterAuth({
  databaseHooks: { session: { create: { before: async () => ({ data: {} }) } } },
}, extra);

// A standalone option record is not proven to be used only by an SDK boundary.
export const options = { customAccessTokenClaims: async () => ({}) };
export const constructedLater = mcp(options);

// A callback binding used by both SDK and first-party services is not a blanket alias exemption.
const claims = async () => ({});
export const callbackPlugin = mcp({ customAccessTokenClaims: claims });
export const ownedService = { load: claims };
