import { PrincipalResolver } from '@app/core-runtime';
import type { PrincipalResolutionError } from '@app/core-runtime';
import { apiKey } from '@better-auth/api-key';
import { cimd } from '@better-auth/cimd';
import { mcp } from '@better-auth/mcp';
import { AsyncLocalStorage } from 'node:async_hooks';
import { APIError } from 'better-auth';
import type { Session as BetterAuthSession } from 'better-auth';
import { betterAuth } from 'better-auth/minimal';
import { admin } from 'better-auth/plugins/admin';
import { jwt } from 'better-auth/plugins/jwt';
import { Context, Data, Effect, Function as Fn, Layer, Predicate, Redacted, Schema } from 'effect';

import { mcpResourceUrlOf } from '../../shared/mcp-resource.ts';
import { fetchClientMetadataResource as fetchClientMetadataOnNode } from './cimd-transport.node.ts';
import { fetchClientMetadataResource as fetchClientMetadataOnWorkerd } from './cimd-transport.workerd.ts';
import { AuthConfig } from './config.ts';
import type { AuthConfigValue } from './config.ts';
import { AUTH_OPERATION_TIMEOUT_MS } from './observability.ts';
import type {
  OAuthAccessTokenClaimsInput,
  OAuthConnectionHooksContract,
  OAuthConsentReferenceContext,
  OAuthPostLoginContext,
} from './oauth-server/connection-hooks.ts';
import {
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_BASE_PATH,
  OAUTH_CONNECT_PAGE,
  OAUTH_CONSENT_PAGE,
  OAUTH_LOGIN_PAGE,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  OAUTH_SCOPES,
  oauthIssuerFor,
  validateAuthorizeRedirectUri,
} from './oauth-server/policy.ts';

import { BetterAuthNativeAdapter } from './better-auth-native-adapter.ts';
import type {
  BetterAuthDispatcher,
  ShellBetterAuth,
  ShellBetterAuthAdapter,
  ShellSessionOptions,
} from './better-auth-provider-types.ts';
import { BetterAuthRuntime } from './better-auth-runtime.ts';
import { OAuthConnectionHooks } from './oauth-server/connection-hooks.ts';
import { OAuthGuardSessionsLive } from './oauth-server/guard-sessions.ts';

export const FORBIDDEN_IDENTITY_CODE = 'ONTOS_IDENTITY_FORBIDDEN';
export const IDENTITY_UNAVAILABLE_CODE = 'ONTOS_IDENTITY_UNAVAILABLE';

const mapResolverApiError = (error: PrincipalResolutionError): APIError =>
  Predicate.isTagged(error, 'PrincipalResolverUnavailableError')
    ? new APIError('SERVICE_UNAVAILABLE', {
        code: IDENTITY_UNAVAILABLE_CODE,
        message: 'Authentication is temporarily unavailable',
      })
    : new APIError('FORBIDDEN', {
        code: FORBIDDEN_IDENTITY_CODE,
        message: 'The authenticated identity cannot access OntOS',
      });

/** Only expected native failures become HTTP errors; APIError and unexpected defects retain their original cause. */
const mapOAuthHookApiError = (
  error: Effect.Error<ReturnType<OAuthConnectionHooksContract['consentReferenceId']>>,
): APIError =>
  Predicate.isTagged(error, 'ConnectionInvalid')
    ? new APIError('BAD_REQUEST', {
        error: 'invalid_grant',
        error_description: 'The OAuth connection grant is unavailable',
      })
    : new APIError('SERVICE_UNAVAILABLE', { message: 'OAuth authorization is temporarily unavailable' });

type ShellSessionCreateHook = <Session extends { readonly userId: string }>(
  session: Session,
) => Effect.Effect<
  {
    readonly data: Session & {
      readonly activeContextKind: 'company';
      readonly activeLegalEntityId: null;
      readonly activeTenantId: string;
    };
  },
  APIError
>;

/**
 * What the serving request lends a ready Better Auth provider. Workerd binds each socket to the request that opened
 * it: database operations and resolver/OAuth hooks must use these bindings, never a previous request's resources.
 * Only a fully initialized provider may outlive its creating request in the isolate's ready-provider cache.
 */
interface BetterAuthRequestBindings {
  readonly beforeSessionCreate: ShellSessionCreateHook;
  readonly databaseAdapter: ShellBetterAuthAdapter;
  readonly oauthHooks: OAuthConnectionHooksContract;
  readonly runResolverEffect: typeof Effect.runPromise;
}

const betterAuthRequest = new AsyncLocalStorage<BetterAuthRequestBindings>();

const BetterAuthOutsideRequestError = Data.TaggedError('BetterAuthOutsideRequestError')<{
  readonly reason: string;
}>;

const requestBindings = (): BetterAuthRequestBindings => {
  const bindings = betterAuthRequest.getStore();
  if (bindings === undefined) {
    throw new BetterAuthOutsideRequestError({
      reason: 'Better Auth must run inside a Shell request with its native adapter',
    });
  }
  return bindings;
};

type BetterAuthAdapterInstance = ReturnType<ShellBetterAuthAdapter>;
/** Better Auth retains metadata, but every typed database operation uses the serving request's adapter. */
const requestScopedDatabase: ShellBetterAuthAdapter = (betterAuthOptions) => {
  const current = () => requestBindings().databaseAdapter(betterAuthOptions);
  const initial = current();
  const adapter: BetterAuthAdapterInstance = {
    ...initial,
    get consumeOne() {
      const nativeAdapter = current();
      return nativeAdapter.consumeOne.bind(nativeAdapter);
    },
    get count() {
      const nativeAdapter = current();
      return nativeAdapter.count.bind(nativeAdapter);
    },
    get create() {
      const nativeAdapter = current();
      return nativeAdapter.create.bind(nativeAdapter);
    },
    get createSchema() {
      const nativeAdapter = current();
      return nativeAdapter.createSchema?.bind(nativeAdapter);
    },
    get delete() {
      const nativeAdapter = current();
      return nativeAdapter.delete.bind(nativeAdapter);
    },
    get deleteMany() {
      const nativeAdapter = current();
      return nativeAdapter.deleteMany.bind(nativeAdapter);
    },
    get findMany() {
      const nativeAdapter = current();
      return nativeAdapter.findMany.bind(nativeAdapter);
    },
    get findOne() {
      const nativeAdapter = current();
      return nativeAdapter.findOne.bind(nativeAdapter);
    },
    get incrementOne() {
      const nativeAdapter = current();
      return nativeAdapter.incrementOne.bind(nativeAdapter);
    },
    get transaction() {
      const nativeAdapter = current();
      return nativeAdapter.transaction.bind(nativeAdapter);
    },
    get update() {
      const nativeAdapter = current();
      return nativeAdapter.update.bind(nativeAdapter);
    },
    get updateMany() {
      const nativeAdapter = current();
      return nativeAdapter.updateMany.bind(nativeAdapter);
    },
  };
  return adapter;
};

const makeShellBetterAuth = (configuration: AuthConfigValue, allowFixtureSignUp: boolean): ShellBetterAuth => {
  const oauthIssuer = oauthIssuerFor(configuration.baseUrl);
  const mcpResourceUrl = mcpResourceUrlOf(configuration.baseUrl);
  return betterAuth<ShellSessionOptions>({
    advanced: {
      // Every Shell call reads its session; the adapter joins the session's user into that one statement instead of a
      // second query. Revocation is unchanged: each read still asks the database, nothing is cached.
      database: { joins: true },
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: configuration.secureCookies,
      },
      useSecureCookies: configuration.secureCookies,
    },
    basePath: OAUTH_BASE_PATH,
    baseURL: configuration.baseUrl,
    database: requestScopedDatabase,
    databaseHooks: {
      session: {
        create: {
          before: Fn.flow((session: BetterAuthSession) => {
            const bindings = requestBindings();
            return (bindings.runResolverEffect<Effect.Success<ReturnType<ShellSessionCreateHook>>, APIError>).bind(
              undefined,
              Effect.suspend(() => bindings.beforeSessionCreate(session)),
            );
          }, Fn.apply({})),
        },
      },
    },
    emailAndPassword: {
      autoSignIn: !allowFixtureSignUp,
      disableSignUp: !allowFixtureSignUp,
      enabled: true,
    },
    logger: {
      disabled: true,
    },
    plugins: [
      apiKey({
        enableMetadata: true,
        enableSessionForAPIKeys: false,
        references: 'user',
      }),
      admin({
        adminUserIds: [...configuration.supportUserIds],
        allowImpersonatingAdmins: false,
      }),
      // OAuth 2.1 authorization server for MCP clients (ONTOS-MCP-AUTH-DESIGN.md §2). Issuer = baseURL + basePath.
      jwt({
        // Never sign a JWT on every getSession; only OAuth access/ID tokens are JWTs.
        disableSettingJwtHeader: true,
        jwks: { keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' } },
        jwt: { issuer: oauthIssuer },
      }),
      mcp({
        accessTokenExpiresIn: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
        allowPublicClientPrelogin: true,
        consentPage: OAUTH_CONSENT_PAGE,
        customAccessTokenClaims: Fn.flow((input: OAuthAccessTokenClaimsInput) => {
          const bindings = requestBindings();
          return (bindings.runResolverEffect<
            Effect.Success<ReturnType<OAuthConnectionHooksContract['customAccessTokenClaims']>>,
            APIError
          >).bind(
            undefined,
            Effect.suspend(() => bindings.oauthHooks.customAccessTokenClaims(input)).pipe(
              Effect.mapError(mapOAuthHookApiError),
              Effect.timeoutOrElse({
                duration: AUTH_OPERATION_TIMEOUT_MS,
                orElse: () => Effect.fail(new APIError('SERVICE_UNAVAILABLE')),
              }),
            ),
          );
        }, Fn.apply({})),
        grantTypes: ['authorization_code', 'refresh_token'],
        loginPage: OAUTH_LOGIN_PAGE,
        postLogin: {
          consentReferenceId: Fn.flow((context: OAuthConsentReferenceContext) => {
            const bindings = requestBindings();
            return (bindings.runResolverEffect<string, APIError>).bind(
              undefined,
              Effect.suspend(() => bindings.oauthHooks.consentReferenceId(context)).pipe(
                Effect.mapError(mapOAuthHookApiError),
                Effect.timeoutOrElse({
                  duration: AUTH_OPERATION_TIMEOUT_MS,
                  orElse: () => Effect.fail(new APIError('SERVICE_UNAVAILABLE')),
                }),
              ),
            );
          }, Fn.apply({})),
          page: OAUTH_CONNECT_PAGE,
          shouldRedirect: Fn.flow((context: OAuthPostLoginContext) => {
            const bindings = requestBindings();
            return (bindings.runResolverEffect<boolean, APIError>).bind(
              undefined,
              Effect.suspend(() => bindings.oauthHooks.shouldRedirect(context)).pipe(
                Effect.mapError(mapOAuthHookApiError),
                Effect.timeoutOrElse({
                  duration: AUTH_OPERATION_TIMEOUT_MS,
                  orElse: () => Effect.fail(new APIError('SERVICE_UNAVAILABLE')),
                }),
              ),
            );
          }, Fn.apply({})),
        },
        rateLimit: {
          authorize: { max: 60, window: 60 },
          token: { max: 120, window: 60 },
        },
        refreshTokenExpiresIn: OAUTH_REFRESH_TOKEN_TTL_SECONDS,
        resource: mcpResourceUrl,
        // No allowedScopes on purpose: Better Auth intersects them with the request and would drop offline_access/openid (spike S3).
        resources: [{ accessTokenTtl: OAUTH_ACCESS_TOKEN_TTL_SECONDS, identifier: mcpResourceUrl, name: 'OntOS MCP' }],
        resourceSeedMode: 'overwrite',
        scopes: [...OAUTH_SCOPES],
        validateRedirectUri: validateAuthorizeRedirectUri,
      }),
      // CIMD only (NO-COMPAT): no dynamic client registration; runtime-specific transport enforces the metadata fetch boundary.
      cimd({
        // The BFF source loader resolves this app's own imports with Node conditions, so the runtime picks.
        fetchClientMetadataResource:
          globalThis.navigator?.userAgent === 'Cloudflare-Workers'
            ? fetchClientMetadataOnWorkerd
            : fetchClientMetadataOnNode,
        metadataProfile: 'mcp-2026-07-28',
      }),
    ],
    secret: configuration.secret,
    session: {
      additionalFields: {
        activeContextKind: {
          defaultValue: 'company',
          input: true,
          required: true,
          type: 'string',
        },
        activeLegalEntityId: {
          input: true,
          required: false,
          type: 'string',
        },
        activeTenantId: {
          input: true,
          required: false,
          type: 'string',
        },
        impersonationActionId: {
          input: false,
          required: false,
          type: 'string',
        },
        impersonationOriginalAuthBindingId: {
          input: false,
          required: false,
          type: 'string',
        },
        impersonationOriginalPrincipalId: {
          input: false,
          required: false,
          type: 'string',
        },
        impersonationOriginalSessionId: {
          input: false,
          required: false,
          type: 'string',
        },
        impersonationReason: {
          input: false,
          required: false,
          type: 'string',
        },
        impersonationTargetPrincipalId: {
          input: false,
          required: false,
          type: 'string',
        },
      },
    },
    trustedOrigins: [...configuration.trustedOrigins],
  });
};

export interface BetterAuthFrameworkOptions {
  readonly allowFixtureSignUp?: boolean;
}

const BetterAuthCacheKey = Schema.fromJsonString(
  Schema.Tuple([
    Schema.Boolean,
    Schema.String,
    Schema.Redacted(Schema.String),
    Schema.Boolean,
    Schema.Array(Schema.String),
    Schema.Array(Schema.String),
  ]),
);

const makeBetterAuthFramework = Effect.fn('BetterAuthFramework.make')(function* makeBetterAuthFramework(
  options: BetterAuthFrameworkOptions,
) {
  const configuration = yield* AuthConfig;
  const nativeAdapter = yield* BetterAuthNativeAdapter;
  const resolver = yield* PrincipalResolver;
  const effectContext = yield* Effect.context();
  const oauthHooks = yield* OAuthConnectionHooks;
  const runtime = yield* BetterAuthRuntime;
  const allowFixtureSignUp = options.allowFixtureSignUp === true;
  const prepareCreatedSession = <Session extends { readonly userId: string }>(session: Session) =>
    resolver.resolveDefaultBetterAuthUser(session.userId).pipe(
      Effect.map((principal) => ({
        data: {
          ...session,
          activeContextKind: 'company' as const,
          activeLegalEntityId: null,
          activeTenantId: principal.tenantId,
        },
      })),
      Effect.mapError(mapResolverApiError),
    );
  let adapter: BetterAuthAdapterInstance | undefined;
  const bindings: BetterAuthRequestBindings = {
    beforeSessionCreate: prepareCreatedSession,
    databaseAdapter: (authOptions) => {
      adapter ??= nativeAdapter.forOptions(authOptions);
      return adapter;
    },
    oauthHooks,
    runResolverEffect: Effect.runPromiseWith(effectContext),
  };
  const cacheKey = yield* Schema.encodeEffect(BetterAuthCacheKey)([
    allowFixtureSignUp,
    configuration.baseUrl,
    Redacted.make(configuration.secret),
    configuration.secureCookies,
    configuration.supportUserIds,
    configuration.trustedOrigins,
  ]).pipe(Effect.orDie);
  // Only the ready provider is isolate-owned. The dispatcher and adapter remain request-owned and lazy.
  let auth: ShellBetterAuth | undefined;
  const getAuth = () => {
    auth ??= runtime.getOrCreate(cacheKey, () =>
      betterAuthRequest.run(bindings, () => makeShellBetterAuth(configuration, allowFixtureSignUp)),
    );
    return auth;
  };
  const callAuth: BetterAuthDispatcher = (operation) => {
    const nativeOperation = () => operation(getAuth());
    return Effect.withFiber((fiber) =>
      Effect.callback(function dispatchNativeAuth(resume, signal) {
        betterAuthRequest.run(bindings, Effect.runCallbackWith(fiber.context), Effect.suspend(nativeOperation), {
          onExit: resume,
          scheduler: this,
          signal,
        });
      }),
    );
  };
  return { allowFixtureSignUp, callAuth, issuer: oauthIssuerFor(configuration.baseUrl) };
});

export class BetterAuthFramework extends Context.Service<
  BetterAuthFramework,
  Effect.Success<ReturnType<typeof makeBetterAuthFramework>>
>()('@app/shell-super-app/api/auth/better-auth-framework/BetterAuthFramework') {}

/** Request-owned native SDK dispatcher and its real session callback; compose guards at the application root. */
export const BetterAuthFrameworkLive = (options: BetterAuthFrameworkOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* betterAuthFrameworkServices() {
      const framework = yield* makeBetterAuthFramework(options);
      return Layer.merge(Layer.succeed(BetterAuthFramework, framework), OAuthGuardSessionsLive(framework.callAuth));
    }),
  );
