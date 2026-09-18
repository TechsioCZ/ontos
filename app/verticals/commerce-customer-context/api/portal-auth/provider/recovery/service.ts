import { Context, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';

import { COMMERCE_PORTAL_AUTH_POLICY } from '../config.ts';
import {
  CommercePortalAuthEmailVerificationRequestSchema,
  CommercePortalAuthEmailVerificationTokenSchema,
  CommercePortalAuthPasswordResetRequestSchema,
  CommercePortalAuthPasswordResetSchema,
  CommercePortalAuthProviderSubjectIdSchema,
} from './contracts.ts';
import type {
  CommercePortalAuthEmailVerificationRequestBoundary,
  CommercePortalAuthEmailVerificationStarted,
  CommercePortalAuthEmailVerificationCompleted,
  CommercePortalAuthEmailVerificationTokenBoundary,
  CommercePortalAuthEmailVerificationTokenRegistration,
  CommercePortalAuthRecoveryCompleted,
  CommercePortalAuthRecoveryStarted,
  CommercePortalAuthPasswordResetRequestBoundary,
  CommercePortalAuthPasswordResetBoundary,
} from './contracts.ts';
import { CommercePortalAuthRecoveryInvalidRequest } from './invalid-request.ts';
import type { CommercePortalAuthRecoveryProviderFailure } from './provider-failure.ts';
import { CommercePortalAuthRecoveryProviderService } from './provider-service.ts';
import { CommercePortalAuthRecoveryStoreService } from './store-service.ts';
import { CommercePortalAuthRecoveryRejected } from './rejected.ts';
import { CommercePortalAuthRecoveryUnavailable } from './unavailable.ts';

export type CommercePortalAuthRecoveryFailure =
  | CommercePortalAuthRecoveryInvalidRequest
  | CommercePortalAuthRecoveryRejected
  | CommercePortalAuthRecoveryUnavailable;

const RecoveryResponseSchema = Schema.Struct({ status: Schema.Boolean });
const SEND_VERIFICATION_EMAIL_OPERATION = 'send-verification-email';

const RATE_LIMIT_CODES = new Set(['RATE_LIMITED', 'TOO_MANY_REQUESTS']);
const REQUEST_REJECTION_CODES = new Set([
  'EMAIL_ALREADY_VERIFIED',
  'EMAIL_MISMATCH',
  'INVALID_EMAIL',
  'USER_NOT_FOUND',
]);
const RESET_REJECTION_CODES = new Set(['INVALID_TOKEN', 'PASSWORD_TOO_LONG', 'PASSWORD_TOO_SHORT', 'USER_NOT_FOUND']);

const withCause = <TError extends object>(error: TError, cause: unknown): TError =>
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });

const mapProviderFailure = (
  failure: CommercePortalAuthRecoveryProviderFailure,
  rejectionCodes: ReadonlySet<string>,
): CommercePortalAuthRecoveryRejected | CommercePortalAuthRecoveryUnavailable => {
  const code = failure.providerCode;
  let mappedCode: 'INVALID_TOKEN' | 'PROVIDER_REJECTED' | 'RATE_LIMITED' = 'PROVIDER_REJECTED';
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) {
    mappedCode = 'RATE_LIMITED';
  } else if (code === 'INVALID_TOKEN' && rejectionCodes.has(code)) {
    mappedCode = 'INVALID_TOKEN';
  }
  const rejected =
    code !== undefined && (rejectionCodes.has(code) || RATE_LIMIT_CODES.has(code))
      ? new CommercePortalAuthRecoveryRejected({
          code: mappedCode,
          operation: failure.operation,
          reason: 'The Commerce portal authentication provider rejected the recovery request',
        })
      : new CommercePortalAuthRecoveryUnavailable({
          operation: failure.operation,
          reason: 'The Commerce portal authentication provider is unavailable',
        });
  return withCause(rejected, failure);
};

const invalidRequest = (cause: unknown): CommercePortalAuthRecoveryInvalidRequest =>
  withCause(
    new CommercePortalAuthRecoveryInvalidRequest({
      reason: 'The Commerce portal authentication recovery input is invalid',
    }),
    cause,
  );

const rejected = (
  operation: string,
  code: 'INVALID_TOKEN' | 'INVALID_SUBJECT' | 'PROVIDER_REJECTED' | 'RATE_LIMITED',
  reason: string,
): CommercePortalAuthRecoveryRejected => new CommercePortalAuthRecoveryRejected({ code, operation, reason });

const unavailable = (operation: string, cause: unknown): CommercePortalAuthRecoveryUnavailable =>
  withCause(
    new CommercePortalAuthRecoveryUnavailable({
      operation,
      reason: 'Commerce portal authentication recovery is unavailable',
    }),
    cause,
  );

const normalizeEmail = (email: string): string => email.toLowerCase();

const expirationFrom = (now: Date): Date =>
  DateTime.toDate(
    DateTime.add(DateTime.makeUnsafe(now), {
      seconds: COMMERCE_PORTAL_AUTH_POLICY.emailVerification.expiresInSeconds,
    }),
  );

export class CommercePortalAuthRecoveryService extends Context.Service<
  CommercePortalAuthRecoveryService,
  {
    /** Called by the Better Auth email callback before delivery; the token is retained only as a digest. */
    readonly registerEmailVerificationToken: (
      input: CommercePortalAuthEmailVerificationTokenRegistration,
    ) => Effect.Effect<void, CommercePortalAuthRecoveryFailure>;
    readonly requestEmailVerification: (
      input: CommercePortalAuthEmailVerificationRequestBoundary,
    ) => Effect.Effect<CommercePortalAuthEmailVerificationStarted, CommercePortalAuthRecoveryFailure>;
    readonly requestPasswordReset: (
      input: CommercePortalAuthPasswordResetRequestBoundary,
    ) => Effect.Effect<CommercePortalAuthRecoveryStarted, CommercePortalAuthRecoveryFailure>;
    readonly resetPassword: (
      input: CommercePortalAuthPasswordResetBoundary,
    ) => Effect.Effect<CommercePortalAuthRecoveryCompleted, CommercePortalAuthRecoveryFailure>;
    readonly verifyEmail: (
      input: CommercePortalAuthEmailVerificationTokenBoundary,
    ) => Effect.Effect<CommercePortalAuthEmailVerificationCompleted, CommercePortalAuthRecoveryFailure>;
  }
>()('@app/commerce-customer-context/api/portal-auth/provider/recovery/service/CommercePortalAuthRecoveryService') {}

/**
 * Provider recovery stays separate from Core identity/business state. Better Auth's password
 * reset endpoint consumes its row atomically; its row value is the original user.id, so this
 * adapter never performs an email lookup during reset and never returns that subject to callers.
 */
export const makeCommercePortalAuthRecoveryService = Effect.fn('CommercePortalAuthRecovery.make')(
  function* makeCommercePortalAuthRecoveryServiceEffect(): Effect.fn.Return<
    CommercePortalAuthRecoveryService['Service'],
    never,
    CommercePortalAuthRecoveryProviderService | CommercePortalAuthRecoveryStoreService
  > {
    const provider = yield* CommercePortalAuthRecoveryProviderService;
    const store = yield* CommercePortalAuthRecoveryStoreService;

    const requestPasswordReset = Effect.fn('CommercePortalAuthRecovery.requestPasswordReset')(
      function* requestPasswordResetEffect(
        input: CommercePortalAuthPasswordResetRequestBoundary,
      ): Effect.fn.Return<CommercePortalAuthRecoveryStarted, CommercePortalAuthRecoveryFailure> {
        const request = yield* Schema.decodeEffect(CommercePortalAuthPasswordResetRequestSchema)(input).pipe(
          Effect.mapError(invalidRequest),
        );
        const response = yield* provider
          .requestPasswordReset({ body: { email: normalizeEmail(request.email) } })
          .pipe(Effect.mapError((failure) => mapProviderFailure(failure, REQUEST_REJECTION_CODES)));
        const decoded = yield* Schema.decodeEffect(RecoveryResponseSchema)(response).pipe(
          Effect.mapError((cause) => unavailable('request-password-reset', cause)),
        );
        if (!decoded.status) {
          return yield* rejected(
            'request-password-reset',
            'PROVIDER_REJECTED',
            'The Commerce portal authentication provider rejected the recovery request',
          );
        }
        return { outcome: 'ACCOUNT_RECOVERY_STARTED' };
      },
    );

    const resetPassword = Effect.fn('CommercePortalAuthRecovery.resetPassword')(function* resetPasswordEffect(
      input: CommercePortalAuthPasswordResetBoundary,
    ): Effect.fn.Return<CommercePortalAuthRecoveryCompleted, CommercePortalAuthRecoveryFailure> {
      const request = yield* Schema.decodeEffect(CommercePortalAuthPasswordResetSchema)(input).pipe(
        Effect.mapError(invalidRequest),
      );
      const response = yield* provider
        .resetPassword({
          body: {
            newPassword: Redacted.value(request.newPassword),
            token: Redacted.value(request.token),
          },
        })
        .pipe(Effect.mapError((failure) => mapProviderFailure(failure, RESET_REJECTION_CODES)));
      const decoded = yield* Schema.decodeEffect(RecoveryResponseSchema)(response).pipe(
        Effect.mapError((cause) => unavailable('reset-password', cause)),
      );
      if (!decoded.status) {
        return yield* rejected(
          'reset-password',
          'PROVIDER_REJECTED',
          'The Commerce portal authentication provider rejected the recovery token',
        );
      }
      return { outcome: 'ACCOUNT_RECOVERY_COMPLETED_SAME_SUBJECT' };
    });

    const requestEmailVerification = Effect.fn('CommercePortalAuthRecovery.requestEmailVerification')(
      function* requestEmailVerificationEffect(
        input: CommercePortalAuthEmailVerificationRequestBoundary,
      ): Effect.fn.Return<CommercePortalAuthEmailVerificationStarted, CommercePortalAuthRecoveryFailure> {
        const request = yield* Schema.decodeEffect(CommercePortalAuthEmailVerificationRequestSchema)(input).pipe(
          Effect.mapError(invalidRequest),
        );
        const reserved = yield* store.reserveEmailVerificationSubject({
          email: normalizeEmail(request.email),
          providerSubjectId: request.providerSubjectId,
        });
        if (!reserved) {
          return yield* rejected(
            SEND_VERIFICATION_EMAIL_OPERATION,
            'INVALID_SUBJECT',
            'The Commerce portal authentication subject does not own this identifier',
          );
        }
        const response = yield* provider
          .sendVerificationEmail({ body: { email: normalizeEmail(request.email) } })
          .pipe(Effect.mapError((failure) => mapProviderFailure(failure, REQUEST_REJECTION_CODES)));
        const decoded = yield* Schema.decodeEffect(RecoveryResponseSchema)(response).pipe(
          Effect.mapError((cause) => unavailable(SEND_VERIFICATION_EMAIL_OPERATION, cause)),
        );
        if (!decoded.status) {
          return yield* rejected(
            SEND_VERIFICATION_EMAIL_OPERATION,
            'PROVIDER_REJECTED',
            'The Commerce portal authentication provider rejected the verification request',
          );
        }
        return { outcome: 'EMAIL_VERIFICATION_STARTED' };
      },
    );

    const registerEmailVerificationToken = Effect.fn('CommercePortalAuthRecovery.registerEmailVerificationToken')(
      function* registerEmailVerificationTokenEffect(
        input: CommercePortalAuthEmailVerificationTokenRegistration,
      ): Effect.fn.Return<void, CommercePortalAuthRecoveryFailure> {
        const metadata = yield* Schema.decodeEffect(
          Schema.Struct({ email: Schema.String, providerSubjectId: CommercePortalAuthProviderSubjectIdSchema }),
        )({ email: input.email, providerSubjectId: input.providerSubjectId }).pipe(Effect.mapError(invalidRequest));
        yield* Schema.decodeEffect(CommercePortalAuthEmailVerificationTokenSchema)({ token: input.token }).pipe(
          Effect.mapError(invalidRequest),
        );
        const now = yield* DateTime.nowAsDate;
        const registered = yield* store.registerEmailVerificationToken({
          email: normalizeEmail(metadata.email),
          expiresAt: expirationFrom(now),
          providerSubjectId: metadata.providerSubjectId,
          token: input.token,
        });
        if (!registered) {
          return yield* rejected(
            'register-verification-token',
            'INVALID_SUBJECT',
            'The Commerce portal authentication subject could not be bound to this identifier',
          );
        }
        return undefined;
      },
    );

    const verifyEmail = Effect.fn('CommercePortalAuthRecovery.verifyEmail')(function* verifyEmailEffect(
      input: CommercePortalAuthEmailVerificationTokenBoundary,
    ): Effect.fn.Return<CommercePortalAuthEmailVerificationCompleted, CommercePortalAuthRecoveryFailure> {
      const request = yield* Schema.decodeEffect(CommercePortalAuthEmailVerificationTokenSchema)(input).pipe(
        Effect.mapError(invalidRequest),
      );
      const now = yield* DateTime.nowAsDate;
      const subject = yield* store.consumeEmailVerification({ now, token: request.token });
      if (Option.isNone(subject)) {
        return yield* rejected(
          'verify-email',
          'INVALID_TOKEN',
          'The Commerce portal email verification token is invalid, expired, or already consumed',
        );
      }
      return { outcome: 'EMAIL_VERIFICATION_COMPLETED_SAME_SUBJECT' };
    });

    return {
      registerEmailVerificationToken,
      requestEmailVerification,
      requestPasswordReset,
      resetPassword,
      verifyEmail,
    };
  },
);

/** The recovery provider and store ports stay visible requirements for the composition root. */
export const CommercePortalAuthRecoveryServiceLive = Layer.effect(
  CommercePortalAuthRecoveryService,
  makeCommercePortalAuthRecoveryService(),
);
