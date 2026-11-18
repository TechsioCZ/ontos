import type {
  ActionRuntimeService,
  PrincipalResolutionError,
  PrincipalResolverService,
  SupportRecoveryPrincipalContextResolverService,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import {
  ActionCommitIndeterminate,
  ActionRuntime,
  PrincipalResolver,
  recordSupportImpersonationAction,
  SupportRecoveryPrincipalContextResolver,
} from '@app/core-runtime';
import { betterAuth } from 'better-auth';
import { isAPIError } from 'better-auth/api';
import { parseCookies, SECURE_COOKIE_PREFIX } from 'better-auth/cookies';
import { constantTimeEqual, makeSignature } from 'better-auth/crypto';
import { admin } from 'better-auth/plugins/admin';
import { asc, eq } from 'drizzle-orm';
import type { Duration } from 'effect';
import { Clock, Context, Data, DateTime, Effect, Exit, Layer, Option, Predicate, Redacted, Ref, Schema } from 'effect';
import { Cookies } from 'effect/http';

import { AuthConfig } from './config.ts';
import type { AuthConfigValue } from './config.ts';
import { AuthDatabase } from './db/client.ts';
import { session, supportImpersonationRecovery } from './db/schema.ts';
import type { AuthDatabaseExecutor, BetterAuthDatabaseAdapter } from './db/types.ts';
import { AuthenticationInternalError, AuthenticationUnavailableError } from './errors.ts';
import type { AuthenticationRuntimeError } from './errors.ts';
import { AuthenticationService } from './service.ts';
import type { AuthenticationServiceContract } from './service.ts';
import { SupportAuthProviderService } from './support-auth-provider-service.ts';
import { SupportImpersonationCorrelationId } from './support-impersonation-correlation-id.ts';
import { SupportImpersonationStoreService } from './support-impersonation-store-service.ts';
import type { SupportImpersonationStore, SupportRecoveryRecord } from './support-impersonation-store-service.ts';

export { SupportAuthProviderService } from './support-auth-provider-service.ts';
export { SupportImpersonationCorrelationId } from './support-impersonation-correlation-id.ts';
export { SupportImpersonationStoreService } from './support-impersonation-store-service.ts';
export type { SupportImpersonationStore, SupportRecoveryRecord } from './support-impersonation-store-service.ts';

const SupportImpersonationDeniedErrorSchema = Schema.TaggedStruct('SupportImpersonationDeniedError', {
  code: Schema.Literal('support_impersonation_denied'),
  reason: Schema.String,
});
type SupportImpersonationDeniedError = typeof SupportImpersonationDeniedErrorSchema.Type;
const SupportImpersonationDeniedFailure = Data.TaggedError('SupportImpersonationDeniedError');
const SupportImpersonationUnavailableErrorSchema = Schema.TaggedStruct('SupportImpersonationUnavailableError', {
  code: Schema.Literal('support_impersonation_unavailable'),
  reason: Schema.String,
});
export type SupportImpersonationUnavailableError = typeof SupportImpersonationUnavailableErrorSchema.Type;
const SupportImpersonationUnavailableFailure = Data.TaggedError('SupportImpersonationUnavailableError');
export type SupportImpersonationError = SupportImpersonationDeniedError | SupportImpersonationUnavailableError;
const denied = () =>
  new SupportImpersonationDeniedFailure<{
    readonly code: 'support_impersonation_denied';
    readonly reason: string;
  }>({
    code: 'support_impersonation_denied',
    reason: 'Support impersonation is not permitted',
  });
const unavailable = (cause?: unknown): SupportImpersonationUnavailableError =>
  new SupportImpersonationUnavailableFailure<{
    readonly cause?: unknown;
    readonly code: 'support_impersonation_unavailable';
    readonly reason: string;
  }>({
    cause,
    code: 'support_impersonation_unavailable',
    reason: 'Support impersonation is temporarily unavailable',
  });
const cookieHeaders = (headers: Headers): readonly string[] =>
  Predicate.isFunction(headers.getSetCookie) ? headers.getSetCookie() : [];
const isAuthenticationUnavailable = Schema.is(AuthenticationUnavailableError);
const isAuthenticationInternal = Schema.is(AuthenticationInternalError);
const isCommitIndeterminate = Schema.is(ActionCommitIndeterminate);
const isResolverUnavailable = (error: PrincipalResolutionError) =>
  Predicate.isTagged(error, 'PrincipalResolverUnavailableError');
const mapAuthenticationError = (error: AuthenticationRuntimeError) =>
  isAuthenticationUnavailable(error) || isAuthenticationInternal(error) ? unavailable(error) : denied();
const mapResolverError = (error: PrincipalResolutionError) =>
  isResolverUnavailable(error) ? unavailable(error) : denied();
const mapProviderError = <Failure>(error: Failure) =>
  isAPIError(error) && error.statusCode < 500 ? denied() : unavailable(error);

const IMPERSONATION_IO_TIMEOUT = '10 seconds';
const timeoutFailure = () => unavailable('Support impersonation dependency timed out');
const impersonationTimeout = Effect.timeoutOrElse({
  duration: IMPERSONATION_IO_TIMEOUT,
  orElse: () => Effect.fail(timeoutFailure()),
});
const providerOperation = <Value>(operation: () => PromiseLike<Value>) =>
  Effect.tryPromise({ catch: mapProviderError, try: operation }).pipe(impersonationTimeout);
const databasePolicy = <Value, Failure>(operation: Effect.Effect<Value, Failure>) =>
  operation.pipe(Effect.mapError(unavailable), impersonationTimeout);

interface SupportProviderSession {
  readonly activeTenantId?: null | string | undefined;
  readonly id: string;
  readonly impersonatedBy?: null | string | undefined;
  readonly impersonationActionId?: null | string | undefined;
  readonly impersonationOriginalAuthBindingId?: null | string | undefined;
  readonly impersonationOriginalPrincipalId?: null | string | undefined;
  readonly impersonationOriginalSessionId?: null | string | undefined;
  readonly impersonationReason?: null | string | undefined;
  readonly impersonationTargetPrincipalId?: null | string | undefined;
}

interface SupportProviderUser {
  readonly id: string;
}

export interface SupportAuthProvider {
  readonly api: {
    readonly getSession: (input: { readonly headers: Headers; readonly returnHeaders: true }) => Promise<{
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
    readonly stopImpersonating: (input: { readonly headers: Headers; readonly returnHeaders: true }) => Promise<{
      readonly headers: Headers;
      readonly response: { readonly session: SupportProviderSession };
    }>;
  };
}

export const makeSupportAuthProvider = (
  configuration: AuthConfigValue,
  databaseAdapter: BetterAuthDatabaseAdapter,
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
    database: databaseAdapter,
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
        impersonationReason: { input: false, required: false, type: 'string' },
        impersonationTargetPrincipalId: {
          input: false,
          required: false,
          type: 'string',
        },
      },
    },
    trustedOrigins: [...configuration.trustedOrigins],
  }) satisfies SupportAuthProvider;

export const makeSupportImpersonationStore = (database: AuthDatabaseExecutor): SupportImpersonationStore => ({
  deleteRecovery: (impersonationSessionId) =>
    databasePolicy(
      database
        .delete(supportImpersonationRecovery)
        .where(eq(supportImpersonationRecovery.impersonationSessionId, impersonationSessionId)),
    ).pipe(Effect.asVoid),
  deleteSession: (sessionId) =>
    databasePolicy(database.delete(session).where(eq(session.id, sessionId))).pipe(Effect.asVoid),
  insertRecovery: (recovery) =>
    databasePolicy(database.insert(supportImpersonationRecovery).values(recovery).onConflictDoNothing()).pipe(
      Effect.asVoid,
    ),
  loadExpiredRecovery: (sessionToken) =>
    databasePolicy(
      database
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
        .where(eq(session.token, Redacted.value(sessionToken)))
        .limit(1),
    ).pipe(
      Effect.map(([loaded]) => {
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
          return Option.none();
        }
        return Option.some({
          actionId: loaded.actionId,
          impersonationSessionId: loaded.impersonationSessionId,
          originalAuthBindingId: loaded.originalAuthBindingId,
          originalPrincipalId: loaded.originalPrincipalId,
          originalSessionId: loaded.originalSessionId,
          reason: loaded.reason,
          targetPrincipalId: loaded.targetPrincipalId,
          tenantId: loaded.tenantId,
        });
      }),
    ),
  loadOriginalSession: (sessionToken) =>
    databasePolicy(
      database
        .select({ expiresAt: session.expiresAt, id: session.id })
        .from(session)
        .where(eq(session.token, Redacted.value(sessionToken)))
        .limit(1),
    ).pipe(Effect.map(([loaded]) => Option.fromNullishOr(loaded))),
  loadRecoveries: (originalSessionId) =>
    databasePolicy(
      database
        .select()
        .from(supportImpersonationRecovery)
        .where(eq(supportImpersonationRecovery.originalSessionId, originalSessionId))
        .orderBy(asc(supportImpersonationRecovery.createdAt)),
    ),
  loadSession: (sessionId) =>
    databasePolicy(
      database
        .select({
          expiresAt: session.expiresAt,
          id: session.id,
          impersonatedBy: session.impersonatedBy,
          token: session.token,
        })
        .from(session)
        .where(eq(session.id, sessionId))
        .limit(1),
    ).pipe(
      Effect.map(([loaded]) =>
        Option.map(Option.fromNullishOr(loaded), (found) => ({ ...found, token: Redacted.make(found.token) })),
      ),
    ),
  updateImpersonationSession: (sessionId, metadata) =>
    databasePolicy(
      database
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
        .where(eq(session.id, sessionId)),
    ).pipe(Effect.asVoid),
});

const authCookieName = (configuration: AuthConfigValue, suffix: string): string => {
  const cookie = Cookies.makeCookieUnsafe(
    `${configuration.secureCookies ? SECURE_COOKIE_PREFIX : ''}better-auth.${suffix}`,
    '',
    {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: configuration.secureCookies,
    },
  );
  return cookie.name;
};
const serializeAuthCookie = (
  configuration: AuthConfigValue,
  suffix: string,
  value: string,
  options: { readonly expires?: Date; readonly maxAge?: Duration.Input } = {},
): string =>
  Cookies.toSetCookieHeaders(
    Cookies.fromIterable([
      Cookies.makeCookieUnsafe(authCookieName(configuration, suffix), value, {
        expires: options.expires,
        httpOnly: true,
        maxAge: options.maxAge,
        path: '/',
        sameSite: 'lax',
        secure: configuration.secureCookies,
      }),
    ]),
  )[0] ?? '';
const clearAuthCookies = (configuration: AuthConfigValue): readonly string[] =>
  ['session_token', 'session_data', 'admin_session', 'dont_remember'].map((suffix) =>
    serializeAuthCookie(configuration, suffix, '', {
      expires: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
      maxAge: '0 seconds',
    }),
  );
const decodeSignedCookie = Effect.fn('decodeSignedCookie')(function* decodeSignedCookieEffect(
  requestHeaders: Headers,
  cookieName: string,
  secret: Redacted.Redacted,
) {
  const encoded = parseCookies(requestHeaders.get('cookie') ?? '').get(cookieName);
  if (encoded === undefined) {
    return Option.none();
  }
  const separator = encoded.lastIndexOf('.');
  if (separator <= 0) {
    return Option.none();
  }
  const value = encoded.slice(0, separator);
  const signature = encoded.slice(separator + 1);
  const expected = yield* Effect.tryPromise({
    catch: unavailable,
    try: makeSignature.bind(undefined, value, Redacted.value(secret)),
  }).pipe(impersonationTimeout);
  return constantTimeEqual(signature, expected) ? Option.some(value) : Option.none();
});
const encodeSignedCookie = Effect.fn('encodeSignedCookie')(function* encodeSignedCookieEffect(
  value: string,
  secret: Redacted.Redacted,
) {
  const signature = yield* Effect.tryPromise({
    catch: unavailable,
    try: makeSignature.bind(undefined, value, Redacted.value(secret)),
  }).pipe(impersonationTimeout);
  return `${value}.${signature}`;
});

const recoveryFromSession = Effect.fn('recoveryFromSession')(function* recoveryFromSessionEffect(
  currentSession: SupportProviderSession,
) {
  const tenantId = currentSession.activeTenantId;
  const actionId = currentSession.impersonationActionId;
  const originalAuthBindingId = currentSession.impersonationOriginalAuthBindingId;
  const originalPrincipalId = currentSession.impersonationOriginalPrincipalId;
  const originalSessionId = currentSession.impersonationOriginalSessionId;
  const reason = currentSession.impersonationReason;
  const targetPrincipalId = currentSession.impersonationTargetPrincipalId;
  if (
    !Predicate.isString(tenantId) ||
    !Predicate.isString(actionId) ||
    !Predicate.isString(originalAuthBindingId) ||
    !Predicate.isString(originalPrincipalId) ||
    !Predicate.isString(originalSessionId) ||
    !Predicate.isString(reason) ||
    !Predicate.isString(targetPrincipalId)
  ) {
    return yield* Effect.fail(unavailable());
  }
  return {
    actionId,
    impersonationSessionId: currentSession.id,
    originalAuthBindingId,
    originalPrincipalId,
    originalSessionId,
    reason,
    targetPrincipalId,
    tenantId,
  } satisfies SupportRecoveryRecord;
});

interface SupportCheckpointInput {
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly principal: TrustedPrincipalContext;
}

interface CompleteRecoveryInput {
  readonly recovery: SupportRecoveryRecord;
  readonly restoredSessionId: string;
  readonly sessionTerminated: boolean;
  readonly setCookieHeaders: readonly string[];
}

interface StartSupportImpersonationInput {
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly requestHeaders: Headers;
  readonly targetPrincipalId: string;
}

interface StartedCheckpointInput {
  readonly idempotencyKey: string;
  readonly impersonationSessionId: string;
  readonly originalPrincipalId: string;
  readonly principal: TrustedPrincipalContext;
  readonly reason: string;
  readonly targetPrincipalId: string;
}

interface ResumeStartInput {
  readonly originalSessionId: string;
  readonly requestHeaders: Headers;
  readonly started: Omit<StartedCheckpointInput, 'impersonationSessionId'>;
}

interface StopSupportImpersonationInput {
  readonly idempotencyKey: string;
  readonly requestHeaders: Headers;
}

type SupportImpersonationRequirements =
  | ActionRuntime
  | AuthenticationService
  | AuthConfig
  | PrincipalResolver
  | SupportRecoveryPrincipalContextResolver
  | SupportAuthProviderService
  | SupportImpersonationStoreService;

export const makeSupportImpersonationService = (context: Context.Context<SupportImpersonationRequirements>) => {
  const actionRuntime: ActionRuntimeService = Context.get(context, ActionRuntime);
  const authentication: AuthenticationServiceContract = Context.get(context, AuthenticationService);
  const configuration = Context.get(context, AuthConfig);
  const resolver: PrincipalResolverService = Context.get(context, PrincipalResolver);
  const supportRecoveryPrincipal: SupportRecoveryPrincipalContextResolverService = Context.get(
    context,
    SupportRecoveryPrincipalContextResolver,
  );
  const auth = Context.get(context, SupportAuthProviderService);
  const store = Context.get(context, SupportImpersonationStoreService);
  const secret = Redacted.make(configuration.secret);
  const checkpoint = Effect.fn('makeSupportImpersonationService.checkpoint')(function* checkpointEffect(
    input: SupportCheckpointInput,
  ) {
    const correlationId = yield* SupportImpersonationCorrelationId;
    const replayed = yield* Ref.make(false);
    yield* actionRuntime.runAction({
      onReplay: () => Ref.set(replayed, true),
      payload: input.payload,
      principal: input.principal,
      registration: recordSupportImpersonationAction,
      transport: { correlationId, idempotencyKey: input.idempotencyKey },
    });
    // Whether Core answered with the saved reply of a checkpoint an earlier request committed.
    return { replayed: yield* Ref.get(replayed) };
  });
  const loadExpiredImpersonationRecovery = Effect.fn(
    'makeSupportImpersonationService.loadExpiredImpersonationRecovery',
  )(function* loadExpiredImpersonationRecoveryEffect(requestHeaders: Headers) {
    const sessionToken = yield* decodeSignedCookie(
      requestHeaders,
      authCookieName(configuration, 'session_token'),
      secret,
    );
    if (Option.isNone(sessionToken)) {
      return Option.none();
    }
    return yield* store.loadExpiredRecovery(Redacted.make(sessionToken.value));
  });
  const restoredSessionCookies = Effect.fn('makeSupportImpersonationService.restoredSessionCookies')(
    function* restoredSessionCookiesEffect(
      originalSessionToken: Redacted.Redacted,
      dontRememberFlag: string | undefined,
      expiresAtEpochMillis: number,
      nowEpochMillis: number,
    ) {
      const sessionCookie = yield* encodeSignedCookie(Redacted.value(originalSessionToken), secret);
      const maxAge = Math.max(0, Math.floor((expiresAtEpochMillis - nowEpochMillis) / 1000));
      const remembered = dontRememberFlag === undefined || dontRememberFlag.length === 0;
      const restoredCookie = serializeAuthCookie(
        configuration,
        'session_token',
        sessionCookie,
        remembered ? { maxAge: `${maxAge} seconds` } : {},
      );
      const dontRememberCookie = remembered
        ? Option.none()
        : Option.some(serializeAuthCookie(configuration, 'dont_remember', yield* encodeSignedCookie('true', secret)));
      return [
        restoredCookie,
        ...(Option.isSome(dontRememberCookie) ? [dontRememberCookie.value] : []),
        ...clearAuthCookies(configuration).filter(
          (header) =>
            !header.startsWith(`${authCookieName(configuration, 'session_token')}=`) &&
            (Option.isNone(dontRememberCookie) ||
              !header.startsWith(`${authCookieName(configuration, 'dont_remember')}=`)),
        ),
      ];
    },
  );
  const recoverOriginalSession = Effect.fn('makeSupportImpersonationService.recoverOriginalSession')(
    function* recoverOriginalSessionEffect(requestHeaders: Headers) {
      const adminCookieName = authCookieName(configuration, 'admin_session');
      const hasAdminCookie = parseCookies(requestHeaders.get('cookie') ?? '').has(adminCookieName);
      if (!hasAdminCookie) {
        return { state: 'absent' as const };
      }
      const signedValue = yield* decodeSignedCookie(requestHeaders, adminCookieName, secret);
      if (Option.isNone(signedValue)) {
        return { state: 'invalid' as const };
      }
      const [originalSessionToken, dontRememberFlag] = signedValue.value.split(':');
      if (originalSessionToken === undefined || originalSessionToken.length === 0) {
        return { state: 'invalid' as const };
      }
      const original = yield* store.loadOriginalSession(Redacted.make(originalSessionToken));
      const nowEpochMillis = yield* Clock.currentTimeMillis;
      if (Option.isNone(original)) {
        return { state: 'invalid' as const };
      }
      if (original.value.expiresAt.getTime() <= nowEpochMillis) {
        return {
          originalSessionId: original.value.id,
          setCookieHeaders: clearAuthCookies(configuration),
          state: 'expired' as const,
        };
      }
      return {
        originalSessionId: original.value.id,
        setCookieHeaders: yield* restoredSessionCookies(
          Redacted.make(originalSessionToken),
          dontRememberFlag,
          original.value.expiresAt.getTime(),
          nowEpochMillis,
        ),
        state: 'restored' as const,
      };
    },
  );
  const terminateImpersonationSession = (impersonationSessionId: string) => store.deleteSession(impersonationSessionId);
  const completeRecovery = Effect.fn('makeSupportImpersonationService.completeRecovery')(
    function* completeRecoveryEffect(input: CompleteRecoveryInput) {
      if (!input.sessionTerminated) {
        const terminationExit = yield* Effect.exit(
          terminateImpersonationSession(input.recovery.impersonationSessionId),
        );
        if (Exit.isFailure(terminationExit)) {
          return {
            active: false as const,
            checkpointPending: true as const,
            setCookieHeaders: input.setCookieHeaders,
          };
        }
      }
      const originalPrincipalExit = yield* Effect.exit(
        supportRecoveryPrincipal.resolveStoppedImpersonation({
          originalAuthBindingId: input.recovery.originalAuthBindingId,
          originalPrincipalId: input.recovery.originalPrincipalId,
          originalSessionId: input.restoredSessionId,
          tenantId: input.recovery.tenantId,
        }),
      );
      if (Exit.isFailure(originalPrincipalExit)) {
        return {
          active: false as const,
          checkpointPending: true as const,
          setCookieHeaders: input.setCookieHeaders,
        };
      }
      const originalPrincipal = originalPrincipalExit.value;
      // A retry of a stop checkpoint that already committed gets Core's saved reply. ActionAlreadyCommitted
      // remains only for a checkpoint committed before Core saved replies; both mean the checkpoint is recorded.
      const checkpointExit = yield* Effect.exit(
        checkpoint({
          idempotencyKey: `${input.recovery.actionId}:stopped`,
          payload: {
            checkpoint: 'stopped',
            originalPrincipalId: input.recovery.originalPrincipalId,
            reason: input.recovery.reason,
            sessionRef: `better-auth-session:${input.recovery.impersonationSessionId}`,
            targetPrincipalId: input.recovery.targetPrincipalId,
          },
          principal: originalPrincipal,
        }).pipe(Effect.catchTag('ActionAlreadyCommitted', () => Effect.void)),
      );
      if (Exit.isFailure(checkpointExit)) {
        return {
          active: false as const,
          checkpointPending: true as const,
          setCookieHeaders: input.setCookieHeaders,
        };
      }
      const cleanupExit = yield* Effect.exit(store.deleteRecovery(input.recovery.impersonationSessionId));
      return {
        active: false as const,
        checkpointPending: Exit.isFailure(cleanupExit),
        setCookieHeaders: input.setCookieHeaders,
      };
    },
  );
  /**
   * Records the 'started' checkpoint for one provider session. A refused checkpoint leaves nothing
   * behind: the session and its recovery are removed. A commit Core cannot confirm keeps both, since
   * the checkpoint may have committed with this session, and a same-key retry resumes it.
   */
  const recordStarted = (input: StartedCheckpointInput) =>
    checkpoint({
      idempotencyKey: `${input.idempotencyKey}:started`,
      payload: {
        checkpoint: 'started',
        originalPrincipalId: input.originalPrincipalId,
        reason: input.reason,
        sessionRef: `better-auth-session:${input.impersonationSessionId}`,
        targetPrincipalId: input.targetPrincipalId,
      },
      principal: input.principal,
    }).pipe(
      Effect.tapError((failure) =>
        isCommitIndeterminate(failure)
          ? Effect.void
          : Effect.all(
              [
                terminateImpersonationSession(input.impersonationSessionId),
                store.deleteRecovery(input.impersonationSessionId),
              ],
              { concurrency: 1, discard: true },
            ).pipe(Effect.ignore),
      ),
    );
  /**
   * The cookies `impersonateUser` set for this impersonation session, issued again: the support
   * user's own session kept in the admin cookie, and the impersonation session as a browser-session
   * cookie. None when either session is gone or expired, or the session is no impersonation.
   */
  const reissuedImpersonationCookies = Effect.fn('makeSupportImpersonationService.reissuedImpersonationCookies')(
    function* reissuedImpersonationCookiesEffect(
      originalSessionId: string,
      impersonationSessionId: string,
      requestHeaders: Headers,
    ) {
      const [original, impersonated] = yield* Effect.all(
        [store.loadSession(originalSessionId), store.loadSession(impersonationSessionId)],
        { concurrency: 2 },
      );
      const nowEpochMillis = yield* Clock.currentTimeMillis;
      if (
        Option.isNone(original) ||
        Option.isNone(impersonated) ||
        !Predicate.isString(impersonated.value.impersonatedBy) ||
        original.value.expiresAt.getTime() <= nowEpochMillis ||
        impersonated.value.expiresAt.getTime() <= nowEpochMillis
      ) {
        return Option.none();
      }
      const dontRemember = yield* decodeSignedCookie(
        requestHeaders,
        authCookieName(configuration, 'dont_remember'),
        secret,
      );
      const [adminSession, sessionToken, dontRememberFlag] = yield* Effect.all(
        [
          encodeSignedCookie(
            `${Redacted.value(original.value.token)}:${Option.getOrElse(dontRemember, () => '')}`,
            secret,
          ),
          encodeSignedCookie(Redacted.value(impersonated.value.token), secret),
          encodeSignedCookie('true', secret),
        ],
        // Three in-memory signatures with the deployment secret; none reaches a shared resource.
        { concurrency: 3 },
      );
      const originalMaxAge = Math.max(0, Math.floor((original.value.expiresAt.getTime() - nowEpochMillis) / 1000));
      return Option.some([
        ...clearAuthCookies(configuration).filter((header) =>
          header.startsWith(`${authCookieName(configuration, 'session_data')}=`),
        ),
        serializeAuthCookie(configuration, 'admin_session', adminSession, { maxAge: `${originalMaxAge} seconds` }),
        serializeAuthCookie(configuration, 'session_token', sessionToken),
        serializeAuthCookie(configuration, 'dont_remember', dontRememberFlag),
      ]);
    },
  );
  /**
   * Resumes a start whose 'requested' checkpoint an earlier request with the same key committed. The
   * session that request created carries this key in its recovery; its 'started' checkpoint is
   * replayed, or committed now if that request stopped before it, and the session's cookies are the
   * answer. Without such a recovery the earlier request created no session this start can use.
   */
  const resumeStart = Effect.fn('makeSupportImpersonationService.resumeStart')(function* resumeStartEffect(
    input: ResumeStartInput,
  ) {
    const recoveries = yield* store.loadRecoveries(input.originalSessionId);
    const recovery = recoveries.find((candidate) => candidate.actionId === input.started.idempotencyKey);
    if (recovery === undefined) {
      return Option.none();
    }
    yield* recordStarted({ ...input.started, impersonationSessionId: recovery.impersonationSessionId });
    const cookies = yield* reissuedImpersonationCookies(
      input.originalSessionId,
      recovery.impersonationSessionId,
      input.requestHeaders,
    );
    if (Option.isNone(cookies)) {
      // The impersonation this key started has ended: it is stopped like any other, and the start
      // answers a definite refusal rather than a session nobody can use.
      yield* completeRecovery({
        recovery,
        restoredSessionId: input.originalSessionId,
        sessionTerminated: false,
        setCookieHeaders: [],
      });
      return yield* denied();
    }
    return Option.some({
      active: true as const,
      setCookieHeaders: cookies.value,
      targetPrincipalId: input.started.targetPrincipalId,
    });
  });
  const stopAbsentSession = Effect.fn('makeSupportImpersonationService.stopAbsentSession')(
    function* stopAbsentSessionEffect(requestHeaders: Headers, headers: Headers) {
      const [expiredRecovery, recovered] = yield* Effect.all(
        [loadExpiredImpersonationRecovery(requestHeaders), recoverOriginalSession(requestHeaders)],
        { concurrency: 2 },
      );
      if (Option.isSome(expiredRecovery)) {
        yield* store.insertRecovery(expiredRecovery.value);
        yield* terminateImpersonationSession(expiredRecovery.value.impersonationSessionId);
        const restoredMatches =
          (recovered.state === 'restored' || recovered.state === 'expired') &&
          recovered.originalSessionId === expiredRecovery.value.originalSessionId;
        return yield* completeRecovery({
          recovery: expiredRecovery.value,
          restoredSessionId: expiredRecovery.value.originalSessionId,
          sessionTerminated: true,
          setCookieHeaders: restoredMatches ? recovered.setCookieHeaders : clearAuthCookies(configuration),
        });
      }
      if (recovered.state === 'restored' || recovered.state === 'expired') {
        const recoveries = yield* store.loadRecoveries(recovered.originalSessionId);
        const outcomes = yield* Effect.forEach(
          recoveries,
          (recovery) =>
            completeRecovery({
              recovery,
              restoredSessionId: recovered.originalSessionId,
              sessionTerminated: false,
              setCookieHeaders: recovered.setCookieHeaders,
            }),
          { concurrency: 1 },
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
        setCookieHeaders: recovered.state === 'invalid' ? clearAuthCookies(configuration) : cookieHeaders(headers),
      };
    },
  );
  return Object.freeze({
    start: Effect.fn('makeSupportImpersonationService.start')(function* startSupportImpersonationEffect(
      input: StartSupportImpersonationInput,
    ) {
      const reason = input.reason.trim();
      if (reason.length < 1 || reason.length > 500) {
        return yield* denied();
      }
      const shell = yield* authentication
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
      const originalSessionId = shell.principal.authContextRef.slice('better-auth-session:'.length);
      const originalAuthBindingId = shell.principal.authBindingId;
      if (originalSessionId.length === 0) {
        return yield* denied();
      }
      const targetUserId = yield* resolver
        .resolveBetterAuthUserForPrincipal({
          principalId: input.targetPrincipalId,
          tenantId: shell.principal.tenantId,
        })
        .pipe(Effect.mapError(mapResolverError));
      const requested = yield* checkpoint({
        idempotencyKey: `${input.idempotencyKey}:requested`,
        payload: {
          checkpoint: 'requested',
          originalPrincipalId: shell.principal.principalId,
          reason,
          targetPrincipalId: input.targetPrincipalId,
        },
        principal: shell.principal,
      });
      const started = {
        idempotencyKey: input.idempotencyKey,
        originalPrincipalId: shell.principal.principalId,
        principal: shell.principal,
        reason,
        targetPrincipalId: input.targetPrincipalId,
      };
      if (requested.replayed) {
        // A same-key retry of a start that got past this checkpoint: the session that start created, if
        // any, is the answer, and the provider is not asked for another one.
        const resumed = yield* resumeStart({
          originalSessionId,
          requestHeaders: input.requestHeaders,
          started,
        });
        if (Option.isSome(resumed)) {
          return resumed.value;
        }
      }
      const created = yield* providerOperation(
        auth.api.impersonateUser.bind(auth.api, {
          body: { userId: targetUserId },
          headers: input.requestHeaders,
          returnHeaders: true,
        }),
      );
      yield* store
        .updateImpersonationSession(created.response.session.id, {
          actionId: input.idempotencyKey,
          originalAuthBindingId,
          originalPrincipalId: shell.principal.principalId,
          originalSessionId,
          reason,
          targetPrincipalId: input.targetPrincipalId,
          tenantId: shell.principal.tenantId,
        })
        .pipe(
          Effect.catch((error) =>
            store.deleteSession(created.response.session.id).pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
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
      yield* store
        .insertRecovery(recovery)
        .pipe(
          Effect.catch((error) =>
            terminateImpersonationSession(created.response.session.id).pipe(
              Effect.ignore,
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
      yield* recordStarted({ ...started, impersonationSessionId: created.response.session.id });
      return {
        active: true as const,
        setCookieHeaders: cookieHeaders(created.headers),
        targetPrincipalId: input.targetPrincipalId,
      };
    }),
    stop: Effect.fn('makeSupportImpersonationService.stop')(function* stopSupportImpersonationEffect(
      input: StopSupportImpersonationInput,
    ) {
      const current = yield* providerOperation(
        auth.api.getSession.bind(auth.api, {
          headers: input.requestHeaders,
          returnHeaders: true,
        }),
      );
      if (current.response === null) {
        return yield* stopAbsentSession(input.requestHeaders, current.headers);
      }
      const currentSessionId = current.response.session.id;
      if (!Predicate.isString(current.response.session.impersonatedBy)) {
        const recoveries = yield* store.loadRecoveries(currentSessionId);
        if (recoveries.length === 0) {
          return {
            active: false as const,
            checkpointPending: false as const,
            setCookieHeaders: cookieHeaders(current.headers),
          };
        }
        const outcomes = yield* Effect.forEach(
          recoveries,
          (recovery) =>
            completeRecovery({
              recovery,
              restoredSessionId: currentSessionId,
              sessionTerminated: false,
              setCookieHeaders: cookieHeaders(current.headers),
            }),
          { concurrency: 1 },
        );
        return {
          active: false as const,
          checkpointPending: outcomes.some((outcome) => outcome.checkpointPending),
          setCookieHeaders: cookieHeaders(current.headers),
        };
      }
      const recovery = yield* recoveryFromSession(current.response.session);
      const { originalSessionId } = recovery;
      yield* store.insertRecovery(recovery);
      const stoppedExit = yield* Effect.exit(
        providerOperation(
          auth.api.stopImpersonating.bind(auth.api, {
            headers: input.requestHeaders,
            returnHeaders: true,
          }),
        ),
      );
      if (Exit.isFailure(stoppedExit)) {
        yield* terminateImpersonationSession(currentSessionId);
        return yield* completeRecovery({
          recovery,
          restoredSessionId: originalSessionId,
          sessionTerminated: true,
          setCookieHeaders: clearAuthCookies(configuration),
        });
      }
      const stopped = stoppedExit.value;
      const restoredSessionId = stopped.response.session.id;
      if (restoredSessionId !== originalSessionId) {
        return yield* completeRecovery({
          recovery,
          restoredSessionId: originalSessionId,
          sessionTerminated: true,
          setCookieHeaders: clearAuthCookies(configuration),
        });
      }
      return yield* completeRecovery({
        recovery,
        restoredSessionId,
        sessionTerminated: true,
        setCookieHeaders: cookieHeaders(stopped.headers),
      });
    }),
  });
};

export type SupportImpersonationServiceContract = ReturnType<typeof makeSupportImpersonationService>;

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
    const context = Context.empty().pipe(
      Context.add(ActionRuntime, actionRuntime),
      Context.add(AuthenticationService, authentication),
      Context.add(AuthConfig, configuration),
      Context.add(PrincipalResolver, resolver),
      Context.add(SupportRecoveryPrincipalContextResolver, supportRecoveryPrincipal),
      Context.add(SupportAuthProviderService, makeSupportAuthProvider(configuration, database.adapter)),
      Context.add(SupportImpersonationStoreService, makeSupportImpersonationStore(database.executor)),
    );
    return makeSupportImpersonationService(context);
  }),
);
