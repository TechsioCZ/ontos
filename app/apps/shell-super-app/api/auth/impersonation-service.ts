// @effect-diagnostics asyncFunction:off globalDateInEffect:off
/* eslint-disable max-classes-per-file, promise/prefer-await-to-callbacks, promise/prefer-await-to-then, unicorn/no-array-method-this-argument -- Support impersonation orchestration and typed Effect failures share one Auth service boundary. */
import type {
  ActionRuntimeService,
  PrincipalResolverService,
  SupportRecoveryPrincipalContextResolverService,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import {
  ActionRuntime,
  PrincipalResolver,
  recordSupportImpersonationAction,
  SupportRecoveryPrincipalContextResolver,
} from '@app/core-runtime';
import { APIError, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { parseCookies } from 'better-auth/cookies';
import { constantTimeEqual, makeSignature } from 'better-auth/crypto';
import { admin } from 'better-auth/plugins';
import { asc, eq } from 'drizzle-orm';
import { Clock, Context, Effect, Layer, Schema, Predicate } from 'effect';
import { AuthConfig } from './config.ts';
import type { AuthConfigValue } from './config.ts';
import { AuthDatabase } from './db/client.ts';
import { authDatabaseSchema, session, supportImpersonationRecovery } from './db/schema.ts';
import type { AuthDatabaseExecutor } from './db/types.ts';
import { AuthenticationService } from './service.ts';
import type { AuthenticationServiceContract } from './service.ts';

export class SupportImpersonationDeniedError extends Schema.TaggedErrorClass<SupportImpersonationDeniedError>()(
  'SupportImpersonationDeniedError',
  { code: Schema.Literal('support_impersonation_denied'), reason: Schema.String },
) {}
export class SupportImpersonationUnavailableError extends Schema.TaggedErrorClass<SupportImpersonationUnavailableError>()(
  'SupportImpersonationUnavailableError',
  { code: Schema.Literal('support_impersonation_unavailable'), reason: Schema.String },
) {}
export type SupportImpersonationError =
  | SupportImpersonationDeniedError
  | SupportImpersonationUnavailableError;
const denied = () =>
  new SupportImpersonationDeniedError({
    code: 'support_impersonation_denied',
    reason: 'Support impersonation is not permitted',
  });
const unavailable = () =>
  new SupportImpersonationUnavailableError({
    code: 'support_impersonation_unavailable',
    reason: 'Support impersonation is temporarily unavailable',
  });
const cookieHeaders = (headers: Headers): readonly string[] =>
  Predicate.isFunction(headers.getSetCookie) ? headers.getSetCookie() : [];
const mapAuthenticationError = (error: { readonly _tag?: string }) =>
  error._tag === 'AuthenticationUnavailableError' || error._tag === 'AuthenticationInternalError'
    ? unavailable()
    : denied();
const mapResolverError = (error: { readonly _tag?: string }) =>
  error._tag === 'PrincipalResolverUnavailableError' ? unavailable() : denied();
const mapProviderError = <Failure>(error: Failure) =>
  error instanceof APIError && error.statusCode < 500 ? denied() : unavailable();

export interface SupportProviderSession {
  readonly activeTenantId?: null | string;
  readonly id: string;
  readonly impersonatedBy?: null | string;
  readonly impersonationActionId?: null | string;
  readonly impersonationOriginalAuthBindingId?: null | string;
  readonly impersonationOriginalPrincipalId?: null | string;
  readonly impersonationOriginalSessionId?: null | string;
  readonly impersonationReason?: null | string;
  readonly impersonationTargetPrincipalId?: null | string;
}
export type SupportRecoveryRecord = Omit<
  typeof supportImpersonationRecovery.$inferSelect,
  'createdAt'
>;
interface SupportProviderUser {
  readonly id: string;
}
export interface SupportAuthProvider {
  readonly api: {
    readonly getSession: (input: {
      readonly headers: Headers;
      readonly returnHeaders: true;
    }) => Promise<{
      readonly headers: Headers;
      readonly response: null | {
        readonly session: SupportProviderSession;
        readonly user: SupportProviderUser;
      };
    }>;
    readonly impersonateUser: (input: {
      readonly body: { readonly userId: string };
      readonly headers: Headers;
      readonly returnHeaders: true;
    }) => Promise<{
      readonly headers: Headers;
      readonly response: { readonly session: SupportProviderSession };
    }>;
    readonly stopImpersonating: (input: {
      readonly headers: Headers;
      readonly returnHeaders: true;
    }) => Promise<{
      readonly headers: Headers;
      readonly response: { readonly session: SupportProviderSession };
    }>;
  };
}

export interface SupportImpersonationStore {
  readonly deleteRecovery: (impersonationSessionId: string) => Promise<void>;
  readonly deleteSession: (sessionId: string) => Promise<void>;
  readonly insertRecovery: (recovery: SupportRecoveryRecord) => Promise<void>;
  readonly loadExpiredRecovery: (
    sessionToken: string,
  ) => Promise<SupportRecoveryRecord | undefined>;
  readonly loadOriginalSession: (
    sessionToken: string,
  ) => Promise<{ readonly expiresAt: Date; readonly id: string } | undefined>;
  readonly loadRecoveries: (originalSessionId: string) => Promise<readonly SupportRecoveryRecord[]>;
  readonly updateImpersonationSession: (
    sessionId: string,
    metadata: {
      readonly actionId: string;
      readonly originalAuthBindingId: string;
      readonly originalPrincipalId: string;
      readonly originalSessionId: string;
      readonly reason: string;
      readonly targetPrincipalId: string;
      readonly tenantId: string;
    },
  ) => Promise<void>;
}

const makeSupportAuthProvider = (
  configuration: AuthConfigValue,
  database: AuthDatabaseExecutor,
): SupportAuthProvider =>
  betterAuth({
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
    logger: { disabled: true },
    plugins: [
      admin({
        adminUserIds: [...configuration.supportUserIds],
        allowImpersonatingAdmins: false,
      }),
    ],
    secret: configuration.secret,
    session: {
      additionalFields: {
        activeLegalEntityId: { input: true, required: false, type: 'string' },
        activeTenantId: { input: true, required: false, type: 'string' },
        impersonationActionId: { input: false, required: false, type: 'string' },
        impersonationOriginalAuthBindingId: { input: false, required: false, type: 'string' },
        impersonationOriginalPrincipalId: { input: false, required: false, type: 'string' },
        impersonationOriginalSessionId: { input: false, required: false, type: 'string' },
        impersonationReason: { input: false, required: false, type: 'string' },
        impersonationTargetPrincipalId: { input: false, required: false, type: 'string' },
      },
    },
    trustedOrigins: [...configuration.trustedOrigins],
  }) satisfies SupportAuthProvider;

const makeSupportImpersonationStore = (
  database: AuthDatabaseExecutor,
): SupportImpersonationStore => ({
  deleteRecovery: async (impersonationSessionId) => {
    await database
      .delete(supportImpersonationRecovery)
      .where(eq(supportImpersonationRecovery.impersonationSessionId, impersonationSessionId));
  },
  deleteSession: async (sessionId) => {
    await database.delete(session).where(eq(session.id, sessionId));
  },
  insertRecovery: async (recovery) => {
    await database.insert(supportImpersonationRecovery).values(recovery).onConflictDoNothing();
  },
  loadExpiredRecovery: async (sessionToken) => {
    const [loaded] = await database
      .select({
        actionId: session.impersonationActionId,
        impersonatedBy: session.impersonatedBy,
        impersonationSessionId: session.id,
        originalAuthBindingId: session.impersonationOriginalAuthBindingId,
        originalPrincipalId: session.impersonationOriginalPrincipalId,
        originalSessionId: session.impersonationOriginalSessionId,
        reason: session.impersonationReason,
        targetPrincipalId: session.impersonationTargetPrincipalId,
        tenantId: session.activeTenantId,
      })
      .from(session)
      .where(eq(session.token, sessionToken))
      .limit(1);
    if (
      loaded === undefined ||
      !Predicate.isString(loaded.impersonatedBy) ||
      !Predicate.isString(loaded.actionId) ||
      !Predicate.isString(loaded.originalAuthBindingId) ||
      !Predicate.isString(loaded.originalPrincipalId) ||
      !Predicate.isString(loaded.originalSessionId) ||
      !Predicate.isString(loaded.reason) ||
      !Predicate.isString(loaded.targetPrincipalId) ||
      !Predicate.isString(loaded.tenantId)
    ) {
      return;
    }
    return {
      actionId: loaded.actionId,
      impersonationSessionId: loaded.impersonationSessionId,
      originalAuthBindingId: loaded.originalAuthBindingId,
      originalPrincipalId: loaded.originalPrincipalId,
      originalSessionId: loaded.originalSessionId,
      reason: loaded.reason,
      targetPrincipalId: loaded.targetPrincipalId,
      tenantId: loaded.tenantId,
    };
  },
  loadOriginalSession: async (sessionToken) => {
    const [loaded] = await database
      .select({ expiresAt: session.expiresAt, id: session.id })
      .from(session)
      .where(eq(session.token, sessionToken))
      .limit(1);
    return loaded;
  },
  loadRecoveries: (originalSessionId) =>
    database
      .select()
      .from(supportImpersonationRecovery)
      .where(eq(supportImpersonationRecovery.originalSessionId, originalSessionId))
      .orderBy(asc(supportImpersonationRecovery.createdAt)),
  updateImpersonationSession: async (sessionId, metadata) => {
    await database
      .update(session)
      .set({
        activeLegalEntityId: null,
        activeTenantId: metadata.tenantId,
        impersonationActionId: metadata.actionId,
        impersonationOriginalAuthBindingId: metadata.originalAuthBindingId,
        impersonationOriginalPrincipalId: metadata.originalPrincipalId,
        impersonationOriginalSessionId: metadata.originalSessionId,
        impersonationReason: metadata.reason,
        impersonationTargetPrincipalId: metadata.targetPrincipalId,
      })
      .where(eq(session.id, sessionId));
  },
});

const authCookieName = (configuration: AuthConfigValue, suffix: string): string =>
  `${configuration.secureCookies ? '__Secure-' : ''}better-auth.${suffix}`;
const cookieAttributes = (configuration: AuthConfigValue): string =>
  `Path=/; HttpOnly; SameSite=Lax${configuration.secureCookies ? '; Secure' : ''}`;
const clearAuthCookies = (configuration: AuthConfigValue): readonly string[] =>
  ['session_token', 'session_data', 'admin_session', 'dont_remember'].map(
    (suffix) =>
      `${authCookieName(configuration, suffix)}=; ${cookieAttributes(configuration)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  );
const decodeSignedCookie = async (
  requestHeaders: Headers,
  cookieName: string,
  secret: string,
): Promise<string | undefined> => {
  const encoded = parseCookies(requestHeaders.get('cookie') ?? '').get(cookieName);
  if (encoded === undefined) {
    return undefined;
  }
  const separator = encoded.lastIndexOf('.');
  if (separator <= 0) {
    return undefined;
  }
  const value = encoded.slice(0, separator);
  const signature = encoded.slice(separator + 1);
  const expected = await makeSignature(value, secret);
  return constantTimeEqual(signature, expected) ? value : undefined;
};
const encodeSignedCookie = async (value: string, secret: string): Promise<string> =>
  encodeURIComponent(`${value}.${await makeSignature(value, secret)}`);

export interface SupportImpersonationDependencies {
  readonly actionRuntime: ActionRuntimeService;
  readonly authentication: AuthenticationServiceContract;
  readonly configuration: AuthConfigValue;
  readonly database?: AuthDatabaseExecutor;
  readonly provider?: SupportAuthProvider;
  readonly resolver: PrincipalResolverService;
  readonly store?: SupportImpersonationStore;
  readonly supportRecoveryPrincipal: SupportRecoveryPrincipalContextResolverService;
}

export const makeSupportImpersonationService = (dependencies: SupportImpersonationDependencies) => {
  const { database } = dependencies;
  const auth =
    dependencies.provider ??
    (database === undefined
      ? (() => {
          throw new Error('Support impersonation requires a provider or database');
        })()
      : makeSupportAuthProvider(dependencies.configuration, database));
  const store =
    dependencies.store ??
    (database === undefined
      ? (() => {
          throw new Error('Support impersonation requires a store or database');
        })()
      : makeSupportImpersonationStore(database));
  const checkpoint = (input: {
    readonly correlationId: string;
    readonly idempotencyKey: string;
    readonly principal: TrustedPrincipalContext;
    readonly payload: unknown;
  }) =>
    dependencies.actionRuntime
      .runAction({
        payload: input.payload,
        principal: input.principal,
        registration: recordSupportImpersonationAction,
        transport: { correlationId: input.correlationId, idempotencyKey: input.idempotencyKey },
      })
      .pipe(Effect.asVoid);
  const loadRecoveries = (originalSessionId: string) =>
    Effect.tryPromise({
      catch: unavailable,
      try: () => store.loadRecoveries(originalSessionId),
    });
  const loadExpiredImpersonationRecovery = (requestHeaders: Headers) =>
    Effect.gen(function* loadExpiredSupportImpersonation() {
      const sessionToken = yield* Effect.tryPromise({
        catch: unavailable,
        try: () =>
          decodeSignedCookie(
            requestHeaders,
            authCookieName(dependencies.configuration, 'session_token'),
            dependencies.configuration.secret,
          ),
      });
      if (sessionToken === undefined) {
        return;
      }
      return yield* Effect.tryPromise({
        catch: unavailable,
        try: () => store.loadExpiredRecovery(sessionToken),
      });
    });
  const recoverOriginalSession = (requestHeaders: Headers) =>
    Effect.gen(function* recoverOriginalSupportSession() {
      const adminCookieName = authCookieName(dependencies.configuration, 'admin_session');
      const hasAdminCookie = parseCookies(requestHeaders.get('cookie') ?? '').has(adminCookieName);
      if (!hasAdminCookie) {
        return { state: 'absent' as const };
      }
      const signedValue = yield* Effect.tryPromise({
        catch: unavailable,
        try: () =>
          decodeSignedCookie(requestHeaders, adminCookieName, dependencies.configuration.secret),
      });
      const [originalSessionToken, dontRememberFlag] = signedValue?.split(':') ?? [];
      if (originalSessionToken === undefined || originalSessionToken.length === 0) {
        return { state: 'invalid' as const };
      }
      const original = yield* Effect.tryPromise({
        catch: unavailable,
        try: () => store.loadOriginalSession(originalSessionToken),
      });
      const nowEpochMillis = yield* Clock.currentTimeMillis;
      if (original === undefined) {
        return { state: 'invalid' as const };
      }
      if (original.expiresAt.getTime() <= nowEpochMillis) {
        return {
          originalSessionId: original.id,
          setCookieHeaders: clearAuthCookies(dependencies.configuration),
          state: 'expired' as const,
        };
      }
      const sessionCookie = yield* Effect.tryPromise({
        catch: unavailable,
        try: () => encodeSignedCookie(originalSessionToken, dependencies.configuration.secret),
      });
      const maxAge = Math.max(
        0,
        Math.floor((original.expiresAt.getTime() - nowEpochMillis) / 1000),
      );
      const persistence =
        dontRememberFlag === undefined || dontRememberFlag.length === 0
          ? `; Max-Age=${maxAge}`
          : '';
      const restoredCookie = `${authCookieName(
        dependencies.configuration,
        'session_token',
      )}=${sessionCookie}; ${cookieAttributes(dependencies.configuration)}${persistence}`;
      const dontRememberCookie =
        dontRememberFlag === undefined || dontRememberFlag.length === 0
          ? undefined
          : `${authCookieName(dependencies.configuration, 'dont_remember')}=${yield* Effect.tryPromise(
              {
                catch: unavailable,
                try: () => encodeSignedCookie('true', dependencies.configuration.secret),
              },
            )}; ${cookieAttributes(dependencies.configuration)}`;
      return {
        originalSessionId: original.id,
        setCookieHeaders: [
          restoredCookie,
          ...(dontRememberCookie === undefined ? [] : [dontRememberCookie]),
          ...clearAuthCookies(dependencies.configuration).filter(
            (header) =>
              !header.startsWith(
                `${authCookieName(dependencies.configuration, 'session_token')}=`,
              ) &&
              (dontRememberCookie === undefined ||
                !header.startsWith(
                  `${authCookieName(dependencies.configuration, 'dont_remember')}=`,
                )),
          ),
        ],
        state: 'restored' as const,
      };
    });
  const terminateImpersonationSession = (impersonationSessionId: string) =>
    Effect.tryPromise({
      catch: unavailable,
      try: () => store.deleteSession(impersonationSessionId),
    });
  const completeRecovery = (input: {
    readonly correlationId: string;
    readonly recovery: SupportRecoveryRecord;
    readonly restoredSessionId: string;
    readonly sessionTerminated: boolean;
    readonly setCookieHeaders: readonly string[];
  }) =>
    Effect.gen(function* completeImpersonationRecovery() {
      if (!input.sessionTerminated) {
        const terminationExit = yield* Effect.exit(
          terminateImpersonationSession(input.recovery.impersonationSessionId),
        );
        if (terminationExit._tag === 'Failure') {
          return {
            active: false as const,
            checkpointPending: true as const,
            setCookieHeaders: input.setCookieHeaders,
          };
        }
      }
      const originalPrincipalExit = yield* Effect.exit(
        dependencies.supportRecoveryPrincipal.resolveStoppedImpersonation({
          originalAuthBindingId: input.recovery.originalAuthBindingId,
          originalPrincipalId: input.recovery.originalPrincipalId,
          originalSessionId: input.restoredSessionId,
          tenantId: input.recovery.tenantId,
        }),
      );
      if (originalPrincipalExit._tag === 'Failure') {
        return {
          active: false as const,
          checkpointPending: true as const,
          setCookieHeaders: input.setCookieHeaders,
        };
      }
      const originalPrincipal = originalPrincipalExit.value;
      const checkpointExit = yield* Effect.exit(
        checkpoint({
          correlationId: input.correlationId,
          idempotencyKey: `${input.recovery.actionId}:stopped`,
          payload: {
            checkpoint: 'stopped',
            originalPrincipalId: input.recovery.originalPrincipalId,
            reason: input.recovery.reason,
            sessionRef: `better-auth-session:${input.recovery.impersonationSessionId}`,
            targetPrincipalId: input.recovery.targetPrincipalId,
          },
          principal: originalPrincipal,
        }).pipe(
          Effect.catch((error) =>
            error._tag === 'ActionAlreadyCommitted' ? Effect.void : Effect.fail(error),
          ),
        ),
      );
      if (checkpointExit._tag === 'Failure') {
        return {
          active: false as const,
          checkpointPending: true as const,
          setCookieHeaders: input.setCookieHeaders,
        };
      }
      const cleanupExit = yield* Effect.exit(
        Effect.tryPromise({
          catch: unavailable,
          try: () => store.deleteRecovery(input.recovery.impersonationSessionId),
        }),
      );
      return {
        active: false as const,
        checkpointPending: cleanupExit._tag === 'Failure',
        setCookieHeaders: input.setCookieHeaders,
      };
    });
  return Object.freeze({
    start: (input: {
      readonly correlationId: string;
      readonly idempotencyKey: string;
      readonly reason: string;
      readonly requestHeaders: Headers;
      readonly targetPrincipalId: string;
    }) =>
      Effect.gen(function* startImpersonation() {
        const reason = input.reason.trim();
        if (reason.length < 1 || reason.length > 500) {
          return yield* denied();
        }
        const shell = yield* dependencies.authentication
          .resolveTenantContext(input.requestHeaders)
          .pipe(Effect.mapError(mapAuthenticationError));
        if (
          shell.state !== 'authenticated' ||
          shell.principal.authMethod !== 'session' ||
          !Predicate.isString(shell.principal.authBindingId) ||
          !Predicate.isString(shell.principal.authContextRef) ||
          !shell.principal.authContextRef.startsWith('better-auth-session:') ||
          shell.principal.principalId === input.targetPrincipalId
        ) {
          return yield* denied();
        }
        const originalSessionId = shell.principal.authContextRef.slice(
          'better-auth-session:'.length,
        );
        const originalAuthBindingId = shell.principal.authBindingId;
        if (originalSessionId.length === 0) {
          return yield* denied();
        }
        const targetUserId = yield* dependencies.resolver
          .resolveBetterAuthUserForPrincipal({
            principalId: input.targetPrincipalId,
            tenantId: shell.principal.tenantId,
          })
          .pipe(Effect.mapError(mapResolverError));
        yield* checkpoint({
          correlationId: input.correlationId,
          idempotencyKey: `${input.idempotencyKey}:requested`,
          payload: {
            checkpoint: 'requested',
            originalPrincipalId: shell.principal.principalId,
            reason,
            targetPrincipalId: input.targetPrincipalId,
          },
          principal: shell.principal,
        });
        const created = yield* Effect.tryPromise({
          catch: mapProviderError,
          try: () =>
            auth.api.impersonateUser({
              body: { userId: targetUserId },
              headers: input.requestHeaders,
              returnHeaders: true,
            }),
        });
        yield* Effect.tryPromise({
          catch: unavailable,
          try: () =>
            store.updateImpersonationSession(created.response.session.id, {
              actionId: input.idempotencyKey,
              originalAuthBindingId,
              originalPrincipalId: shell.principal.principalId,
              originalSessionId,
              reason,
              targetPrincipalId: input.targetPrincipalId,
              tenantId: shell.principal.tenantId,
            }),
        }).pipe(
          Effect.catch((error) =>
            Effect.tryPromise({
              catch: () => error,
              try: () => store.deleteSession(created.response.session.id),
            }).pipe(Effect.andThen(Effect.fail(error))),
          ),
        );
        const recovery = {
          actionId: input.idempotencyKey,
          impersonationSessionId: created.response.session.id,
          originalAuthBindingId,
          originalPrincipalId: shell.principal.principalId,
          originalSessionId,
          reason,
          targetPrincipalId: input.targetPrincipalId,
          tenantId: shell.principal.tenantId,
        } satisfies SupportRecoveryRecord;
        yield* Effect.tryPromise({
          catch: unavailable,
          try: () => store.insertRecovery(recovery),
        }).pipe(
          Effect.catch((error) =>
            terminateImpersonationSession(created.response.session.id).pipe(
              Effect.ignore,
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
        const started = checkpoint({
          correlationId: input.correlationId,
          idempotencyKey: `${input.idempotencyKey}:started`,
          payload: {
            checkpoint: 'started',
            originalPrincipalId: shell.principal.principalId,
            reason,
            sessionRef: `better-auth-session:${created.response.session.id}`,
            targetPrincipalId: input.targetPrincipalId,
          },
          principal: shell.principal,
        });
        yield* started.pipe(
          Effect.catch((error) =>
            Effect.all(
              [
                terminateImpersonationSession(created.response.session.id),
                Effect.tryPromise({
                  catch: () => null,
                  try: () => store.deleteRecovery(created.response.session.id),
                }),
              ],
              { discard: true },
            ).pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
          ),
        );
        return {
          active: true as const,
          setCookieHeaders: cookieHeaders(created.headers),
          targetPrincipalId: input.targetPrincipalId,
        };
      }),
    stop: (input: {
      readonly correlationId: string;
      readonly idempotencyKey: string;
      readonly requestHeaders: Headers;
    }) =>
      Effect.gen(function* stopImpersonation() {
        const current = yield* Effect.tryPromise({
          catch: unavailable,
          try: () => auth.api.getSession({ headers: input.requestHeaders, returnHeaders: true }),
        });
        if (current.response === null) {
          const expiredRecovery = yield* loadExpiredImpersonationRecovery(input.requestHeaders);
          const recovered = yield* recoverOriginalSession(input.requestHeaders);
          if (expiredRecovery !== undefined) {
            yield* Effect.tryPromise({
              catch: unavailable,
              try: () => store.insertRecovery(expiredRecovery),
            });
            yield* terminateImpersonationSession(expiredRecovery.impersonationSessionId);
            const restoredMatches =
              (recovered.state === 'restored' || recovered.state === 'expired') &&
              recovered.originalSessionId === expiredRecovery.originalSessionId;
            return yield* completeRecovery({
              correlationId: input.correlationId,
              recovery: expiredRecovery,
              restoredSessionId: expiredRecovery.originalSessionId,
              sessionTerminated: true,
              setCookieHeaders: restoredMatches
                ? recovered.setCookieHeaders
                : clearAuthCookies(dependencies.configuration),
            });
          }
          if (recovered.state === 'restored' || recovered.state === 'expired') {
            const recoveries = yield* loadRecoveries(recovered.originalSessionId);
            const outcomes = yield* Effect.forEach(recoveries, (recovery) =>
              completeRecovery({
                correlationId: input.correlationId,
                recovery,
                restoredSessionId: recovered.originalSessionId,
                sessionTerminated: false,
                setCookieHeaders: recovered.setCookieHeaders,
              }),
            );
            return {
              active: false as const,
              checkpointPending: outcomes.some((outcome) => outcome.checkpointPending),
              setCookieHeaders: recovered.setCookieHeaders,
            };
          }
          return {
            active: false as const,
            checkpointPending: recovered.state === 'invalid',
            setCookieHeaders:
              recovered.state === 'invalid'
                ? clearAuthCookies(dependencies.configuration)
                : cookieHeaders(current.headers),
          };
        }
        const currentSessionId = current.response.session.id;
        if (!Predicate.isString(current.response.session.impersonatedBy)) {
          const recoveries = yield* loadRecoveries(currentSessionId);
          if (recoveries.length === 0) {
            return {
              active: false as const,
              checkpointPending: false as const,
              setCookieHeaders: cookieHeaders(current.headers),
            };
          }
          const outcomes = yield* Effect.forEach(recoveries, (recovery) =>
            completeRecovery({
              correlationId: input.correlationId,
              recovery,
              restoredSessionId: currentSessionId,
              sessionTerminated: false,
              setCookieHeaders: cookieHeaders(current.headers),
            }),
          );
          return {
            active: false as const,
            checkpointPending: outcomes.some((outcome) => outcome.checkpointPending),
            setCookieHeaders: cookieHeaders(current.headers),
          };
        }
        const tenantId = current.response.session.activeTenantId;
        const actionId = current.response.session.impersonationActionId;
        const originalAuthBindingId = current.response.session.impersonationOriginalAuthBindingId;
        const originalPrincipalId = current.response.session.impersonationOriginalPrincipalId;
        const originalSessionId = current.response.session.impersonationOriginalSessionId;
        const reason = current.response.session.impersonationReason;
        const targetPrincipalId = current.response.session.impersonationTargetPrincipalId;
        if (
          !Predicate.isString(tenantId) ||
          !Predicate.isString(actionId) ||
          !Predicate.isString(originalAuthBindingId) ||
          !Predicate.isString(originalPrincipalId) ||
          !Predicate.isString(originalSessionId) ||
          !Predicate.isString(reason) ||
          !Predicate.isString(targetPrincipalId)
        ) {
          return yield* unavailable();
        }
        const recovery = {
          actionId,
          impersonationSessionId: currentSessionId,
          originalAuthBindingId,
          originalPrincipalId,
          originalSessionId,
          reason,
          targetPrincipalId,
          tenantId,
        };
        yield* Effect.tryPromise({
          catch: unavailable,
          try: () => store.insertRecovery(recovery),
        });
        const stoppedExit = yield* Effect.exit(
          Effect.tryPromise({
            catch: mapProviderError,
            try: () =>
              auth.api.stopImpersonating({ headers: input.requestHeaders, returnHeaders: true }),
          }),
        );
        if (stoppedExit._tag === 'Failure') {
          yield* terminateImpersonationSession(currentSessionId);
          return yield* completeRecovery({
            correlationId: input.correlationId,
            recovery,
            restoredSessionId: originalSessionId,
            sessionTerminated: true,
            setCookieHeaders: clearAuthCookies(dependencies.configuration),
          });
        }
        const stopped = stoppedExit.value;
        const restoredSessionId = stopped.response.session.id;
        if (restoredSessionId !== originalSessionId) {
          return yield* completeRecovery({
            correlationId: input.correlationId,
            recovery,
            restoredSessionId: originalSessionId,
            sessionTerminated: true,
            setCookieHeaders: clearAuthCookies(dependencies.configuration),
          });
        }
        return yield* completeRecovery({
          correlationId: input.correlationId,
          recovery,
          restoredSessionId,
          sessionTerminated: true,
          setCookieHeaders: cookieHeaders(stopped.headers),
        });
      }),
  });
};

export type SupportImpersonationServiceContract = ReturnType<
  typeof makeSupportImpersonationService
>;

export class SupportImpersonationService extends Context.Service<
  SupportImpersonationService,
  SupportImpersonationServiceContract
>()('@app/shell-super-app/api/auth/impersonation-service/SupportImpersonationService') {}

export const SupportImpersonationServiceLive = Layer.effect(
  SupportImpersonationService,
  Effect.gen(function* supportImpersonationServiceLive() {
    const actionRuntime = yield* ActionRuntime;
    const authentication = yield* AuthenticationService;
    const configuration = yield* AuthConfig;
    const database = yield* AuthDatabase;
    const resolver = yield* PrincipalResolver;
    const supportRecoveryPrincipal = yield* SupportRecoveryPrincipalContextResolver;
    return makeSupportImpersonationService({
      actionRuntime,
      authentication,
      configuration,
      database: database.executor,
      resolver,
      supportRecoveryPrincipal,
    });
  }),
);
