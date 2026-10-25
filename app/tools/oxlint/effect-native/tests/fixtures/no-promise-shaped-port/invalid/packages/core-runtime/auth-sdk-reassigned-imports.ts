// expect-count: 2
import { betterAuth } from 'better-auth/minimal';
import { mcp } from '@better-auth/mcp';

declare const fake: (options: unknown) => unknown;

// Even illegal writes to import bindings break syntax-only evidence of constructor identity.
mcp = fake;
betterAuth = fake;
export const rewrittenImport = mcp({ customAccessTokenClaims: async () => ({}) });
export const rewrittenAuthImport = betterAuth({
  databaseHooks: { session: { create: { before: async () => ({ data: {} }) } } },
});
