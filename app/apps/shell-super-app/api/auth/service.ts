/* eslint-disable prefer-destructuring, promise/prefer-await-to-callbacks, promise/prefer-await-to-then, unicorn/no-useless-undefined -- Better Auth hooks are Promise callbacks while the public service remains Effect-based. */
import type {
  AvailableTenant,
  ContextAccessShape,
  LegalEntityContextShape,
  PrincipalResolutionError,
  PrincipalResolverShape,
  ResolvedPrincipalIdentity,
} from '@app/core-runtime';
import { ContextAccess, LegalEntityContext, PrincipalResolver } from '@app/core-runtime';
import { APIError, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { Context, Effect, Layer } from 'effect';
import { AuthConfig } from './config.ts';
import type { AuthConfigValue } from './config.ts';
import { AuthDatabase } from './db/client.ts';
import type { AuthDatabaseExecutor } from './db/types.ts';
import { authDatabaseSchema } from './db/schema.ts';
import {
  AuthenticationInternalError,
  AuthenticationUnavailableError,
  InvalidCredentialsError,
  OntosIdentityForbiddenError,
  TenantAccessForbiddenError,
} from './errors.ts';
import type { AuthenticationRuntimeError, SwitchTenantRuntimeError } from './errors.ts';
import type { LegalEntitySelectionForbiddenError } from './legal-entity-selection.ts';
import {
  LegalEntitySelectionUnavailableError,
  resolveAuthorizedLegalEntities,
  validateAuthorizedLegalEntity,
} from './legal-entity-selection.ts';

const FORBIDDEN_IDENTITY_CODE = 'ONTOS_IDENTITY_FORBIDDEN';
const IDENTITY_UNAVAILABLE_CODE = 'ONTOS_IDENTITY_UNAVAILABLE';

export interface SafeTenantIdentity {
  readonly displayName: string;
  readonly email: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface SafeAuthenticatedIdentity extends SafeTenantIdentity {
  readonly legalEntityId: string;
  readonly legalName: string;
}

export interface AuthenticationResult {
  readonly identity: SafeTenantIdentity;
  readonly setCookieHeaders: readonly string[];
}

export interface CurrentSessionResult {
  readonly identity: SafeTenantIdentity | null;
  readonly setCookieHeaders: readonly string[];
}

export interface SignOutResult {
  readonly setCookieHeaders: readonly string[];
}

export interface AvailableTenantsResult {
  readonly setCookieHeaders: readonly string[];
  readonly tenants: readonly AvailableTenant[];
}

export interface SwitchTenantResult {
  readonly selectedTenantId: string;
  readonly setCookieHeaders: readonly string[];
}

interface AnonymousResolvedSession {
  readonly setCookieHeaders: readonly string[];
  readonly state: 'anonymous';
}

interface AuthenticatedResolvedSession {
  readonly identity: SafeTenantIdentity;
  readonly savedLegalEntityId?: string;
  readonly selectedTenantId: string;
  readonly setCookieHeaders: readonly string[];
  readonly state: 'authenticated';
  readonly userId: string;
}

type ResolvedSession = AnonymousResolvedSession | AuthenticatedResolvedSession;

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
      readonly setCookieHeaders: readonly string[];
      readonly state: 'authenticated';
    }
  | {
      readonly availableLegalEntities: readonly {
        readonly legalEntityId: string;
        readonly legalName: string;
      }[];
      readonly identity: SafeTenantIdentity;
      readonly setCookieHeaders: readonly string[];
      readonly state: 'selection_required';
    }
  | {
      readonly availableLegalEntities: readonly [];
      readonly identity: SafeTenantIdentity;
      readonly setCookieHeaders: readonly string[];
      readonly state: 'access_blocked';
    };

export interface AuthenticationServiceShape {
  readonly availableTenants: (
    requestHeaders: Headers,
  ) => Effect.Effect<AvailableTenantsResult, AuthenticationRuntimeError>;
  readonly createFixtureUser: (
    email: string,
    name: string,
    password: string,
  ) => Effect.Effect<string, AuthenticationRuntimeError>;
  readonly currentSession: (
    requestHeaders: Headers,
  ) => Effect.Effect<CurrentSessionResult, AuthenticationRuntimeError>;
  readonly resolveShellContext: (
    requestHeaders: Headers,
  ) => Effect.Effect<ShellContextResult, AuthenticationRuntimeError>;
  readonly signIn: (
    email: string,
    password: string,
    requestHeaders: Headers,
  ) => Effect.Effect<AuthenticationResult, AuthenticationRuntimeError>;
  readonly signOut: (
    requestHeaders: Headers,
  ) => Effect.Effect<SignOutResult, AuthenticationRuntimeError>;
  readonly switchTenant: (
    tenantId: string,
    requestHeaders: Headers,
  ) => Effect.Effect<SwitchTenantResult, SwitchTenantRuntimeError>;
  readonly switchLegalEntity: (
    legalEntityId: string,
    requestHeaders: Headers,
  ) => Effect.Effect<
    { readonly selectedLegalEntityId: string; readonly setCookieHeaders: readonly string[] },
    AuthenticationRuntimeError | LegalEntitySelectionForbiddenError
  >;
}

export class AuthenticationService extends Context.Service<
  AuthenticationService,
  AuthenticationServiceShape
>()('@app/shell-super-app/api/auth/service/AuthenticationService') {}

const isTagged = (value: unknown): value is { readonly _tag: string } =>
  typeof value === 'object' && value !== null && '_tag' in value;

const isResolverUnavailable = (error: unknown) =>
  isTagged(error) && error._tag === 'PrincipalResolverUnavailableError';

const mapResolverError = (
  error: PrincipalResolutionError,
): AuthenticationUnavailableError | OntosIdentityForbiddenError =>
  error._tag === 'PrincipalResolverUnavailableError'
    ? new AuthenticationUnavailableError()
    : new OntosIdentityForbiddenError();

const resolveForSession = (
  resolver: PrincipalResolverShape,
  betterAuthUserId: string,
): Promise<ResolvedPrincipalIdentity> =>
  Effect.runPromise(resolver.resolveDefaultBetterAuthUser(betterAuthUserId)).catch(
    (error: unknown) => {
      if (isResolverUnavailable(error)) {
        throw new APIError('SERVICE_UNAVAILABLE', {
          code: IDENTITY_UNAVAILABLE_CODE,
          message: 'Authentication is temporarily unavailable',
        });
      }

      throw new APIError('FORBIDDEN', {
        code: FORBIDDEN_IDENTITY_CODE,
        message: 'The authenticated identity cannot access OntOS',
      });
    },
  );

const setCookieHeaders = (headers: Headers): readonly string[] =>
  typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];

const isDatabaseUnavailable = (error: unknown, depth = 0): boolean => {
  if (depth > 3 || typeof error !== 'object' || error === null) {
    return false;
  }

  if ('code' in error) {
    const { code } = error;
    if (
      typeof code === 'string' &&
      (/^(?:08|40|53|55|57|58)/u.test(code) ||
        code === 'ECONNREFUSED' ||
        code === 'ECONNRESET' ||
        code === 'EPIPE' ||
        code === 'ETIMEDOUT')
    ) {
      return true;
    }
  }

  return 'cause' in error && isDatabaseUnavailable(error.cause, depth + 1);
};

const toSafeIdentity = (
  email: string,
  principal: ResolvedPrincipalIdentity,
): SafeTenantIdentity => ({
  displayName: principal.displayName,
  email,
  principalId: principal.principalId,
  tenantId: principal.tenantId,
});

const mapKnownRuntimeError = (error: unknown): AuthenticationRuntimeError | undefined => {
  if (error instanceof APIError) {
    const code =
      typeof error.body === 'object' && error.body !== null && 'code' in error.body
        ? error.body.code
        : undefined;

    if (code === FORBIDDEN_IDENTITY_CODE) {
      return new OntosIdentityForbiddenError();
    }

    if (code === IDENTITY_UNAVAILABLE_CODE || error.statusCode === 503) {
      return new AuthenticationUnavailableError();
    }

    if (error.statusCode === 400 || error.statusCode === 401 || error.statusCode === 403) {
      return new InvalidCredentialsError();
    }
  }

  if (isDatabaseUnavailable(error)) {
    return new AuthenticationUnavailableError();
  }

  return undefined;
};

const mapRuntimeError = (error: unknown): AuthenticationRuntimeError => {
  const knownError = mapKnownRuntimeError(error);
  if (knownError !== undefined) {
    return knownError;
  }

  if (error instanceof APIError && error.statusCode >= 500) {
    return new AuthenticationUnavailableError();
  }

  return new AuthenticationInternalError();
};

const mapSessionUpdateError = (error: unknown): AuthenticationRuntimeError => {
  const knownError = mapKnownRuntimeError(error);
  if (knownError !== undefined) {
    return knownError;
  }

  // Effect.tryPromise treats a catch-mapper throw as a defect. Keep the private rejection intact so
  // the owning HTTP boundary can log its full cause with correlation context before returning 500.
  throw error;
};

const fallbackClearingCookies = (configuration: AuthConfigValue): readonly string[] => {
  const prefix = configuration.secureCookies ? '__Secure-' : '';
  const secure = configuration.secureCookies ? '; Secure' : '';
  const expires = 'Expires=Thu, 01 Jan 1970 00:00:00 GMT';

  return ['session_token', 'session_data', 'dont_remember'].map(
    (suffix) =>
      `${prefix}better-auth.${suffix}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0; ${expires}`,
  );
};

export const makeAuthenticationService = (
  configuration: AuthConfigValue,
  database: AuthDatabaseExecutor,
  resolver: PrincipalResolverShape,
  options: {
    readonly allowFixtureSignUp?: boolean;
    readonly contextAccess?: ContextAccessShape;
    readonly legalEntityContext?: LegalEntityContextShape;
  } = {},
): AuthenticationServiceShape => {
  const auth = betterAuth({
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: configuration.secureCookies,
      },
      useSecureCookies: configuration.secureCookies,
    },
    baseURL: configuration.baseUrl,
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema: authDatabaseSchema,
      transaction: true,
    }),
    databaseHooks: {
      session: {
        create: {
          before: (session) =>
            resolveForSession(resolver, session.userId).then((principal) => ({
              data: {
                ...session,
                activeLegalEntityId: null,
                activeTenantId: principal.tenantId,
              },
            })),
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
  ): Effect.Effect<
    SafeTenantIdentity,
    AuthenticationUnavailableError | OntosIdentityForbiddenError
  > =>
    resolver.resolveBetterAuthUserForTenant(user.id, tenantId).pipe(
      Effect.map((principal) => toSafeIdentity(user.email, principal)),
      Effect.mapError(mapResolverError),
    );

  const resolveDefaultIdentity = (user: {
    readonly email: string;
    readonly id: string;
  }): Effect.Effect<
    SafeTenantIdentity,
    AuthenticationUnavailableError | OntosIdentityForbiddenError
  > =>
    resolver.resolveDefaultBetterAuthUser(user.id).pipe(
      Effect.map((principal) => toSafeIdentity(user.email, principal)),
      Effect.mapError(mapResolverError),
    );

  const getSession = (requestHeaders: Headers) =>
    Effect.tryPromise({
      catch: mapRuntimeError,
      try: () =>
        auth.api.getSession({
          headers: requestHeaders,
          returnHeaders: true,
        }),
    });

  const readResolvedSession = (
    requestHeaders: Headers,
  ): Effect.Effect<ResolvedSession, AuthenticationRuntimeError> =>
    getSession(requestHeaders).pipe(
      Effect.flatMap((result): Effect.Effect<ResolvedSession, AuthenticationRuntimeError> => {
        if (result.response === null) {
          return Effect.succeed({
            setCookieHeaders: setCookieHeaders(result.headers),
            state: 'anonymous' as const,
          });
        }

        const { response } = result;
        const selectedTenantId = response.session.activeTenantId;
        if (typeof selectedTenantId === 'string') {
          return resolveIdentity(response.user, selectedTenantId).pipe(
            Effect.map((identity) => ({
              identity,
              ...(typeof response.session.activeLegalEntityId === 'string'
                ? { savedLegalEntityId: response.session.activeLegalEntityId }
                : {}),
              selectedTenantId,
              setCookieHeaders: setCookieHeaders(result.headers),
              state: 'authenticated' as const,
              userId: response.user.id,
            })),
          );
        }

        return resolveDefaultIdentity(response.user).pipe(
          Effect.flatMap((identity) =>
            Effect.tryPromise({
              catch: mapSessionUpdateError,
              try: () =>
                auth.api.updateSession({
                  body: { activeTenantId: identity.tenantId },
                  headers: requestHeaders,
                  returnHeaders: true,
                }),
            }).pipe(
              Effect.map((updated) => ({
                identity,
                selectedTenantId: identity.tenantId,
                setCookieHeaders: [
                  ...setCookieHeaders(result.headers),
                  ...setCookieHeaders(updated.headers),
                ],
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
  ): Effect.Effect<AuthenticatedResolvedSession, AuthenticationRuntimeError> =>
    readResolvedSession(requestHeaders).pipe(
      Effect.flatMap((resolved) =>
        resolved.state === 'anonymous'
          ? Effect.fail(new InvalidCredentialsError())
          : Effect.succeed(resolved),
      ),
    );

  const resolveContext = (
    resolved: AuthenticatedResolvedSession,
    requestHeaders: Headers,
  ): Effect.Effect<
    Exclude<ShellContextResult, { readonly state: 'anonymous' }>,
    AuthenticationRuntimeError
  > =>
    Effect.gen(function* resolveContextEffect() {
      const { legalEntityContext } = options;
      const { contextAccess } = options;
      if (legalEntityContext === undefined || contextAccess === undefined) {
        return yield* new AuthenticationUnavailableError();
      }
      const selection = yield* resolveAuthorizedLegalEntities(legalEntityContext, contextAccess, {
        principalId: resolved.identity.principalId,
        ...(resolved.savedLegalEntityId === undefined
          ? {}
          : { savedLegalEntityId: resolved.savedLegalEntityId }),
        tenantId: resolved.identity.tenantId,
      }).pipe(Effect.mapError(() => new AuthenticationUnavailableError()));
      const clearInvalidSavedSelection = Effect.gen(function* clearInvalidSavedSelectionEffect() {
        if (resolved.savedLegalEntityId === undefined) {
          return resolved.setCookieHeaders;
        }
        const updated = yield* Effect.tryPromise({
          catch: mapSessionUpdateError,
          try: () =>
            auth.api.updateSession({
              body: { activeLegalEntityId: null },
              headers: requestHeaders,
              returnHeaders: true,
            }),
        });
        return [...resolved.setCookieHeaders, ...setCookieHeaders(updated.headers)];
      });
      if (selection.state === 'access_blocked') {
        return {
          availableLegalEntities: [],
          identity: resolved.identity,
          setCookieHeaders: yield* clearInvalidSavedSelection,
          state: 'access_blocked',
        };
      }
      if (selection.state === 'selection_required') {
        return {
          availableLegalEntities: selection.available,
          identity: resolved.identity,
          setCookieHeaders: yield* clearInvalidSavedSelection,
          state: 'selection_required',
        };
      }
      const identity: SafeAuthenticatedIdentity = {
        ...resolved.identity,
        legalEntityId: selection.selected.legalEntityId,
        legalName: selection.selected.legalName,
      };
      if (resolved.savedLegalEntityId === selection.selected.legalEntityId) {
        return {
          availableLegalEntities: selection.available,
          identity,
          setCookieHeaders: resolved.setCookieHeaders,
          state: 'authenticated',
        };
      }
      const updated = yield* Effect.tryPromise({
        catch: mapSessionUpdateError,
        try: () =>
          auth.api.updateSession({
            body: { activeLegalEntityId: selection.selected.legalEntityId },
            headers: requestHeaders,
            returnHeaders: true,
          }),
      });
      return {
        availableLegalEntities: selection.available,
        identity,
        setCookieHeaders: [...resolved.setCookieHeaders, ...setCookieHeaders(updated.headers)],
        state: 'authenticated',
      };
    });

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
          ),
        ),
      ),
    createFixtureUser: (email, name, password) =>
      options.allowFixtureSignUp === true
        ? Effect.tryPromise({
            catch: mapRuntimeError,
            try: () =>
              auth.api.signUpEmail({
                body: {
                  email,
                  name,
                  password,
                },
              }),
          }).pipe(Effect.map((result) => result.user.id))
        : Effect.fail(new AuthenticationInternalError()),
    currentSession: (requestHeaders) =>
      readResolvedSession(requestHeaders).pipe(
        Effect.map(
          (resolved): CurrentSessionResult =>
            resolved.state === 'anonymous'
              ? { identity: null, setCookieHeaders: resolved.setCookieHeaders }
              : {
                  identity: resolved.identity,
                  setCookieHeaders: resolved.setCookieHeaders,
                },
        ),
      ),
    resolveShellContext: (requestHeaders) =>
      Effect.gen(function* resolveShellContextEffect() {
        const resolved = yield* readResolvedSession(requestHeaders);
        if (resolved.state === 'anonymous') {
          return {
            setCookieHeaders: resolved.setCookieHeaders,
            state: 'anonymous',
          } as const;
        }
        return yield* resolveContext(resolved, requestHeaders);
      }),
    signIn: (email, password, requestHeaders) =>
      Effect.tryPromise({
        catch: mapRuntimeError,
        try: () =>
          auth.api.signInEmail({
            body: {
              email,
              password,
            },
            headers: requestHeaders,
            returnHeaders: true,
          }),
      }).pipe(
        Effect.flatMap((result) =>
          resolveDefaultIdentity(result.response.user).pipe(
            Effect.map((identity) => ({
              identity,
              setCookieHeaders: setCookieHeaders(result.headers),
            })),
          ),
        ),
      ),
    signOut: (requestHeaders) =>
      Effect.tryPromise({
        catch: mapRuntimeError,
        try: () =>
          auth.api.signOut({
            headers: requestHeaders,
            returnHeaders: true,
          }),
      }).pipe(
        Effect.map((result) => ({
          setCookieHeaders: [
            ...setCookieHeaders(result.headers),
            ...fallbackClearingCookies(configuration),
          ],
        })),
        Effect.catchTag('InvalidCredentialsError', () =>
          Effect.succeed({
            setCookieHeaders: fallbackClearingCookies(configuration),
          }),
        ),
      ),
    switchLegalEntity: (legalEntityId, requestHeaders) =>
      authenticatedSession(requestHeaders).pipe(
        Effect.flatMap((resolved) => {
          const legalEntityContext = options.legalEntityContext;
          const contextAccess = options.contextAccess;
          if (legalEntityContext === undefined || contextAccess === undefined) {
            return Effect.fail(new AuthenticationUnavailableError());
          }
          return validateAuthorizedLegalEntity(legalEntityContext, contextAccess, {
            legalEntityId,
            principalId: resolved.identity.principalId,
            tenantId: resolved.identity.tenantId,
          }).pipe(
            Effect.mapError((error) =>
              error instanceof LegalEntitySelectionUnavailableError
                ? new AuthenticationUnavailableError()
                : error,
            ),
            Effect.flatMap((selected) =>
              selected.legalEntityId === resolved.savedLegalEntityId
                ? Effect.succeed({
                    selectedLegalEntityId: selected.legalEntityId,
                    setCookieHeaders: resolved.setCookieHeaders,
                  })
                : Effect.tryPromise({
                    catch: mapSessionUpdateError,
                    try: () =>
                      auth.api.updateSession({
                        body: { activeLegalEntityId: selected.legalEntityId },
                        headers: requestHeaders,
                        returnHeaders: true,
                      }),
                  }).pipe(
                    Effect.map((updated) => ({
                      selectedLegalEntityId: selected.legalEntityId,
                      setCookieHeaders: [
                        ...resolved.setCookieHeaders,
                        ...setCookieHeaders(updated.headers),
                      ],
                    })),
                  ),
            ),
          );
        }),
      ),
    switchTenant: (tenantId, requestHeaders) =>
      authenticatedSession(requestHeaders).pipe(
        Effect.flatMap((resolved) =>
          resolver.resolveBetterAuthUserForTenant(resolved.userId, tenantId).pipe(
            Effect.mapError((error: PrincipalResolutionError) =>
              error._tag === 'PrincipalResolverUnavailableError'
                ? new AuthenticationUnavailableError()
                : new TenantAccessForbiddenError(),
            ),
            Effect.flatMap(() =>
              tenantId === resolved.selectedTenantId
                ? Effect.succeed({
                    selectedTenantId: tenantId,
                    setCookieHeaders: resolved.setCookieHeaders,
                  })
                : Effect.tryPromise({
                    catch: mapSessionUpdateError,
                    try: () =>
                      auth.api.updateSession({
                        body: { activeLegalEntityId: null, activeTenantId: tenantId },
                        headers: requestHeaders,
                        returnHeaders: true,
                      }),
                  }).pipe(
                    Effect.map((updated) => ({
                      selectedTenantId: tenantId,
                      setCookieHeaders: [
                        ...resolved.setCookieHeaders,
                        ...setCookieHeaders(updated.headers),
                      ],
                    })),
                  ),
            ),
          ),
        ),
      ),
  };
};

export const AuthenticationServiceLive = Layer.effect(
  AuthenticationService,
  Effect.gen(function* makeAuthenticationServiceEffect() {
    const configuration = yield* AuthConfig;
    const database = yield* AuthDatabase;
    const resolver = yield* PrincipalResolver;
    const legalEntityContext = yield* LegalEntityContext;
    const contextAccess = yield* ContextAccess;
    return makeAuthenticationService(configuration, database.executor, resolver, {
      contextAccess,
      legalEntityContext,
    });
  }),
);
