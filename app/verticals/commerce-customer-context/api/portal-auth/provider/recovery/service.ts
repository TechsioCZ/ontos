import { Context, DateTime, Effect, Option, Redacted, Result, Schema } from 'effect';

import { auditedLayer } from '../../../../src/portal-auth/audit/audit.ts';
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
const RECOVERY_STARTED_EVENT_TYPE = 'commerce.portal-auth.recovery-started.v1';
const RESET_REJECTION_CODES = new Set(['INVALID_TOKEN', 'PASSWORD_TOO_LONG', 'PASSWORD_TOO_SHORT', 'USER_NOT_FOUND']);
/**
 * Rejections Better Auth judges before it consumes its own token row, so the token is provably still
 * spendable and the dispatch claim taken for it must be given back.
 */
const RESET_UNSPENT_REJECTION_CODES = new Set(['PASSWORD_TOO_LONG', 'PASSWORD_TOO_SHORT']);
/**
 * Rejections that answer exactly as an already-spent token would: `INVALID_TOKEN` looks like a
 * completed earlier reset, and `USER_NOT_FOUND` can only occur after the token row is gone.
 */
const RESET_INDETERMINATE_REJECTION_CODES = new Set(['INVALID_TOKEN', 'USER_NOT_FOUND']);

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

    /**
     * The strict half of the audit contract, for the two operations here that change durable state.
     * The intent row is written *before* the provider is asked to act and its failure is the
     * caller's failure: a deployment whose audit store is down refuses the reset outright rather
     * than resetting a password and losing the only evidence that it happened.
     *
     * Both completion rows are stricter still: they commit inside the same transaction that retires
     * the spent token (`consumePasswordResetLedgerWithAudit`, `consumeEmailVerificationWithAudit`),
     * so neither half of either pair can stand alone. Email verification's flip is the more urgent
     * of the two — unlike a reset, nothing external was already asked to act — so a refused audit
     * write there rolls the flip back rather than leaving it unevidenced.
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
        const request = yield* Schema.decodeEffect(CommercePortalAuthPasswordResetRequestSchema, {
          onExcessProperty: 'error',
        })(input).pipe(Effect.mapError(invalidRequest));
        // The provider sends mail and registers a token; both rows are strict so neither can happen
        // behind an audit trail with no row for it. No subject: the answer must not enumerate.
        yield* recordIntent({
          eventType: RECOVERY_STARTED_EVENT_TYPE,
          occurredAt: yield* DateTime.nowAsDate,
          operation: RECOVERY_REQUEST_OPERATION,
          outcome: 'requested',
        });
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
        yield* recordIntent({
          eventType: RECOVERY_STARTED_EVENT_TYPE,
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
      const request = yield* Schema.decodeEffect(CommercePortalAuthPasswordResetSchema, { onExcessProperty: 'error' })(
        input,
      ).pipe(Effect.mapError(invalidRequest));
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
      const correlationDigest = Option.isSome(binding) ? binding.value.tokenDigest : undefined;
      const ledgerSubjectId = Option.isSome(binding) ? binding.value.providerSubjectId : undefined;
      yield* recordIntent({
        correlationDigest,
        eventType: 'commerce.portal-auth.recovery-reset-requested.v1',
        occurredAt: yield* DateTime.nowAsDate,
        operation: RECOVERY_RESET_OPERATION,
        outcome: 'requested',
        providerSubjectId: ledgerSubjectId,
      });
      // Claim before dispatch. Better Auth consumes its own token row atomically inside
      // `resetPassword`, so a call that never answers may still have committed the new password.
      // The claim is taken first and in its own transaction, which makes it survive exactly the
      // failures that lose the answer; a store that cannot take it refuses before the provider is
      // ever asked, because an unclaimed dispatch is the case nothing can reconstruct afterwards.
      const claim = yield* store.dispatchPasswordResetLedger({ token: request.token });
      if (claim === 'already-dispatched') {
        // Somebody else already holds the claim, so this caller can't know their outcome and must
        // not spend the token a second time; answer as the reconciliation the holder already owns.
        const contended = yield* reconciliation.recordIndeterminateReset({ token: request.token });
        if (Option.isSome(contended)) {
          return contended.value;
        }
        // The holder settled the row since the refused claim, so the token really is spent.
        return yield* rejected(
          RECOVERY_RESET_OPERATION,
          'INVALID_TOKEN',
          'The Commerce portal authentication recovery token has already been spent',
        );
      }
      // The failure is read before it is mapped, since the mapped rejection collapses to
      // `PROVIDER_REJECTED` and loses the code this branch needs to judge.
      const attempt = yield* Effect.result(
        provider.resetPassword({
          body: {
            newPassword: Redacted.value(request.newPassword),
            token: Redacted.value(request.token),
          },
        }),
      );
      if (Result.isFailure(attempt)) {
        const { providerCode } = attempt.failure;
        const failure = mapProviderFailure(attempt.failure, RESET_REJECTION_CODES);
        if (providerCode !== undefined && RESET_UNSPENT_REJECTION_CODES.has(providerCode)) {
          // The provider refused before it reached the token, so the link is still good; release the
          // claim or the customer's corrected retry can never find its row.
          const released = yield* Effect.result(store.releasePasswordResetLedger({ token: request.token }));
          if (Result.isFailure(released)) {
            // Leave the row claimed: a support reconciliation is the conservative answer when this
            // realm can't confirm the release, safer than a confident rejection of a valid link.
            yield* Effect.annotateLogs(
              Effect.logError('Commerce portal recovery reset claim was not released', released.failure),
              { operation: RECOVERY_RESET_OPERATION },
            );
          }
          return yield* failure;
        }
        // A rejection that could equally follow an already-spent token hides a likely completed reset
        // behind a confident refusal, so record the indeterminate outcome instead.
        if (providerCode !== undefined && RESET_INDETERMINATE_REJECTION_CODES.has(providerCode)) {
          const indeterminate = yield* reconciliation.recordIndeterminateReset({ token: request.token });
          if (Option.isSome(indeterminate)) {
            return indeterminate.value;
          }
        }
        return yield* failure;
      }
      const decoded = yield* Schema.decodeEffect(RecoveryResponseSchema)(attempt.success).pipe(
        Effect.mapError((cause) => unavailable(RECOVERY_RESET_OPERATION, cause)),
      );
      if (!decoded.status) {
        return yield* rejected(
          RECOVERY_RESET_OPERATION,
          'PROVIDER_REJECTED',
          'The Commerce portal authentication provider rejected the recovery token',
        );
      }
      // Retiring the spent token and recording that the reset completed are one transaction: the
      // provider has already changed the password, so a ledger row that commits without its
      // completion row would leave the change unevidenced, and a completion row without the
      // terminal state would leave the spent token still offered to reconciliation.
      const completion = yield* Effect.result(
        store.consumePasswordResetLedgerWithAudit({
          audit: {
            correlationDigest,
            eventType: 'commerce.portal-auth.recovery-completed.v1',
            occurredAt: yield* DateTime.nowAsDate,
            operation: RECOVERY_RESET_OPERATION,
            outcome: 'success',
            providerSubjectId: ledgerSubjectId,
          },
          token: request.token,
        }),
      );
      if (Result.isFailure(completion)) {
        // The password is already changed and this realm cannot say so durably. The claim stands,
        // so the reset is reported as indeterminate rather than as a bare outage: a customer told
        // only "unavailable" would retry a token the provider has already spent.
        const indeterminate = yield* reconciliation.recordIndeterminateReset({ token: request.token });
        if (Option.isNone(indeterminate)) {
          return yield* completion.failure;
        }
        yield* Effect.annotateLogs(
          Effect.logError('Commerce portal recovery reset completed with no durable evidence', completion.failure),
          { operation: RECOVERY_RESET_OPERATION },
        );
        return indeterminate.value;
      }
      return { outcome: 'ACCOUNT_RECOVERY_COMPLETED_SAME_SUBJECT' };
    });

    const requestEmailVerification = Effect.fn('CommercePortalAuthRecovery.requestEmailVerification')(
      function* requestEmailVerificationEffect(
        input: CommercePortalAuthEmailVerificationRequestBoundary,
      ): Effect.fn.Return<CommercePortalAuthEmailVerificationStarted, CommercePortalAuthRecoveryFailure> {
        const request = yield* Schema.decodeEffect(CommercePortalAuthEmailVerificationRequestSchema, {
          onExcessProperty: 'error',
        })(input).pipe(Effect.mapError(invalidRequest));
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
      const request = yield* Schema.decodeEffect(CommercePortalAuthEmailVerificationTokenSchema, {
        onExcessProperty: 'error',
      })(input).pipe(Effect.mapError(invalidRequest));
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
      // Retiring the ledger token and recording that the verification completed are one
      // transaction: consuming the token is what flips `user.emailVerified`, so a refused audit
      // write here must undo the flip along with it rather than leave a verified address behind an
      // audit outage. A transaction failure surfaces as `CommercePortalAuthRecoveryUnavailable`
      // straight through this call — unlike the reset, nothing external was already asked to act,
      // so there is no completed side effect to reconcile and no reason to answer anything but
      // unavailable.
      const subject = yield* store.consumeEmailVerificationWithAudit({
        audit: {
          correlationDigest: Option.isSome(binding) ? binding.value.tokenDigest : undefined,
          eventType: 'commerce.portal-auth.email-verification-consumed.v1',
          occurredAt: now,
          operation: VERIFY_EMAIL_OPERATION,
          outcome: 'success',
          providerSubjectId: Option.isSome(binding) ? binding.value.providerSubjectId : undefined,
        },
        now,
        token: request.token,
      });
      if (Option.isNone(subject)) {
        return yield* rejected(
          VERIFY_EMAIL_OPERATION,
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
