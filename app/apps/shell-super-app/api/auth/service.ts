import type {
  AvailableTenant,
  PrincipalResolutionError,
  ResolvedPrincipalIdentity,
  TrustedPrincipalContext,
  LegalEntityContext,
} from '@app/core-runtime';
import {
  ContextAccess,
  isDatabaseUnavailableFailure,
  PrincipalResolver,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { apiKey } from '@better-auth/api-key';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '#cimd-transport';
import { mcp } from '@better-auth/mcp';
import { APIError, betterAuth } from 'better-auth';
import { isAPIError } from 'better-auth/api';
import { getCookies } from 'better-auth/cookies';
import { admin } from 'better-auth/plugins/admin';
import { jwt } from 'better-auth/plugins/jwt';
import { Context, Effect, Function as Fn, Layer, Option, Predicate, Redacted, Schema, flow } from 'effect';
import { empty as emptyCookies, expireCookieUnsafe, toSetCookieHeaders } from 'effect/unstable/http/Cookies';

import { mcpResourceUrlOf } from '../../shared/mcp-resource.ts';
import { AuthConfig } from './config.ts';
import { observeAuthenticationPhase, withAuthenticationTimeout } from './observability.ts';
import type { AuthenticationPhase } from './observability.ts';
import type { AuthConfigValue } from './config.ts';
import { AuthDatabase } from './db/client.ts';
import type { BetterAuthDatabaseAdapter } from './db/types.ts';
import {
  AuthenticationInternalError,
  AuthenticationUnavailableError,
  InvalidCredentialsError,
  OntosIdentityForbiddenError,
  TenantAccessForbiddenError,
} from './errors.ts';
import { OAuthConnectionHooks, stubOAuthConnectionHooks } from './oauth-server/connection-hooks.ts';
import { makeOAuthEndpointGuards } from './oauth-server/endpoint-guards.ts';
import type { OAuthConnectionHooksContract } from './oauth-server/connection-hooks.ts';
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
import type { OAuthServerEndpoint } from './oauth-server/policy.ts';
import type {
  AuthenticationRuntimeError,
  AuthenticationUnavailableFailure,
  AuthenticationUnavailableReason,
  OntosIdentityForbiddenFailure,
  SwitchTenantRuntimeError,
  TenantAccessForbiddenFailure,
} from './errors.ts';
import type { LegalEntitySelectionForbiddenError } from './legal-entity-selection.ts';
import {
  LegalEntitySelectionUnavailableError,
  resolveAuthorizedLegalEntities,
  validateAuthorizedLegalEntity,
} from './legal-entity-selection.ts';

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

const FORBIDDEN_IDENTITY_CODE = 'ONTOS_IDENTITY_FORBIDDEN';
const IDENTITY_UNAVAILABLE_CODE = 'ONTOS_IDENTITY_UNAVAILABLE';
const unavailable = (reason: AuthenticationUnavailableReason) => new AuthenticationUnavailableError({ reason });

type AuthenticationSecretInput = Redacted.Redacted | string;

type FixtureUserProvision = (
  email: string,
  name: string,
  authenticationSecret: AuthenticationSecretInput,
) => Effect.Effect<string, AuthenticationRuntimeError>;

const revealAuthenticationSecret = (input: AuthenticationSecretInput): string =>
  Redacted.isRedacted(input) ? Redacted.value(input) : input;

interface SafeTenantIdentity {
  readonly displayName: string;
  readonly email: string;
  readonly impersonating?: true;
  readonly principalId: string;
  readonly tenantId: string;
}

interface SafeAuthenticatedIdentity extends SafeTenantIdentity {
  readonly legalEntityId: string;
  readonly legalName: string;
}

interface AuthenticationResult {
  readonly identity: SafeTenantIdentity;
  readonly setCookieHeaders: readonly string[];
}

type TenantContextResult =
  | {
      readonly setCookieHeaders: readonly string[];
      readonly state: 'anonymous';
    }
  | {
      readonly identity: SafeTenantIdentity;
      readonly principal: TrustedPrincipalContext;
      readonly setCookieHeaders: readonly string[];
      readonly state: 'authenticated';
    };

interface CurrentSessionResult {
  readonly identity: SafeTenantIdentity | null;
  readonly setCookieHeaders: readonly string[];
}

interface SignOutResult {
  readonly setCookieHeaders: readonly string[];
}

interface AvailableTenantsResult {
  readonly setCookieHeaders: readonly string[];
  readonly tenants: readonly AvailableTenant[];
}

interface SwitchTenantResult {
  readonly selectedTenantId: string;
  readonly setCookieHeaders: readonly string[];
}

interface AnonymousResolvedSession {
  readonly setCookieHeaders: readonly string[];
  readonly state: 'anonymous';
}

interface AuthenticatedResolvedSession {
  readonly identity: SafeTenantIdentity;
  readonly principal: TrustedPrincipalContext;
  readonly savedLegalEntityId?: string;
  readonly selectedTenantId: string;
  readonly setCookieHeaders: readonly string[];
  readonly state: 'authenticated';
  readonly userId: string;
}

type ResolvedSession = AnonymousResolvedSession | AuthenticatedResolvedSession;
type ResolvedSessionEffect = Effect.Effect<ResolvedSession, AuthenticationRuntimeError, ContextAccess>;

interface SupportImpersonationLifecycle {
  readonly actionId: string;
  readonly originalAuthBindingId: string;
  readonly originalPrincipalId: string;
  readonly originalSessionId: string;
  readonly reason: string;
  readonly targetPrincipalId: string;
}

interface ResolvedTenantIdentity {
  readonly identity: SafeTenantIdentity;
  readonly principal: TrustedPrincipalContext;
}

type ResolveImpersonatedIdentity = (
  user: { readonly email: string; readonly id: string },
  originalBetterAuthUserId: string,
  tenantId: string,
  sessionId: string,
  lifecycle: SupportImpersonationLifecycle,
) => Effect.Effect<
  ResolvedTenantIdentity,
  AuthenticationUnavailableFailure | OntosIdentityForbiddenFailure,
  ContextAccess
>;

type ResolveShellContext = (
  requestHeaders: Headers,
) => Effect.Effect<ShellContextResult, AuthenticationRuntimeError, ContextAccess | LegalEntityContext>;

type ResolveAuthenticatedContext = (
  resolved: AuthenticatedResolvedSession,
  requestHeaders: Headers,
) => Effect.Effect<
  Exclude<ShellContextResult, { readonly state: 'anonymous' }>,
  AuthenticationRuntimeError,
  ContextAccess | LegalEntityContext
>;

export type ShellContextResult =
  | {
      readonly setCookieHeaders: readonly string[];
      readonly state: 'anonymous';
    }
  | {
      readonly availableLegalEntities: readonly {
        readonly legalEntityId: string;
        readonly legalName: string;
      }[];
      readonly identity: SafeAuthenticatedIdentity;
      readonly principal: TrustedPrincipalContext;
      readonly setCookieHeaders: readonly string[];
      readonly state: 'authenticated';
    }
  | {
      readonly availableLegalEntities: readonly {
        readonly legalEntityId: string;
        readonly legalName: string;
      }[];
      readonly identity: SafeTenantIdentity;
      readonly principal: TrustedPrincipalContext;
      readonly setCookieHeaders: readonly string[];
      readonly state: 'selection_required';
    }
  | {
      readonly availableLegalEntities: readonly [];
      readonly identity: SafeTenantIdentity;
      readonly principal: TrustedPrincipalContext;
      readonly setCookieHeaders: readonly string[];
      readonly state: 'access_blocked';
    };

export interface AuthenticationServiceContract {
  readonly availableTenants: (
    requestHeaders: Headers,
  ) => Effect.Effect<AvailableTenantsResult, AuthenticationRuntimeError, ContextAccess>;
  readonly createFixtureUser: FixtureUserProvision;
  readonly currentSession: (
    requestHeaders: Headers,
  ) => Effect.Effect<CurrentSessionResult, AuthenticationRuntimeError, ContextAccess>;
  /** Better Auth OAuth 2.1 authorization server for MCP clients; mounted by api/auth/oauth-server/transport.ts. Optional so test doubles stay valid. */
  readonly oauth?: OAuthServerEndpoint;
  readonly resolveShellContext: (
    requestHeaders: Headers,
  ) => Effect.Effect<ShellContextResult, AuthenticationRuntimeError, ContextAccess | LegalEntityContext>;
  readonly resolveTenantContext: (
    requestHeaders: Headers,
  ) => Effect.Effect<TenantContextResult, AuthenticationRuntimeError, ContextAccess>;
  readonly signIn: (
    email: string,
    authenticationSecret: AuthenticationSecretInput,
    requestHeaders: Headers,
  ) => Effect.Effect<AuthenticationResult, AuthenticationRuntimeError>;
  readonly signOut: (requestHeaders: Headers) => Effect.Effect<SignOutResult, AuthenticationRuntimeError>;
  readonly switchLegalEntity: (
    legalEntityId: string,
    requestHeaders: Headers,
  ) => Effect.Effect<
    {
      readonly selectedLegalEntityId: string;
      readonly setCookieHeaders: readonly string[];
    },
    AuthenticationRuntimeError | LegalEntitySelectionForbiddenError,
    ContextAccess | LegalEntityContext
  >;
  readonly switchTenant: (
    tenantId: string,
    requestHeaders: Headers,
  ) => Effect.Effect<SwitchTenantResult, SwitchTenantRuntimeError, ContextAccess>;
}

export class AuthenticationService extends Context.Service<AuthenticationService, AuthenticationServiceContract>()(
  '@app/shell-super-app/api/auth/service/AuthenticationService',
) {}

const mapResolverError = (
  error: PrincipalResolutionError,
): AuthenticationUnavailableFailure | OntosIdentityForbiddenFailure =>
  Predicate.isTagged(error, 'PrincipalResolverUnavailableError')
    ? unavailable('principal_resolver_unavailable')
    : new OntosIdentityForbiddenError();

type TrustedPrincipalContextInput = Readonly<{
  readonly authBindingId: string;
  readonly authContextRef: string;
  readonly authenticationNamespaceId: string;
  readonly authMethod: 'session' | 'support_impersonation';
  readonly impersonatedByPrincipalId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}>;

const mapPrincipalContextDecodeError = (cause: Schema.SchemaError): OntosIdentityForbiddenFailure =>
  new OntosIdentityForbiddenError({ cause });

const decodeTrustedPrincipalContext = (
  input: TrustedPrincipalContextInput,
): Effect.Effect<TrustedPrincipalContext, OntosIdentityForbiddenFailure> =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)(input).pipe(Effect.mapError(mapPrincipalContextDecodeError));

const mapTenantSwitchResolverError = (
  error: PrincipalResolutionError,
): AuthenticationUnavailableFailure | TenantAccessForbiddenFailure =>
  Predicate.isTagged(error, 'PrincipalResolverUnavailableError')
    ? unavailable('principal_resolver_unavailable')
    : new TenantAccessForbiddenError();

const mapLegalEntitySelectionError = (
  error: LegalEntitySelectionForbiddenError | LegalEntitySelectionUnavailableError,
): AuthenticationUnavailableFailure | LegalEntitySelectionForbiddenError =>
  Schema.is(LegalEntitySelectionUnavailableError)(error) ? unavailable('legal_entity_selection_unavailable') : error;

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

const setCookieHeaders = (headers: Headers): readonly string[] =>
  Predicate.isFunction(headers.getSetCookie) ? headers.getSetCookie() : [];

const toSafeIdentity = (email: string, principal: ResolvedPrincipalIdentity): SafeTenantIdentity => ({
  displayName: principal.displayName,
  email,
  principalId: principal.principalId,
  tenantId: principal.tenantId,
});

const isInvalidImpersonationLifecycle = (
  target: ResolvedPrincipalIdentity,
  original: ResolvedPrincipalIdentity,
  lifecycle: SupportImpersonationLifecycle,
): boolean =>
  target.principalId === original.principalId ||
  target.principalId !== lifecycle.targetPrincipalId ||
  original.principalId !== lifecycle.originalPrincipalId ||
  original.authBindingId !== lifecycle.originalAuthBindingId ||
  lifecycle.originalSessionId.length === 0 ||
  lifecycle.reason.trim().length === 0 ||
  lifecycle.reason.length > 500;

const mapApiError = (error: APIError): AuthenticationRuntimeError | undefined => {
  const code =
    Predicate.isObjectKeyword(error.body) && error.body !== null && 'code' in error.body ? error.body.code : undefined;

  if (code === FORBIDDEN_IDENTITY_CODE) {
    return new OntosIdentityForbiddenError();
  }

  if (code === IDENTITY_UNAVAILABLE_CODE) {
    return unavailable('principal_resolver_unavailable');
  }

  if (error.statusCode === 503) {
    return unavailable('auth_api_unavailable');
  }

  if (error.statusCode === 400 || error.statusCode === 401 || error.statusCode === 403) {
    return new InvalidCredentialsError();
  }
  return undefined;
};

const mapKnownRuntimeError = <Failure>(error: Failure): AuthenticationRuntimeError | undefined => {
  if (isAPIError(error)) {
    const known = mapApiError(error);
    if (known !== undefined) {
      return known;
    }
  }

  if (isDatabaseUnavailableFailure(error)) {
    return unavailable('database_unavailable');
  }

  return undefined;
};

const mapRuntimeError = <Failure>(error: Failure): AuthenticationRuntimeError => {
  const knownError = mapKnownRuntimeError(error);
  if (knownError !== undefined) {
    return knownError;
  }

  if (isAPIError(error) && error.statusCode >= 500) {
    return unavailable('auth_api_error');
  }

  return new AuthenticationInternalError();
};

const mapSessionUpdateError = <Failure>(error: Failure): AuthenticationRuntimeError => {
  const knownError = mapKnownRuntimeError(error);
  if (knownError !== undefined) {
    return knownError;
  }

  // Effect.tryPromise treats a catch-mapper throw as a defect. Keep the private rejection intact so
  // the owning HTTP boundary can log its full cause with correlation context before returning 500.
  throw error;
};

const runAuthOperation = <Value>(
  phase: AuthenticationPhase,
  requestHeaders: Headers | undefined,
  operation: PromiseLike<Value>,
) =>
  Effect.tryPromise({
    catch: mapRuntimeError,
    try: Fn.constant(operation),
  }).pipe(withAuthenticationTimeout(phase, requestHeaders));

const runSessionUpdate = <Value>(requestHeaders: Headers, operation: PromiseLike<Value>) =>
  Effect.tryPromise({
    catch: mapSessionUpdateError,
    try: Fn.constant(operation),
  }).pipe(withAuthenticationTimeout('session.update', requestHeaders));

const fallbackClearingCookies = (configuration: AuthConfigValue): readonly string[] => {
  const authCookies = getCookies({
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: configuration.secureCookies,
      },
      useSecureCookies: configuration.secureCookies,
    },
    baseURL: configuration.baseUrl,
  });
  const cookieOptions = {
    httpOnly: true,
    path: '/',
    sameSite: 'lax' as const,
    secure: configuration.secureCookies,
  };
  const sessionTokenExpired = expireCookieUnsafe(emptyCookies, authCookies.sessionToken.name, cookieOptions);
  const sessionDataExpired = expireCookieUnsafe(sessionTokenExpired, authCookies.sessionData.name, cookieOptions);
  const allExpired = expireCookieUnsafe(sessionDataExpired, authCookies.dontRememberToken.name, cookieOptions);
  return toSetCookieHeaders(allExpired);
};

interface AuthenticationAssemblyOptions {
  readonly allowFixtureSignUp?: boolean;
  readonly authDatabase: (typeof AuthDatabase)['Service'];
  readonly oauthHooks: OAuthConnectionHooksContract;
  readonly runResolverEffect: typeof Effect.runPromise;
}

const assembleAuthenticationService = (
  ...[configuration, databaseAdapter, resolver, options]: readonly [
    configuration: AuthConfigValue,
    databaseAdapter: BetterAuthDatabaseAdapter,
    resolver: (typeof PrincipalResolver)['Service'],
    options: AuthenticationAssemblyOptions,
  ]
): AuthenticationServiceContract => {
  const prepareCreatedSession = <Session extends { readonly userId: string }>(session: Session) =>
    resolver.resolveDefaultBetterAuthUser(session.userId).pipe(
      Effect.map((principal) => ({
        data: {
          ...session,
          activeLegalEntityId: null,
          activeTenantId: principal.tenantId,
        },
      })),
      Effect.mapError(mapResolverApiError),
    );
  const beforeSessionCreate = flow(prepareCreatedSession, options.runResolverEffect);
  const oauthHooks = options.oauthHooks;
  const oauthIssuer = oauthIssuerFor(configuration.baseUrl);
  const mcpResourceUrl = mcpResourceUrlOf(configuration.baseUrl);
  const auth = betterAuth({
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: configuration.secureCookies,
      },
      useSecureCookies: configuration.secureCookies,
    },
    basePath: OAUTH_BASE_PATH,
    baseURL: configuration.baseUrl,
    database: databaseAdapter,
    databaseHooks: {
      session: {
        create: {
          before: beforeSessionCreate,
        },
      },
    },
    emailAndPassword: {
      autoSignIn: options.allowFixtureSignUp !== true,
      disableSignUp: options.allowFixtureSignUp !== true,
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
        customAccessTokenClaims: (input) => oauthHooks.customAccessTokenClaims(input),
        grantTypes: ['authorization_code', 'refresh_token'],
        loginPage: OAUTH_LOGIN_PAGE,
        postLogin: {
          consentReferenceId: (context) => oauthHooks.consentReferenceId(context),
          page: OAUTH_CONNECT_PAGE,
          shouldRedirect: (context) => oauthHooks.shouldRedirect(context),
        },
        rateLimit: {
          authorize: { max: 60, window: 60 },
          token: { max: 120, window: 60 },
        },
        refreshTokenExpiresIn: OAUTH_REFRESH_TOKEN_TTL_SECONDS,
        resource: mcpResourceUrl,
        // No allowedScopes on purpose: Better Auth intersects them with the request and would drop offline_access/openid (spike S3).
        resourceSeedMode: 'overwrite',
        resources: [{ accessTokenTtl: OAUTH_ACCESS_TOKEN_TTL_SECONDS, identifier: mcpResourceUrl, name: 'OntOS MCP' }],
        scopes: [...OAUTH_SCOPES],
        validateRedirectUri: validateAuthorizeRedirectUri,
      }),
      // CIMD only (NO-COMPAT): no dynamic client registration; runtime-specific transport enforces the metadata fetch boundary.
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    ],
    secret: configuration.secret,
    session: {
      additionalFields: {
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

  const resolveIdentity = (
    user: {
      readonly email: string;
      readonly id: string;
    },
    tenantId: string,
    sessionId: string,
  ): Effect.Effect<
    {
      readonly identity: SafeTenantIdentity;
      readonly principal: TrustedPrincipalContext;
    },
    AuthenticationUnavailableFailure | OntosIdentityForbiddenFailure
  > =>
    resolver.resolveBetterAuthUserForTenant(user.id, tenantId).pipe(
      Effect.mapError(mapResolverError),
      Effect.flatMap((principal) =>
        decodeTrustedPrincipalContext({
          authBindingId: principal.authBindingId,
          authContextRef: `better-auth-session:${sessionId}`,
          authenticationNamespaceId: resolver.authenticationNamespaceId,
          authMethod: 'session',
          principalId: principal.principalId,
          tenantId: principal.tenantId,
        }).pipe(
          Effect.map((trustedPrincipal) => ({
            identity: toSafeIdentity(user.email, principal),
            principal: trustedPrincipal,
          })),
        ),
      ),
    );

  const resolveDefaultIdentity = (
    user: {
      readonly email: string;
      readonly id: string;
    },
    sessionId: string,
  ): Effect.Effect<
    {
      readonly identity: SafeTenantIdentity;
      readonly principal: TrustedPrincipalContext;
    },
    AuthenticationUnavailableFailure | OntosIdentityForbiddenFailure
  > =>
    resolver.resolveDefaultBetterAuthUser(user.id).pipe(
      Effect.mapError(mapResolverError),
      Effect.flatMap((principal) =>
        decodeTrustedPrincipalContext({
          authBindingId: principal.authBindingId,
          authContextRef: `better-auth-session:${sessionId}`,
          authenticationNamespaceId: resolver.authenticationNamespaceId,
          authMethod: 'session',
          principalId: principal.principalId,
          tenantId: principal.tenantId,
        }).pipe(
          Effect.map((trustedPrincipal) => ({
            identity: toSafeIdentity(user.email, principal),
            principal: trustedPrincipal,
          })),
        ),
      ),
    );

  const resolveImpersonatedIdentity: ResolveImpersonatedIdentity = Effect.fn(
    'AuthenticationService.resolveImpersonatedIdentity',
  )(function* resolveImpersonatedIdentityEffect(
    user: { readonly email: string; readonly id: string },
    originalBetterAuthUserId: string,
    tenantId: string,
    sessionId: string,
    lifecycle: SupportImpersonationLifecycle,
  ) {
    const contextAccess = yield* ContextAccess;
    const target = yield* resolver
      .resolveBetterAuthUserForTenant(user.id, tenantId)
      .pipe(Effect.mapError(mapResolverError));
    const original = yield* resolver
      .resolveBetterAuthUserForTenant(originalBetterAuthUserId, target.tenantId)
      .pipe(Effect.mapError(mapResolverError));
    if (isInvalidImpersonationLifecycle(target, original, lifecycle)) {
      return yield* new OntosIdentityForbiddenError();
    }
    const { verifySupportImpersonationStarted } = resolver;
    if (!Predicate.isFunction(verifySupportImpersonationStarted)) {
      return yield* unavailable('principal_resolver_unavailable');
    }
    const started = yield* verifySupportImpersonationStarted({
      actionId: lifecycle.actionId,
      originalPrincipalId: original.principalId,
      reason: lifecycle.reason,
      sessionId,
      targetPrincipalId: target.principalId,
      tenantId,
    }).pipe(Effect.mapError(mapResolverError));
    if (!started) {
      return yield* new OntosIdentityForbiddenError();
    }
    const [decision] = yield* contextAccess.tenants({
      permission: 'impersonate',
      principalId: original.principalId,
      tenantIds: [tenantId],
    });
    if (decision?.decision === 'denied') {
      return yield* new OntosIdentityForbiddenError();
    }
    if (decision?.decision !== 'allowed') {
      return yield* new AuthenticationUnavailableError();
    }
    const principal = yield* decodeTrustedPrincipalContext({
      authBindingId: target.authBindingId,
      authContextRef: `better-auth-session:${sessionId}`,
      authenticationNamespaceId: resolver.authenticationNamespaceId,
      authMethod: 'support_impersonation',
      impersonatedByPrincipalId: original.principalId,
      principalId: target.principalId,
      tenantId: target.tenantId,
    });
    return {
      identity: { ...toSafeIdentity(user.email, target), impersonating: true },
      principal,
    };
  });

  const getSession = (requestHeaders: Headers) =>
    Effect.suspend(() =>
      runAuthOperation(
        'session.read',
        requestHeaders,
        auth.api.getSession({
          headers: requestHeaders,
          returnHeaders: true,
        }),
      ),
    );

  const readResolvedSession = (requestHeaders: Headers): ResolvedSessionEffect =>
    getSession(requestHeaders).pipe(
      Effect.flatMap((result): ResolvedSessionEffect => {
        if (result.response === null) {
          return Effect.succeed({
            setCookieHeaders: setCookieHeaders(result.headers),
            state: 'anonymous' as const,
          });
        }

        const { response } = result;
        const { activeTenantId: selectedTenantId, impersonatedBy } = response.session;
        if (Predicate.isString(impersonatedBy) && !Predicate.isString(selectedTenantId)) {
          return Effect.fail(new OntosIdentityForbiddenError());
        }
        if (Predicate.isString(selectedTenantId)) {
          const resolvedIdentity = (() => {
            if (!Predicate.isString(impersonatedBy)) {
              return resolveIdentity(response.user, selectedTenantId, response.session.id);
            }
            const actionId = response.session.impersonationActionId;
            const originalAuthBindingId = response.session.impersonationOriginalAuthBindingId;
            const originalPrincipalId = response.session.impersonationOriginalPrincipalId;
            const originalSessionId = response.session.impersonationOriginalSessionId;
            const reason = response.session.impersonationReason;
            const targetPrincipalId = response.session.impersonationTargetPrincipalId;
            if (
              !Predicate.isString(actionId) ||
              !Predicate.isString(originalAuthBindingId) ||
              !Predicate.isString(originalPrincipalId) ||
              !Predicate.isString(originalSessionId) ||
              !Predicate.isString(reason) ||
              !Predicate.isString(targetPrincipalId)
            ) {
              return Effect.fail(new OntosIdentityForbiddenError());
            }
            return resolveImpersonatedIdentity(response.user, impersonatedBy, selectedTenantId, response.session.id, {
              actionId,
              originalAuthBindingId,
              originalPrincipalId,
              originalSessionId,
              reason,
              targetPrincipalId,
            });
          })();
          return resolvedIdentity.pipe(
            observeAuthenticationPhase('session.principal', requestHeaders),
            Effect.map(({ identity, principal }) =>
              withOptionalProperty(
                {
                  identity,
                  principal,
                },
                Predicate.isString(response.session.activeLegalEntityId),
                'savedLegalEntityId',
                response.session.activeLegalEntityId,
                {
                  selectedTenantId,
                  setCookieHeaders: setCookieHeaders(result.headers),
                  state: 'authenticated' as const,
                  userId: response.user.id,
                },
              ),
            ),
          );
        }

        return resolveDefaultIdentity(response.user, response.session.id).pipe(
          observeAuthenticationPhase('session.principal', requestHeaders),
          Effect.flatMap(({ identity, principal }) =>
            Effect.suspend(() =>
              runSessionUpdate(
                requestHeaders,
                auth.api.updateSession({
                  body: { activeTenantId: identity.tenantId },
                  headers: requestHeaders,
                  returnHeaders: true,
                }),
              ),
            ).pipe(
              Effect.map((updated) => ({
                identity,
                principal,
                selectedTenantId: identity.tenantId,
                setCookieHeaders: [...setCookieHeaders(result.headers), ...setCookieHeaders(updated.headers)],
                state: 'authenticated' as const,
                userId: response.user.id,
              })),
            ),
          ),
        );
      }),
    );

  const authenticatedSession = (
    requestHeaders: Headers,
  ): Effect.Effect<AuthenticatedResolvedSession, AuthenticationRuntimeError, ContextAccess> =>
    readResolvedSession(requestHeaders).pipe(
      Effect.filterOrFail(
        (resolved) => resolved.state !== 'anonymous',
        () => new InvalidCredentialsError(),
      ),
    );

  const resolveContext: ResolveAuthenticatedContext = Effect.fn('AuthenticationService.resolveContext')(
    function* resolveContextEffect(resolved: AuthenticatedResolvedSession, requestHeaders: Headers) {
      const selection = yield* resolveAuthorizedLegalEntities(
        withOptionalProperty(
          {
            principalId: resolved.identity.principalId,
          },
          resolved.savedLegalEntityId !== undefined,
          'savedLegalEntityId',
          resolved.savedLegalEntityId,
          {
            tenantId: resolved.identity.tenantId,
          },
        ),
      ).pipe(
        Effect.mapError((selectionFailure) => {
          void selectionFailure;
          return unavailable('legal_entity_selection_unavailable');
        }),
        observeAuthenticationPhase('session.legal-entities', requestHeaders),
      );
      const clearInvalidSavedSelection = Effect.gen(function* clearInvalidSavedSelectionEffect() {
        if (resolved.savedLegalEntityId === undefined) {
          return resolved.setCookieHeaders;
        }
        const updated = yield* Effect.suspend(() =>
          runSessionUpdate(
            requestHeaders,
            auth.api.updateSession({
              body: { activeLegalEntityId: null },
              headers: requestHeaders,
              returnHeaders: true,
            }),
          ),
        );
        return [...resolved.setCookieHeaders, ...setCookieHeaders(updated.headers)];
      });
      if (selection.state === 'access_blocked') {
        return {
          availableLegalEntities: [],
          identity: resolved.identity,
          principal: resolved.principal,
          setCookieHeaders: yield* clearInvalidSavedSelection,
          state: 'access_blocked',
        };
      }
      if (selection.state === 'selection_required') {
        return {
          availableLegalEntities: selection.available,
          identity: resolved.identity,
          principal: resolved.principal,
          setCookieHeaders: yield* clearInvalidSavedSelection,
          state: 'selection_required',
        };
      }
      const identity: SafeAuthenticatedIdentity = {
        ...resolved.identity,
        legalEntityId: selection.selected.legalEntityId,
        legalName: selection.selected.legalName,
      };
      const principal: TrustedPrincipalContext = Object.freeze({
        ...resolved.principal,
        legalEntityId: selection.selected.legalEntityId,
      });
      if (resolved.savedLegalEntityId === selection.selected.legalEntityId) {
        return {
          availableLegalEntities: selection.available,
          identity,
          principal,
          setCookieHeaders: resolved.setCookieHeaders,
          state: 'authenticated',
        };
      }
      const updated = yield* Effect.suspend(() =>
        runSessionUpdate(
          requestHeaders,
          auth.api.updateSession({
            body: { activeLegalEntityId: selection.selected.legalEntityId },
            headers: requestHeaders,
            returnHeaders: true,
          }),
        ),
      );
      return {
        availableLegalEntities: selection.available,
        identity,
        principal,
        setCookieHeaders: [...resolved.setCookieHeaders, ...setCookieHeaders(updated.headers)],
        state: 'authenticated',
      };
    },
  );

  const provisionFixtureUser = (email: string, name: string, authenticationSecret: AuthenticationSecretInput) =>
    options.allowFixtureSignUp === true
      ? Effect.suspend(() =>
          runAuthOperation(
            'fixture.sign-up',
            undefined,
            auth.api.signUpEmail({
              body: {
                email,
                name,
                password: revealAuthenticationSecret(authenticationSecret),
              },
            }),
          ),
        ).pipe(Effect.map((result) => result.user.id))
      : Effect.fail(new AuthenticationInternalError());

  const resolveShellContext: ResolveShellContext = Effect.fn('AuthenticationService.resolveShellContext')(
    function* resolveShellContextEffect(requestHeaders: Headers) {
      const resolved = yield* readResolvedSession(requestHeaders);
      if (resolved.state === 'anonymous') {
        return {
          setCookieHeaders: resolved.setCookieHeaders,
          state: 'anonymous',
        } as const;
      }
      return yield* resolveContext(resolved, requestHeaders);
    },
  );

  return {
    availableTenants: (requestHeaders) =>
      authenticatedSession(requestHeaders).pipe(
        Effect.flatMap((resolved) =>
          resolver.listAvailableTenants(resolved.userId).pipe(
            Effect.map((tenants) => ({
              setCookieHeaders: resolved.setCookieHeaders,
              tenants,
            })),
            Effect.mapError(mapResolverError),
            observeAuthenticationPhase('tenants.list', requestHeaders),
          ),
        ),
      ),
    createFixtureUser: provisionFixtureUser,
    currentSession: (requestHeaders) =>
      readResolvedSession(requestHeaders).pipe(
        Effect.map((resolved): CurrentSessionResult =>
          resolved.state === 'anonymous'
            ? { identity: null, setCookieHeaders: resolved.setCookieHeaders }
            : {
                identity: resolved.identity,
                setCookieHeaders: resolved.setCookieHeaders,
              },
        ),
      ),
    oauth: {
      guards: makeOAuthEndpointGuards({
        database: options.authDatabase,
        readSession: (requestHeaders) =>
          Effect.tryPromise(() => auth.api.getSession({ headers: requestHeaders })).pipe(
            Effect.map((result) =>
              result === null ? undefined : { sessionId: result.session.id, userId: result.user.id },
            ),
            Effect.orElseSucceed(() => undefined),
          ),
      }),
      handler: (request: Request) => auth.handler(request),
      issuer: oauthIssuer,
    },
    resolveShellContext,
    resolveTenantContext: (requestHeaders) =>
      readResolvedSession(requestHeaders).pipe(
        Effect.map((resolved): TenantContextResult =>
          resolved.state === 'anonymous'
            ? {
                setCookieHeaders: resolved.setCookieHeaders,
                state: 'anonymous',
              }
            : {
                identity: resolved.identity,
                principal: resolved.principal,
                setCookieHeaders: resolved.setCookieHeaders,
                state: 'authenticated',
              },
        ),
      ),
    signIn: (email, authenticationSecret, requestHeaders) =>
      Effect.suspend(() =>
        runAuthOperation(
          'sign-in.credentials',
          requestHeaders,
          auth.api.signInEmail({
            body: {
              email,
              password: revealAuthenticationSecret(authenticationSecret),
            },
            headers: requestHeaders,
            returnHeaders: true,
          }),
        ),
      ).pipe(
        Effect.flatMap((result) =>
          resolver.resolveDefaultBetterAuthUser(result.response.user.id).pipe(
            Effect.mapError(mapResolverError),
            observeAuthenticationPhase('sign-in.principal', requestHeaders),
            Effect.map((principal) => ({
              identity: toSafeIdentity(result.response.user.email, principal),
              setCookieHeaders: setCookieHeaders(result.headers),
            })),
          ),
        ),
      ),
    signOut: (requestHeaders) =>
      Effect.suspend(() =>
        runAuthOperation(
          'sign-out',
          requestHeaders,
          auth.api.signOut({
            headers: requestHeaders,
            returnHeaders: true,
          }),
        ),
      ).pipe(
        Effect.map((result) => ({
          setCookieHeaders: [...setCookieHeaders(result.headers), ...fallbackClearingCookies(configuration)],
        })),
        Effect.catchTag('InvalidCredentialsError', () =>
          Effect.succeed({
            setCookieHeaders: fallbackClearingCookies(configuration),
          }),
        ),
      ),
    switchLegalEntity: (legalEntityId, requestHeaders) =>
      authenticatedSession(requestHeaders).pipe(
        Effect.flatMap((resolved) =>
          validateAuthorizedLegalEntity({
            legalEntityId,
            principalId: resolved.identity.principalId,
            tenantId: resolved.identity.tenantId,
          }).pipe(
            Effect.mapError(mapLegalEntitySelectionError),
            observeAuthenticationPhase('legal-entity-switch.validate', requestHeaders),
            Effect.flatMap((selected) =>
              selected.legalEntityId === resolved.savedLegalEntityId
                ? Effect.succeed({
                    selectedLegalEntityId: selected.legalEntityId,
                    setCookieHeaders: resolved.setCookieHeaders,
                  })
                : Effect.suspend(() =>
                    runSessionUpdate(
                      requestHeaders,
                      auth.api.updateSession({
                        body: { activeLegalEntityId: selected.legalEntityId },
                        headers: requestHeaders,
                        returnHeaders: true,
                      }),
                    ),
                  ).pipe(
                    Effect.map((updated) => ({
                      selectedLegalEntityId: selected.legalEntityId,
                      setCookieHeaders: [...resolved.setCookieHeaders, ...setCookieHeaders(updated.headers)],
                    })),
                  ),
            ),
          ),
        ),
      ),
    switchTenant: (tenantId, requestHeaders) =>
      authenticatedSession(requestHeaders).pipe(
        Effect.flatMap((resolved) =>
          resolver.resolveBetterAuthUserForTenant(resolved.userId, tenantId).pipe(
            Effect.mapError(mapTenantSwitchResolverError),
            observeAuthenticationPhase('tenant-switch.principal', requestHeaders),
            Effect.flatMap(() =>
              tenantId === resolved.selectedTenantId
                ? Effect.succeed({
                    selectedTenantId: tenantId,
                    setCookieHeaders: resolved.setCookieHeaders,
                  })
                : Effect.suspend(() =>
                    runSessionUpdate(
                      requestHeaders,
                      auth.api.updateSession({
                        body: {
                          activeLegalEntityId: null,
                          activeTenantId: tenantId,
                        },
                        headers: requestHeaders,
                        returnHeaders: true,
                      }),
                    ),
                  ).pipe(
                    Effect.map((updated) => ({
                      selectedTenantId: tenantId,
                      setCookieHeaders: [...resolved.setCookieHeaders, ...setCookieHeaders(updated.headers)],
                    })),
                  ),
            ),
          ),
        ),
      ),
  };
};

export interface AuthenticationServiceOptions {
  readonly allowFixtureSignUp?: boolean;
}

/**
 * Builds the authentication service from AuthConfig, AuthDatabase, and PrincipalResolver in the
 * caller's Effect context. Better Auth invokes its session hooks as Promises, so the resolver bridge
 * is captured here and never leaves this module.
 */
export const makeAuthenticationService = Effect.fn('AuthenticationService.make')(
  function* makeAuthenticationServiceEffect(options: AuthenticationServiceOptions = {}) {
    const configuration = yield* AuthConfig;
    const database = yield* AuthDatabase;
    const resolver = yield* PrincipalResolver;
    const effectContext = yield* Effect.context();
    const oauthHooks = Option.getOrElse(
      yield* Effect.serviceOption(OAuthConnectionHooks),
      () => stubOAuthConnectionHooks,
    );
    return assembleAuthenticationService(configuration, database.adapter, resolver, {
      ...options,
      authDatabase: database,
      oauthHooks,
      runResolverEffect: Effect.runPromiseWith(effectContext),
    });
  },
);

export const AuthenticationServiceLive = Layer.effect(AuthenticationService, makeAuthenticationService());
