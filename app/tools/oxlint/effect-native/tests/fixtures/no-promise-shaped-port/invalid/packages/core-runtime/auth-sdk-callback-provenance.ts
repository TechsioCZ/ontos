// expect-count: 11
import { betterAuth } from 'better-auth/minimal';
import { mcp } from '@better-auth/mcp';
import { mcp as wrongExport } from '@better-auth/oauth-provider';
import { mcp as firstParty } from './first-party';
import { makeMcp } from '@better-auth/mcp';

declare const fake: (options: unknown) => unknown;

export function shadowed(mcp: (options: unknown) => unknown, betterAuth: (options: unknown) => unknown) {
  mcp({ customAccessTokenClaims: async () => ({}) });
  betterAuth({ databaseHooks: { session: { create: { before: async () => ({ data: {} }) } } } });
}

let reboundMcp = mcp;
reboundMcp = fake;
export const rebound = reboundMcp({ postLogin: { shouldRedirect: async () => true } });
let reboundAuth = betterAuth;
reboundAuth = fake;
export const reboundProvider = reboundAuth({
  databaseHooks: { session: { create: { before: async () => ({ data: {} }) } } },
});

// Even a const binding with an illegal later write is not proven immutable by an AST-only rule.
const rewrittenMcp = mcp;
rewrittenMcp = fake;
export const rewritten = rewrittenMcp({ customAccessTokenClaims: async () => ({}) });

export const wrongModule = wrongExport({ customAccessTokenClaims: async () => ({}) });
export const localFactory = firstParty({ postLogin: { consentReferenceId: async () => 'local' } });
export const wrongName = makeMcp({ customAccessTokenClaims: async () => ({}) });

export function localFake() {
  const mcp = fake;
  return mcp({ postLogin: { shouldRedirect: async () => true } });
}

// SDK-looking names in a first-party surface remain ports, including explicit Promise aliases.
type Claims = (input: unknown) => Promise<Record<string, unknown>>;
export const service = { customAccessTokenClaims: async () => ({}) };
