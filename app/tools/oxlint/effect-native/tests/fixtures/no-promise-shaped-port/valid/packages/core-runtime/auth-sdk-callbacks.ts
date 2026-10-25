import { betterAuth } from 'better-auth/minimal';
import { mcp as mcpPlugin } from '@better-auth/mcp';

// better-auth 1.7.12: minimal uses BetterAuthOptions, including the two-argument database hooks.
// @better-auth/mcp 1.7.12: McpOptions extends OAuthOptions; these callbacks return Awaitable.
const createAuth = betterAuth;
const mcp = mcpPlugin;
export const auth = createAuth({
  databaseHooks: {
    session: { create: {
      before: async (session, context) => ({ data: session }),
      after: async (session): Promise<void> => { void session; },
    } },
    user: { update: { before: async (user) => ({ data: user }) } },
    account: { delete: { after: async () => {} } },
    verification: { create: { before: async (verification) => ({ data: verification }) } },
  },
  plugins: [mcp({
    resource: 'https://example.invalid/mcp',
    customAccessTokenClaims: async (input): Promise<Record<string, unknown>> => ({ scopes: input.scopes }),
    postLogin: {
      page: '/connect',
      consentReferenceId: async (context): Promise<string | undefined> => context.session.id,
      async shouldRedirect(context): Promise<boolean> { return !context.isContinuation; },
    },
  })],
});

// Direct SDK construction is sufficient: a plugin need not already be registered with betterAuth.
export const plugin = mcpPlugin({
  resource: 'https://example.invalid/mcp',
  ['customAccessTokenClaims']: function (input): Promise<Record<string, unknown>> {
    return Promise.resolve({ scopes: input.scopes });
  },
  postLogin: {
    page: '/connect',
    [`consentReferenceId`]: async () => undefined,
    shouldRedirect: async ({ isContinuation }) => !isContinuation,
  },
});
