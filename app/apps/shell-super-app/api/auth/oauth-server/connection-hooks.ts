// @effect-diagnostics asyncFunction:off -- Better Auth calls these OAuth hooks as Promise callbacks. expires: 2027-03-31.
/**
 * Better Auth OAuth hooks of the MCP connection grant (ONTOS-MCP-AUTH-DESIGN.md §2.1, §3.1).
 *
 * Lane mcp-oauth-as owns the Better Auth instance and wires these three hooks into `mcp({ postLogin, customAccessTokenClaims })`.
 * Lane mcp-connection-grants provides the real implementation as a Layer of `OAuthConnectionHooks`
 * (export `OAuthConnectionHooksLive` from api/oauth-connections/better-auth-hooks.ts). Until that Layer is provided,
 * the authentication service uses `stubOAuthConnectionHooks`.
 *
 * Call order in Better Auth 1.7.12 (spike S1): authorize → login → `shouldRedirect` (true → /cs/pripojit; again with
 * `isContinuation: true` after POST {issuer}/oauth2/continue {postLogin: true}) → `consentReferenceId` → consent page
 * /cs/pripojit/souhlas → POST {issuer}/oauth2/consent {accept} calls `consentReferenceId` again → authorize calls it a
 * third time and issues the code. All three calls must return the same grant id (draft or just-approved grant of this
 * Better Auth session and client). Refresh keeps `referenceId`, so `customAccessTokenClaims` sees it on every refresh.
 * The hooks get no client id; read it with `getOAuthProviderState()` from '@better-auth/oauth-provider'
 * (`new URLSearchParams(state?.query).get('client_id')`) or key the draft by `session.id`.
 */
import { OAUTH_GRANT_CLAIM } from '@app/shared-contracts/oauth-connections';
import { Context } from 'effect';

/** The Better Auth user fields the hooks may read (Better Auth passes `User & Record<string, unknown>`). */
export interface OAuthHookUser {
  readonly [field: string]: unknown;
  readonly email: string;
  readonly id: string;
}

/** The Better Auth session fields the hooks may read. `id` is the session the draft grant belongs to. */
export interface OAuthHookSession {
  readonly [field: string]: unknown;
  readonly id: string;
  readonly userId: string;
}

export interface OAuthPostLoginContext {
  readonly headers: Headers;
  /** `true` when the browser returns from /cs/pripojit through POST {issuer}/oauth2/continue `{ postLogin: true }`. */
  readonly isContinuation: boolean;
  readonly scopes: readonly string[];
  readonly session: OAuthHookSession;
  readonly user: OAuthHookUser;
}

export interface OAuthConsentReferenceContext {
  readonly scopes: readonly string[];
  readonly session: OAuthHookSession;
  readonly user: OAuthHookUser;
}

export interface OAuthAccessTokenClaimsInput {
  /** The grant id stored with the authorization code / refresh token (consent `referenceId`). */
  readonly referenceId?: string | undefined;
  readonly resources?: readonly string[] | undefined;
  readonly scopes: readonly string[];
  readonly user?: OAuthHookUser | null | undefined;
}

export interface OAuthConnectionHooksContract {
  /** Returns the extra JWT claims; must include `https://ontos.cz/grant` = referenceId. Throw to refuse the token. */
  readonly customAccessTokenClaims: (input: OAuthAccessTokenClaimsInput) => Promise<Readonly<Record<string, unknown>>>;
  /** The grant id (draft or active) of this session's connect flow; throw when there is none. */
  readonly consentReferenceId: (context: OAuthConsentReferenceContext) => Promise<string | undefined>;
  /** `true` sends the browser to /cs/pripojit (no usable draft yet); `false` continues to consent. */
  readonly shouldRedirect: (context: OAuthPostLoginContext) => Promise<boolean>;
}

export class OAuthConnectionHooks extends Context.Service<OAuthConnectionHooks, OAuthConnectionHooksContract>()(
  '@app/shell-super-app/api/auth/oauth-server/connection-hooks/OAuthConnectionHooks',
) {}

/** Fixed draft id used only until lane mcp-connection-grants provides `OAuthConnectionHooksLive`. */
export const STUB_DRAFT_GRANT_ID = '00000000-0000-4000-8000-00000000d0a1';

/** Placeholder hooks: one visit to /cs/pripojit, then a fixed draft id as consent reference and grant claim. */
export const stubOAuthConnectionHooks: OAuthConnectionHooksContract = {
  consentReferenceId: async () => STUB_DRAFT_GRANT_ID,
  customAccessTokenClaims: async ({ referenceId }) =>
    referenceId === undefined ? {} : { [OAUTH_GRANT_CLAIM]: referenceId },
  shouldRedirect: async ({ isContinuation }) => !isContinuation,
};
