import { Context, DateTime, Effect, Option, Redacted, Schema } from 'effect';

import { auditedLayer, commercePortalAuthAuditEmitter } from '../../../../src/portal-auth/audit/audit.ts';
import { withCause } from '../../problems-support.ts';
import { normalizeCommercePortalAuthEmail } from '../../../../src/portal-auth/email-normalization.ts';
import type { CommercePortalAuthAuditRecorder } from '../../../../src/portal-auth/audit/audit.ts';
import type { CommercePortalAuthAuditEvent } from '../../../../src/portal-auth/audit/audit-contracts.ts';
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
  CommercePortalAuthRecoveryReconciliationRequired,
  CommercePortalAuthRecoveryStarted,
  CommercePortalAuthPasswordResetRequestBoundary,
  CommercePortalAuthPasswordResetBoundary,
} from './contracts.ts';
import { CommercePortalAuthRecoveryInvalidRequest } from './invalid-request.ts';
import type { CommercePortalAuthRecoveryProviderFailure } from './provider-failure.ts';
import { CommercePortalAuthRecoveryProviderService } from './provider-service.ts';
import { CommercePortalAuthRecoveryReconciliationService } from './reconciliation.ts';
import { CommercePortalAuthRecoveryStoreService } from './store-service.ts';
import { CommercePortalAuthRecoveryRejected } from './rejected.ts';
import { CommercePortalAuthRecoveryUnavailable } from './unavailable.ts';

export type CommercePortalAuthRecoveryFailure =
  | CommercePortalAuthRecoveryInvalidRequest
  | CommercePortalAuthRecoveryRejected
  | CommercePortalAuthRecoveryUnavailable;

const RecoveryResponseSchema = Schema.Struct({ status: Schema.Boolean });
const SEND_VERIFICATION_EMAIL_OPERATION = 'send-verification-email';
const RECOVERY_REQUEST_OPERATION = 'request-password-reset';
const RECOVERY_RESET_OPERATION = 'reset-password';
const VERIFY_EMAIL_OPERATION = 'verify-email';

const RATE_LIMIT_CODES = new Set(['RATE_LIMITED', 'TOO_MANY_REQUESTS']);
const REQUEST_REJECTION_CODES = new Set([
  'EMAIL_ALREADY_VERIFIED',
  'EMAIL_MISMATCH',
  'INVALID_EMAIL',
  'USER_NOT_FOUND',
]);
const RESET_REJECTION_CODES = new Set(['INVALID_TOKEN', 'PASSWORD_TOO_LONG', 'PASSWORD_TOO_SHORT', 'USER_NOT_FOUND']);

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
    ) => Effect.Effect<
      CommercePortalAuthRecoveryCompleted | CommercePortalAuthRecoveryReconciliationRequired,
      CommercePortalAuthRecoveryFailure
    >;
    readonly verifyEmail: (
      input: CommercePortalAuthEmailVerificationTokenBoundary,
    ) => Effect.Effect<
      CommercePortalAuthEmailVerificationCompleted | CommercePortalAuthRecoveryReconciliationRequired,
      CommercePortalAuthRecoveryFailure
    >;
  }
>()('@app/commerce-customer-context/api/portal-auth/provider/recovery/service/CommercePortalAuthRecoveryService') {}

/**
 * Provider recovery stays separate from Core identity/business state. Better Auth's password
 * reset endpoint consumes its row atomically; its row value is the original user.id, so this
 * adapter never performs an email lookup during reset and never returns that subject to callers.
 */
export const makeCommercePortalAuthRecoveryService = Effect.fn('CommercePortalAuthRecovery.make')(
  function* makeCommercePortalAuthRecoveryServiceEffect(
    audit: CommercePortalAuthAuditRecorder,
  ): Effect.fn.Return<
    CommercePortalAuthRecoveryService['Service'],
    never,
    | CommercePortalAuthRecoveryProviderService
    | CommercePortalAuthRecoveryReconciliationService
    | CommercePortalAuthRecoveryStoreService
  > {
    const provider = yield* CommercePortalAuthRecoveryProviderService;
    const store = yield* CommercePortalAuthRecoveryStoreService;
    const reconciliation = yield* CommercePortalAuthRecoveryReconciliationService;
    const emitAudit = commercePortalAuthAuditEmitter(audit);

    /**
     * The strict half of the audit contract, for the two operations here that change durable state.
     * The intent row is written *before* the provider is asked to act and its failure is the
     * caller's failure: a deployment whose audit store is down refuses the reset outright rather
     * than resetting a password and losing the only evidence that it happened. The completion event
     * afterwards may take the lenient path, because this row already proves the attempt reached the
     * provider and names the subject and token it named.
     */
    const recordIntent = Effect.fn('CommercePortalAuthRecovery.recordIntent')(function* recordIntentEffect(
      event: CommercePortalAuthAuditEvent,
    ): Effect.fn.Return<void, CommercePortalAuthRecoveryUnavailable> {
      yield* audit.record(event).pipe(Effect.mapError((cause) => unavailable(event.operation ?? 'audit', cause)));
    });

    const requestPasswordReset = Effect.fn('CommercePortalAuthRecovery.requestPasswordReset')(
      function* requestPasswordResetEffect(
        input: CommercePortalAuthPasswordResetRequestBoundary,
      ): Effect.fn.Return<CommercePortalAuthRecoveryStarted, CommercePortalAuthRecoveryFailure> {
        const request = yield* Schema.decodeEffect(CommercePortalAuthPasswordResetRequestSchema)(input).pipe(
          Effect.mapError(invalidRequest),
        );
        const response = yield* provider
          .requestPasswordReset({ body: { email: normalizeCommercePortalAuthEmail(request.email) } })
          .pipe(Effect.mapError((failure) => mapProviderFailure(failure, REQUEST_REJECTION_CODES)));
        const decoded = yield* Schema.decodeEffect(RecoveryResponseSchema)(response).pipe(
          Effect.mapError((cause) => unavailable(RECOVERY_REQUEST_OPERATION, cause)),
        );
        if (!decoded.status) {
          return yield* rejected(
            RECOVERY_REQUEST_OPERATION,
            'PROVIDER_REJECTED',
            'The Commerce portal authentication provider rejected the recovery request',
          );
        }
        yield* emitAudit({
          eventType: 'commerce.portal-auth.recovery-started.v1',
          occurredAt: yield* DateTime.nowAsDate,
          operation: RECOVERY_REQUEST_OPERATION,
          outcome: 'success',
        });
        return { outcome: 'ACCOUNT_RECOVERY_STARTED' };
      },
    );

    const resetPassword = Effect.fn('CommercePortalAuthRecovery.resetPassword')(function* resetPasswordEffect(
      input: CommercePortalAuthPasswordResetBoundary,
    ): Effect.fn.Return<
      CommercePortalAuthRecoveryCompleted | CommercePortalAuthRecoveryReconciliationRequired,
      CommercePortalAuthRecoveryFailure
    > {
      const request = yield* Schema.decodeEffect(CommercePortalAuthPasswordResetSchema)(input).pipe(
        Effect.mapError(invalidRequest),
      );
      // Reconciliation runs before any token is spent: a conflict is terminal, and the provider's
      // reset must never run once the ledger and the account's current state disagree.
      const conflict = yield* reconciliation.detect({
        operation: RECOVERY_RESET_OPERATION,
        token: request.token,
      });
      if (Option.isSome(conflict)) {
        return conflict.value;
      }
      // The same row reconciliation just cleared, read again for the subject and token digest the
      // evidence rows name. A token with no ledger row is submitted anyway — the provider decides
      // whether it is valid — and its intent row simply names no subject.
      const binding = yield* store.peekPasswordResetLedger({ token: request.token });
      const ledgerSubjectId = Option.isSome(binding) ? binding.value.providerSubjectId : undefined;
      yield* recordIntent({
        correlationDigest: Option.isSome(binding) ? binding.value.tokenDigest : undefined,
        eventType: 'commerce.portal-auth.recovery-reset-requested.v1',
        occurredAt: yield* DateTime.nowAsDate,
        operation: RECOVERY_RESET_OPERATION,
        outcome: 'requested',
        providerSubjectId: ledgerSubjectId,
      });
      const response = yield* provider
        .resetPassword({
          body: {
            newPassword: Redacted.value(request.newPassword),
            token: Redacted.value(request.token),
          },
        })
        .pipe(Effect.mapError((failure) => mapProviderFailure(failure, RESET_REJECTION_CODES)));
      const decoded = yield* Schema.decodeEffect(RecoveryResponseSchema)(response).pipe(
        Effect.mapError((cause) => unavailable(RECOVERY_RESET_OPERATION, cause)),
      );
      if (!decoded.status) {
        return yield* rejected(
          RECOVERY_RESET_OPERATION,
          'PROVIDER_REJECTED',
          'The Commerce portal authentication provider rejected the recovery token',
        );
      }
      yield* store.consumePasswordResetLedger({ token: request.token });
      yield* emitAudit({
        correlationDigest: Option.isSome(binding) ? binding.value.tokenDigest : undefined,
        eventType: 'commerce.portal-auth.recovery-completed.v1',
        occurredAt: yield* DateTime.nowAsDate,
        operation: RECOVERY_RESET_OPERATION,
        outcome: 'success',
        providerSubjectId: ledgerSubjectId,
      });
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
          email: normalizeCommercePortalAuthEmail(request.email),
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
          .sendVerificationEmail({ body: { email: normalizeCommercePortalAuthEmail(request.email) } })
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
          email: normalizeCommercePortalAuthEmail(metadata.email),
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
    ): Effect.fn.Return<
      CommercePortalAuthEmailVerificationCompleted | CommercePortalAuthRecoveryReconciliationRequired,
      CommercePortalAuthRecoveryFailure
    > {
      const request = yield* Schema.decodeEffect(CommercePortalAuthEmailVerificationTokenSchema)(input).pipe(
        Effect.mapError(invalidRequest),
      );
      // Reconciliation runs before the ledger token is consumed: a conflict is terminal, and access
      // must never be restored once the ledger and the account's current state disagree.
      const conflict = yield* reconciliation.detect({
        operation: VERIFY_EMAIL_OPERATION,
        token: request.token,
      });
      if (Option.isSome(conflict)) {
        return conflict.value;
      }
      // Consuming the token marks the address verified, so the intent row goes in first: an audit
      // store that cannot answer refuses the verification rather than restoring access silently.
      const binding = yield* store.peekEmailVerificationLedger({ token: request.token });
      yield* recordIntent({
        correlationDigest: Option.isSome(binding) ? binding.value.tokenDigest : undefined,
        eventType: 'commerce.portal-auth.email-verification-requested.v1',
        occurredAt: yield* DateTime.nowAsDate,
        operation: VERIFY_EMAIL_OPERATION,
        outcome: 'requested',
        providerSubjectId: Option.isSome(binding) ? binding.value.providerSubjectId : undefined,
      });
      const now = yield* DateTime.nowAsDate;
      const subject = yield* store.consumeEmailVerification({ now, token: request.token });
      if (Option.isNone(subject)) {
        return yield* rejected(
          VERIFY_EMAIL_OPERATION,
          'INVALID_TOKEN',
          'The Commerce portal email verification token is invalid, expired, or already consumed',
        );
      }
      yield* emitAudit({
        correlationDigest: Option.isSome(binding) ? binding.value.tokenDigest : undefined,
        eventType: 'commerce.portal-auth.email-verification-consumed.v1',
        occurredAt: yield* DateTime.nowAsDate,
        operation: VERIFY_EMAIL_OPERATION,
        outcome: 'success',
        providerSubjectId: subject.value,
      });
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

/**
 * The recovery provider, store and reconciliation ports stay visible requirements for the
 * composition root: `api/index.ts` already publishes `CommercePortalAuthRecoveryReconciliationServiceLive`
 * one tier beneath this layer, beside the owner store it is built from, precisely so this service
 * can read it here rather than each owning its own private copy.
 */
export const CommercePortalAuthRecoveryServiceLive = auditedLayer(
  CommercePortalAuthRecoveryService,
  makeCommercePortalAuthRecoveryService,
);
