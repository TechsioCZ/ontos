/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then, unicorn/no-useless-undefined -- Better Auth hooks are Promise callbacks while the public service remains Effect-based. */
import type { PrincipalResolverShape, ResolvedPrincipalIdentity } from '@app/core-runtime';
import { PrincipalResolver } from '@app/core-runtime';
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
} from './errors.ts';
import type { AuthenticationRuntimeError } from './errors.ts';

const FORBIDDEN_IDENTITY_CODE = 'ONTOS_IDENTITY_FORBIDDEN';
const IDENTITY_UNAVAILABLE_CODE = 'ONTOS_IDENTITY_UNAVAILABLE';

export interface SafeAuthenticatedIdentity {
  readonly displayName: string;
  readonly email: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface AuthenticationResult {
  readonly identity: SafeAuthenticatedIdentity;
  readonly setCookieHeaders: readonly string[];
}

export interface CurrentSessionResult {
  readonly identity: SafeAuthenticatedIdentity | null;
  readonly setCookieHeaders: readonly string[];
}

export interface SignOutResult {
  readonly setCookieHeaders: readonly string[];
}

export interface AuthenticationServiceShape {
  readonly createFixtureUser: (
    email: string,
    name: string,
    password: string,
  ) => Effect.Effect<string, AuthenticationRuntimeError>;
  readonly currentSession: (
    requestHeaders: Headers,
  ) => Effect.Effect<CurrentSessionResult, AuthenticationRuntimeError>;
  readonly signIn: (
    email: string,
    password: string,
    requestHeaders: Headers,
  ) => Effect.Effect<AuthenticationResult, AuthenticationRuntimeError>;
  readonly signOut: (
    requestHeaders: Headers,
  ) => Effect.Effect<SignOutResult, AuthenticationRuntimeError>;
}

export class AuthenticationService extends Context.Service<
  AuthenticationService,
  AuthenticationServiceShape
>()('@app/shell-super-app/api/auth/service/AuthenticationService') {}

const isTagged = (value: unknown): value is { readonly _tag: string } =>
  typeof value === 'object' && value !== null && '_tag' in value;

const isResolverUnavailable = (error: unknown) =>
  isTagged(error) && error._tag === 'PrincipalResolverUnavailableError';

const resolveForSession = (
  resolver: PrincipalResolverShape,
  betterAuthUserId: string,
): Promise<ResolvedPrincipalIdentity> =>
  Effect.runPromise(resolver.resolveBetterAuthUser(betterAuthUserId)).catch((error: unknown) => {
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
  });

const setCookieHeaders = (headers: Headers): readonly string[] =>
  typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];

const toSafeIdentity = (
  email: string,
  principal: ResolvedPrincipalIdentity,
): SafeAuthenticatedIdentity => ({
  displayName: principal.displayName,
  email,
  principalId: principal.principalId,
  tenantId: principal.tenantId,
});

const mapRuntimeError = (error: unknown): AuthenticationRuntimeError => {
  if (error instanceof APIError) {
    const code =
      typeof error.body === 'object' && error.body !== null && 'code' in error.body
        ? error.body.code
        : undefined;

    if (code === FORBIDDEN_IDENTITY_CODE) {
      return new OntosIdentityForbiddenError();
    }

    if (code === IDENTITY_UNAVAILABLE_CODE || error.statusCode >= 500) {
      return new AuthenticationUnavailableError();
    }

    if (error.statusCode === 400 || error.statusCode === 401 || error.statusCode === 403) {
      return new InvalidCredentialsError();
    }
  }

  return new AuthenticationInternalError();
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
          before: (session) => resolveForSession(resolver, session.userId).then(() => undefined),
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
    trustedOrigins: [...configuration.trustedOrigins],
  });

  const resolveIdentity = (user: {
    readonly email: string;
    readonly id: string;
  }): Effect.Effect<
    SafeAuthenticatedIdentity,
    AuthenticationUnavailableError | OntosIdentityForbiddenError
  > =>
    resolver.resolveBetterAuthUser(user.id).pipe(
      Effect.map((principal) => toSafeIdentity(user.email, principal)),
      Effect.mapError((error) =>
        error._tag === 'PrincipalResolverUnavailableError'
          ? new AuthenticationUnavailableError()
          : new OntosIdentityForbiddenError(),
      ),
    );

  return {
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
      Effect.tryPromise({
        catch: mapRuntimeError,
        try: () =>
          auth.api.getSession({
            headers: requestHeaders,
            returnHeaders: true,
          }),
      }).pipe(
        Effect.flatMap(
          (
            result,
          ): Effect.Effect<
            CurrentSessionResult,
            AuthenticationUnavailableError | OntosIdentityForbiddenError
          > =>
            result.response === null
              ? Effect.succeed<CurrentSessionResult>({
                  identity: null,
                  setCookieHeaders: setCookieHeaders(result.headers),
                })
              : resolveIdentity(result.response.user).pipe(
                  Effect.map(
                    (identity): CurrentSessionResult => ({
                      identity,
                      setCookieHeaders: setCookieHeaders(result.headers),
                    }),
                  ),
                ),
        ),
      ),
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
          resolveIdentity(result.response.user).pipe(
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
  };
};

export const AuthenticationServiceLive = Layer.effect(
  AuthenticationService,
  Effect.gen(function* makeAuthenticationServiceEffect() {
    const configuration = yield* AuthConfig;
    const database = yield* AuthDatabase;
    const resolver = yield* PrincipalResolver;
    return makeAuthenticationService(configuration, database.executor, resolver);
  }),
);
