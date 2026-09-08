import type {
  ActionRuntimeService,
  PrincipalResolutionError,
  PrincipalResolverService,
  SupportRecoveryPrincipalContextResolverService,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import {
  ActionRuntime,
  PrincipalResolver,
  PrincipalResolverUnavailableError,
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
import {
  Clock,
  Context,
  Data,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
} from 'effect';
import { Cookies } from 'effect/unstable/http';

import { AuthConfig } from './config.ts';
import type { AuthConfigValue } from './config.ts';
import { AuthDatabase } from './db/client.ts';
import { session, supportImpersonationRecovery } from './db/schema.ts';
import type {
  AuthDatabaseExecutor,
  BetterAuthDatabaseAdapter,
} from './db/types.ts';
import {
  AuthenticationInternalError,
  AuthenticationUnavailableError,
} from './errors.ts';
import type { AuthenticationRuntimeError } from './errors.ts';
import { AuthenticationService } from './service.ts';
import type { AuthenticationServiceContract } from './service.ts';
import { SupportAuthProviderService } from './support-auth-provider-service.ts';
import { SupportImpersonationCorrelationId } from './support-impersonation-correlation-id.ts';
import { SupportImpersonationStoreService } from './support-impersonation-store-service.ts';
import type {
  SupportImpersonationStore,
  SupportRecoveryRecord,
} from './support-impersonation-store-service.ts';

export { SupportAuthProviderService } from './support-auth-provider-service.ts';
export { SupportImpersonationCorrelationId } from './support-impersonation-correlation-id.ts';
export { SupportImpersonationStoreService } from './support-impersonation-store-service.ts';
export type {
  SupportImpersonationStore,
  SupportRecoveryRecord,
} from './support-impersonation-store-service.ts';

const SupportImpersonationDeniedErrorSchema = Schema.TaggedStruct(
  'SupportImpersonationDeniedError',
  {
    code: Schema.Literal('support_impersonation_denied'),
    reason: Schema.String,
  }
);
type SupportImpersonationDeniedError =
  typeof SupportImpersonationDeniedErrorSchema.Type;
const SupportImpersonationDeniedFailure = Data.TaggedError(
  'SupportImpersonationDeniedError'
);
const SupportImpersonationUnavailableErrorSchema = Schema.TaggedStruct(
  'SupportImpersonationUnavailableError',
  {
    code: Schema.Literal('support_impersonation_unavailable'),
    reason: Schema.String,
  }
);
export type SupportImpersonationUnavailableError =
  typeof SupportImpersonationUnavailableErrorSchema.Type;
const SupportImpersonationUnavailableFailure = Data.TaggedError(
  'SupportImpersonationUnavailableError'
);
export type SupportImpersonationError =
  | SupportImpersonationDeniedError
  | SupportImpersonationUnavailableError;
const denied = () =>
  new SupportImpersonationDeniedFailure<{
    readonly code: 'support_impersonation_denied';
    readonly reason: string;
  }>({
    code: 'support_impersonation_denied',
    reason: 'Support impersonation is not permitted',
  });
const unavailable = (cause?: unknown): SupportImpersonationUnavailableError => {
  const failure = new SupportImpersonationUnavailableFailure<{
    readonly code: 'support_impersonation_unavailable';
    readonly reason: string;
  }>({
    code: 'support_impersonation_unavailable',
    reason: 'Support impersonation is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', {
      configurable: true,
      value: cause,
    });
  }
  return failure;
};
const cookieHeaders = (headers: Headers): readonly string[] =>
  Predicate.isFunction(headers.getSetCookie) ? headers.getSetCookie() : [];
const isAuthenticationUnavailable = Schema.is(AuthenticationUnavailableError);
const isAuthenticationInternal = Schema.is(AuthenticationInternalError);
const isResolverUnavailable = Schema.is(PrincipalResolverUnavailableError);
const mapAuthenticationError = (error: AuthenticationRuntimeError) =>
  isAuthenticationUnavailable(error) || isAuthenticationInternal(error)
    ? unavailable(error)
    : denied();
const mapResolverError = (error: PrincipalResolutionError) =>
  isResolverUnavailable(error) ? unavailable(error) : denied();
const mapProviderError = <Failure>(error: Failure) =>
  isAPIError(error) && error.statusCode < 500 ? denied() : unavailable(error);

const IMPERSONATION_IO_TIMEOUT = '10 seconds';
const timeoutFailure = () =>
  unavailable('Support impersonation dependency timed out');
const impersonationTimeout = Effect.timeoutOrElse({
  duration: IMPERSONATION_IO_TIMEOUT,
  orElse: () => Effect.fail(timeoutFailure()),
});
const providerOperation = <Value>(operation: () => PromiseLike<Value>) =>
  Effect.tryPromise({ catch: mapProviderError, try: operation }).pipe(
    impersonationTimeout
  );
const databasePolicy = <Value, Failure>(
  operation: Effect.Effect<Value, Failure>
) => operation.pipe(Effect.mapError(unavailable), impersonationTimeout);

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

export const makeSupportAuthProvider = (
  configuration: AuthConfigValue,
  databaseAdapter: BetterAuthDatabaseAdapter
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

export const makeSupportImpersonationStore = (
  database: AuthDatabaseExecutor
): SupportImpersonationStore => ({
  deleteRecovery: (impersonationSessionId) =>
    databasePolicy(
      database
        .delete(supportImpersonationRecovery)
        .where(
          eq(
            supportImpersonationRecovery.impersonationSessionId,
            impersonationSessionId
          )
        )
    ).pipe(Effect.asVoid),
  deleteSession: (sessionId) =>
    databasePolicy(
      database.delete(session).where(eq(session.id, sessionId))
    ).pipe(Effect.asVoid),
  insertRecovery: (recovery) =>
    databasePolicy(
      database
        .insert(supportImpersonationRecovery)
        .values(recovery)
        .onConflictDoNothing()
    ).pipe(Effect.asVoid),
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
        .limit(1)
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
      })
    ),
  loadOriginalSession: (sessionToken) =>
    databasePolicy(
      database
        .select({ expiresAt: session.expiresAt, id: session.id })
        .from(session)
        .where(eq(session.token, Redacted.value(sessionToken)))
        .limit(1)
    ).pipe(Effect.map(([loaded]) => Option.fromNullishOr(loaded))),
  loadRecoveries: (originalSessionId) =>
    databasePolicy(
      database
        .select()
        .from(supportImpersonationRecovery)
        .where(
          eq(supportImpersonationRecovery.originalSessionId, originalSessionId)
        )
        .orderBy(asc(supportImpersonationRecovery.createdAt))
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
        .where(eq(session.id, sessionId))
    ).pipe(Effect.asVoid),
});

const authCookieName = (
  configuration: AuthConfigValue,
  suffix: string
): string => {
  const cookie = Cookies.makeCookieUnsafe(
    `${configuration.secureCookies ? SECURE_COOKIE_PREFIX : ''}better-auth.${suffix}`,
    '',
    {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: configuration.secureCookies,
    }
  );
  return cookie.name;
};
const serializeAuthCookie = (
  configuration: AuthConfigValue,
  suffix: string,
  value: string,
  options: { readonly expires?: Date; readonly maxAge?: Duration.Input } = {}
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
    ])
  )[0] ?? '';
const clearAuthCookies = (configuration: AuthConfigValue): readonly string[] =>
  ['session_token', 'session_data', 'admin_session', 'dont_remember'].map(
    (suffix) =>
      serializeAuthCookie(configuration, suffix, '', {
        expires: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
        maxAge: '0 seconds',
      })
  );
const decodeSignedCookie = Effect.fn('decodeSignedCookie')(
  function* decodeSignedCookieEffect(
    requestHeaders: Headers,
    cookieName: string,
    secret: Redacted.Redacted
  ) {
    const encoded = parseCookies(requestHeaders.get('cookie') ?? '').get(
      cookieName
    );
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
    return constantTimeEqual(signature, expected)
      ? Option.some(value)
      : Option.none();
  }
);
const encodeSignedCookie = Effect.fn('encodeSignedCookie')(
  function* encodeSignedCookieEffect(value: string, secret: Redacted.Redacted) {
    const signature = yield* Effect.tryPromise({
      catch: unavailable,
      try: makeSignature.bind(undefined, value, Redacted.value(secret)),
    }).pipe(impersonationTimeout);
    return `${value}.${signature}`;
  }
);

const recoveryFromSession = Effect.fn('recoveryFromSession')(
  function* recoveryFromSessionEffect(currentSession: SupportProviderSession) {
    const tenantId = currentSession.activeTenantId;
    const actionId = currentSession.impersonationActionId;
    const originalAuthBindingId =
      currentSession.impersonationOriginalAuthBindingId;
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
  }
);

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

export const makeSupportImpersonationService = (
  context: Context.Context<SupportImpersonationRequirements>
) => {
  const actionRuntime: ActionRuntimeService = Context.get(
    context,
    ActionRuntime
  );
  const authentication: AuthenticationServiceContract = Context.get(
    context,
    AuthenticationService
  );
  const configuration = Context.get(context, AuthConfig);
  const resolver: PrincipalResolverService = Context.get(
    context,
    PrincipalResolver
  );
  const supportRecoveryPrincipal: SupportRecoveryPrincipalContextResolverService =
    Context.get(context, SupportRecoveryPrincipalContextResolver);
  const auth = Context.get(context, SupportAuthProviderService);
  const store = Context.get(context, SupportImpersonationStoreService);
  const secret = Redacted.make(configuration.secret);
  const checkpoint = Effect.fn('makeSupportImpersonationService.checkpoint')(
    function* checkpointEffect(input: SupportCheckpointInput) {
      const correlationId = yield* SupportImpersonationCorrelationId;
      yield* actionRuntime
        .runAction({
          payload: input.payload,
          principal: input.principal,
          registration: recordSupportImpersonationAction,
          transport: { correlationId, idempotencyKey: input.idempotencyKey },
        })
        .pipe(Effect.asVoid);
    }
  );
  const loadExpiredImpersonationRecovery = Effect.fn(
    'makeSupportImpersonationService.loadExpiredImpersonationRecovery'
  )(function* loadExpiredImpersonationRecoveryEffect(requestHeaders: Headers) {
    const sessionToken = yield* decodeSignedCookie(
      requestHeaders,
      authCookieName(configuration, 'session_token'),
      secret
    );
    if (Option.isNone(sessionToken)) {
      return Option.none();
    }
    return yield* store.loadExpiredRecovery(Redacted.make(sessionToken.value));
  });
  const restoredSessionCookies = Effect.fn(
    'makeSupportImpersonationService.restoredSessionCookies'
  )(function* restoredSessionCookiesEffect(
    originalSessionToken: Redacted.Redacted,
    dontRememberFlag: string | undefined,
    expiresAtEpochMillis: number,
    nowEpochMillis: number
  ) {
    const sessionCookie = yield* encodeSignedCookie(
      Redacted.value(originalSessionToken),
      secret
    );
    const maxAge = Math.max(
      0,
      Math.floor((expiresAtEpochMillis - nowEpochMillis) / 1000)
    );
    const remembered =
      dontRememberFlag === undefined || dontRememberFlag.length === 0;
    const restoredCookie = serializeAuthCookie(
      configuration,
      'session_token',
      sessionCookie,
      remembered ? { maxAge: `${maxAge} seconds` } : {}
    );
    const dontRememberCookie = remembered
      ? Option.none()
      : Option.some(
          serializeAuthCookie(
            configuration,
            'dont_remember',
            yield* encodeSignedCookie('true', secret)
          )
        );
    return [
      restoredCookie,
      ...(Option.isSome(dontRememberCookie) ? [dontRememberCookie.value] : []),
      ...clearAuthCookies(configuration).filter(
        (header) =>
          !header.startsWith(
            `${authCookieName(configuration, 'session_token')}=`
          ) &&
          (Option.isNone(dontRememberCookie) ||
            !header.startsWith(
              `${authCookieName(configuration, 'dont_remember')}=`
            ))
      ),
    ];
  });
  const recoverOriginalSession = Effect.fn(
    'makeSupportImpersonationService.recoverOriginalSession'
  )(function* recoverOriginalSessionEffect(requestHeaders: Headers) {
    const adminCookieName = authCookieName(configuration, 'admin_session');
    const hasAdminCookie = parseCookies(requestHeaders.get('cookie') ?? '').has(
      adminCookieName
    );
    if (!hasAdminCookie) {
      return { state: 'absent' as const };
    }
    const signedValue = yield* decodeSignedCookie(
      requestHeaders,
      adminCookieName,
      secret
    );
    if (Option.isNone(signedValue)) {
      return { state: 'invalid' as const };
    }
    const [originalSessionToken, dontRememberFlag] =
      signedValue.value.split(':');
    if (
      originalSessionToken === undefined ||
      originalSessionToken.length === 0
    ) {
      return { state: 'invalid' as const };
    }
    const original = yield* store.loadOriginalSession(
      Redacted.make(originalSessionToken)
    );
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
        nowEpochMillis
      ),
      state: 'restored' as const,
    };
  });
  const terminateImpersonationSession = (impersonationSessionId: string) =>
    store.deleteSession(impersonationSessionId);
  const completeRecovery = Effect.fn(
    'makeSupportImpersonationService.completeRecovery'
  )(function* completeRecoveryEffect(input: CompleteRecoveryInput) {
    if (!input.sessionTerminated) {
      const terminationExit = yield* Effect.exit(
        terminateImpersonationSession(input.recovery.impersonationSessionId)
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
      })
    );
    if (Exit.isFailure(originalPrincipalExit)) {
      return {
        active: false as const,
        checkpointPending: true as const,
        setCookieHeaders: input.setCookieHeaders,
      };
    }
    const originalPrincipal = originalPrincipalExit.value;
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
      }).pipe(Effect.catchTag('ActionAlreadyCommitted', () => Effect.void))
    );
    if (Exit.isFailure(checkpointExit)) {
      return {
        active: false as const,
        checkpointPending: true as const,
        setCookieHeaders: input.setCookieHeaders,
      };
    }
    const cleanupExit = yield* Effect.exit(
      store.deleteRecovery(input.recovery.impersonationSessionId)
    );
    return {
      active: false as const,
      checkpointPending: Exit.isFailure(cleanupExit),
      setCookieHeaders: input.setCookieHeaders,
    };
  });
  const stopAbsentSession = Effect.fn(
    'makeSupportImpersonationService.stopAbsentSession'
  )(function* stopAbsentSessionEffect(
    requestHeaders: Headers,
    headers: Headers
  ) {
    const [expiredRecovery, recovered] = yield* Effect.all(
      [
        loadExpiredImpersonationRecovery(requestHeaders),
        recoverOriginalSession(requestHeaders),
      ],
      { concurrency: 2 }
    );
    if (Option.isSome(expiredRecovery)) {
      yield* store.insertRecovery(expiredRecovery.value);
      yield* terminateImpersonationSession(
        expiredRecovery.value.impersonationSessionId
      );
      const restoredMatches =
        (recovered.state === 'restored' || recovered.state === 'expired') &&
        recovered.originalSessionId === expiredRecovery.value.originalSessionId;
      return yield* completeRecovery({
        recovery: expiredRecovery.value,
        restoredSessionId: expiredRecovery.value.originalSessionId,
        sessionTerminated: true,
        setCookieHeaders: restoredMatches
          ? recovered.setCookieHeaders
          : clearAuthCookies(configuration),
      });
    }
    if (recovered.state === 'restored' || recovered.state === 'expired') {
      const recoveries = yield* store.loadRecoveries(
        recovered.originalSessionId
      );
      const outcomes = yield* Effect.forEach(
        recoveries,
        (recovery) =>
          completeRecovery({
            recovery,
            restoredSessionId: recovered.originalSessionId,
            sessionTerminated: false,
            setCookieHeaders: recovered.setCookieHeaders,
          }),
        { concurrency: 1 }
      );
      return {
        active: false as const,
        checkpointPending: outcomes.some(
          (outcome) => outcome.checkpointPending
        ),
        setCookieHeaders: recovered.setCookieHeaders,
      };
    }
    return {
      active: false as const,
      checkpointPending: recovered.state === 'invalid',
      setCookieHeaders:
        recovered.state === 'invalid'
          ? clearAuthCookies(configuration)
          : cookieHeaders(headers),
    };
  });
  return Object.freeze({
    start: Effect.fn('makeSupportImpersonationService.start')(
      function* startSupportImpersonationEffect(
        input: StartSupportImpersonationInput
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
        const originalSessionId = shell.principal.authContextRef.slice(
          'better-auth-session:'.length
        );
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
        yield* checkpoint({
          idempotencyKey: `${input.idempotencyKey}:requested`,
          payload: {
            checkpoint: 'requested',
            originalPrincipalId: shell.principal.principalId,
            reason,
            targetPrincipalId: input.targetPrincipalId,
          },
          principal: shell.principal,
        });
        const created = yield* providerOperation(
          auth.api.impersonateUser.bind(auth.api, {
            body: { userId: targetUserId },
            headers: input.requestHeaders,
            returnHeaders: true,
          })
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
              store
                .deleteSession(created.response.session.id)
                .pipe(Effect.ignore, Effect.andThen(Effect.fail(error)))
            )
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
                Effect.andThen(Effect.fail(error))
              )
            )
          );
        const started = checkpoint({
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
                store.deleteRecovery(created.response.session.id),
              ],
              { concurrency: 1, discard: true }
            ).pipe(Effect.ignore, Effect.andThen(Effect.fail(error)))
          )
        );
        return {
          active: true as const,
          setCookieHeaders: cookieHeaders(created.headers),
          targetPrincipalId: input.targetPrincipalId,
        };
      }
    ),
    stop: Effect.fn('makeSupportImpersonationService.stop')(
      function* stopSupportImpersonationEffect(
        input: StopSupportImpersonationInput
      ) {
        const current = yield* providerOperation(
          auth.api.getSession.bind(auth.api, {
            headers: input.requestHeaders,
            returnHeaders: true,
          })
        );
        if (current.response === null) {
          return yield* stopAbsentSession(
            input.requestHeaders,
            current.headers
          );
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
            { concurrency: 1 }
          );
          return {
            active: false as const,
            checkpointPending: outcomes.some(
              (outcome) => outcome.checkpointPending
            ),
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
            })
          )
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
      }
    ),
  });
};

export type SupportImpersonationServiceContract = ReturnType<
  typeof makeSupportImpersonationService
>;

export class SupportImpersonationService extends Context.Service<
  SupportImpersonationService,
  SupportImpersonationServiceContract
>()(
  '@app/shell-super-app/api/auth/impersonation-service/SupportImpersonationService'
) {}

export const SupportImpersonationServiceLive = Layer.effect(
  SupportImpersonationService,
  Effect.gen(function* supportImpersonationServiceLive() {
    const actionRuntime = yield* ActionRuntime;
    const authentication = yield* AuthenticationService;
    const configuration = yield* AuthConfig;
    const database = yield* AuthDatabase;
    const resolver = yield* PrincipalResolver;
    const supportRecoveryPrincipal =
      yield* SupportRecoveryPrincipalContextResolver;
    const context = Context.empty().pipe(
      Context.add(ActionRuntime, actionRuntime),
      Context.add(AuthenticationService, authentication),
      Context.add(AuthConfig, configuration),
      Context.add(PrincipalResolver, resolver),
      Context.add(
        SupportRecoveryPrincipalContextResolver,
        supportRecoveryPrincipal
      ),
      Context.add(
        SupportAuthProviderService,
        makeSupportAuthProvider(configuration, database.adapter)
      ),
      Context.add(
        SupportImpersonationStoreService,
        makeSupportImpersonationStore(database.executor)
      )
    );
    return makeSupportImpersonationService(context);
  })
);
