import { Context, DateTime, Effect, Layer, Match, Option, Redacted, Result, Schema } from 'effect';

import { CommercePortalAuthAudit } from '../../../../src/portal-auth/audit/audit.ts';
import { withCause } from '../../problems-support.ts';
import type { CommercePortalAuthAuditRecorder } from '../../../../src/portal-auth/audit/audit.ts';
import type {
  CommercePortalAuthAuditEvent,
  CommercePortalAuthAuditEventType,
  CommercePortalAuthAuditOutcome,
} from '../../../../src/portal-auth/audit/audit-contracts.ts';
import { CommercePortalAuthSessionLifecycle } from '../../session/lifecycle-service.ts';
import type { CommercePortalAuthSessionLifecycleService } from '../../session/lifecycle-service.ts';
import { CommercePortalAuthSessionStoreService } from '../../session/store-service.ts';
import type { CommercePortalAuthSessionStore } from '../../session/store-service.ts';
import { encodeCommerceSessionReference } from '../session-reference.ts';

import {
  CommercePortalAuthMfaBackupCodesResultSchema,
  CommercePortalAuthMfaEnableResultSchema,
  CommercePortalAuthMfaStatusResultSchema,
  CommercePortalAuthMfaTotpUriResultSchema,
  CommercePortalAuthMfaVerificationResultSchema,
} from './contracts.ts';
import type {
  CommercePortalAuthMfaAttemptEvidence,
  CommercePortalAuthMfaBackupCodesResult,
  CommercePortalAuthMfaDisableProviderRequest,
  CommercePortalAuthMfaEnableProviderRequest,
  CommercePortalAuthMfaEnableResult,
  CommercePortalAuthMfaPasswordProviderRequest,
  CommercePortalAuthMfaProviderFailure,
  CommercePortalAuthMfaResponse,
  CommercePortalAuthMfaSendOtpProviderRequest,
  CommercePortalAuthMfaStatusResult,
  CommercePortalAuthMfaTotpUriResult,
  CommercePortalAuthMfaVerificationResponse,
  CommercePortalAuthMfaVerificationResult,
  CommercePortalAuthMfaVerifyBackupCodeServiceRequest,
  CommercePortalAuthMfaVerifyOtpServiceRequest,
  CommercePortalAuthMfaVerifyTotpServiceRequest,
} from './contracts.ts';
import { CommercePortalAuthMfaProviderUnavailable } from './provider-unavailable.ts';
import { CommercePortalAuthMfaProviderService } from './provider-service.ts';

/**
 * Every request body reaching this facade is already decoded by the owner's published payload
 * schemas, so the service validates only what Better Auth sends back.
 */
export interface CommercePortalAuthMfaServiceApi {
  /**
   * Better Auth's `verifyTOTP` with an established session: it activates the staged factor and
   * rotates the session. It is a separate method from `verifyTOTP` because its evidence is a
   * separate fact — an enrollment, not a second-factor authentication — even though the provider
   * call underneath is the same one.
   */
  readonly confirmEnableTotp: (
    input: CommercePortalAuthMfaVerifyTotpServiceRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaVerificationResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly disableTwoFactor: (
    input: CommercePortalAuthMfaDisableProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaStatusResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly enableTwoFactor: (
    input: CommercePortalAuthMfaEnableProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaEnableResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly generateBackupCodes: (
    input: CommercePortalAuthMfaPasswordProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaBackupCodesResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly getTOTPURI: (
    input: CommercePortalAuthMfaPasswordProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaTotpUriResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly sendTwoFactorOTP: (
    input: CommercePortalAuthMfaSendOtpProviderRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaStatusResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly verifyBackupCode: (
    input: CommercePortalAuthMfaVerifyBackupCodeServiceRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaVerificationResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly verifyTOTP: (
    input: CommercePortalAuthMfaVerifyTotpServiceRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaVerificationResult>,
    CommercePortalAuthMfaProviderFailure
  >;
  readonly verifyTwoFactorOTP: (
    input: CommercePortalAuthMfaVerifyOtpServiceRequest,
  ) => Effect.Effect<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaVerificationResult>,
    CommercePortalAuthMfaProviderFailure
  >;
}

export class CommercePortalAuthMfaService extends Context.Service<
  CommercePortalAuthMfaService,
  CommercePortalAuthMfaServiceApi
>()('@app/commerce-customer-context/api/portal-auth/provider/mfa/service/CommercePortalAuthMfaService') {}

interface CommercePortalAuthMfaMalformedResponseCause {
  readonly kind: 'malformed-response';
}

const malformedResponseCause = <ErrorValue>(_cause: ErrorValue): CommercePortalAuthMfaMalformedResponseCause => ({
  kind: 'malformed-response',
});

export const commercePortalAuthMfaProviderUnavailable = (
  operation: string,
  cause: unknown,
  setCookieHeaders: readonly string[] = [],
): CommercePortalAuthMfaProviderUnavailable =>
  withCause(
    new CommercePortalAuthMfaProviderUnavailable({
      operation,
      reason: 'Commerce portal MFA provider operation failed',
      setCookieHeaders,
    }),
    cause,
  );

const callProvider = <SchemaValue extends Schema.Constraint>(
  operation: string,
  call: Effect.Effect<
    CommercePortalAuthMfaResponse<SchemaValue['Type']>,
    CommercePortalAuthMfaProviderFailure,
    SchemaValue['DecodingServices']
  >,
  schema: SchemaValue,
): Effect.Effect<
  CommercePortalAuthMfaResponse<SchemaValue['Type']>,
  CommercePortalAuthMfaProviderFailure,
  SchemaValue['DecodingServices']
> =>
  call.pipe(
    Effect.flatMap((result) =>
      Schema.decodeEffect(schema)(result.body).pipe(
        Effect.map((body) => ({ body, setCookieHeaders: result.setCookieHeaders })),
        Effect.mapError((cause) =>
          commercePortalAuthMfaProviderUnavailable(operation, malformedResponseCause(cause), result.setCookieHeaders),
        ),
      ),
    ),
  );

/**
 * A verification's provider call, validated against the same published result schema every other
 * call is checked against. The private session handoff rides through the decode untouched: the
 * owner needs it only to take that session back, and it is projected away again before the caller
 * sees anything.
 */
const verifyingProvider = (
  operation: string,
  call: Effect.Effect<CommercePortalAuthMfaVerificationResponse, CommercePortalAuthMfaProviderFailure>,
): Effect.Effect<CommercePortalAuthMfaVerificationResponse, CommercePortalAuthMfaProviderFailure> =>
  call.pipe(
    Effect.flatMap((result) =>
      Schema.decodeEffect(CommercePortalAuthMfaVerificationResultSchema)(result.body).pipe(
        Effect.map((body) => ({ ...result, body })),
        Effect.mapError((cause) =>
          commercePortalAuthMfaProviderUnavailable(operation, malformedResponseCause(cause), result.setCookieHeaders),
        ),
      ),
    ),
  );

/**
 * Only a provider that actually judged the code and refused it is a failed authentication. An
 * outage, a throttle and an expired challenge all end the attempt without the second factor ever
 * being judged, so filing them as `authentication_failed` would make a provider outage read as a
 * burst of wrong codes — the exact signal a lockout review and an attack investigation depend on.
 */
const mfaVerificationOutcome = (failure: CommercePortalAuthMfaProviderFailure): CommercePortalAuthAuditOutcome =>
  Match.value(failure._tag).pipe(
    Match.when('CommercePortalAuthMfaChallengeExpired', () => 'session_expired' as const),
    Match.when('CommercePortalAuthMfaProviderRejected', () => 'authentication_failed' as const),
    Match.when('CommercePortalAuthMfaProviderUnavailable', () => 'provider_unavailable' as const),
    Match.when('CommercePortalAuthMfaRateLimited', () => 'rate_limited' as const),
    Match.exhaustive,
  );

const ROLLBACK_OPERATION = 'mfa-verification-rollback';
/** Both sign-in-challenge verifications and the backup code state the same pre-mutation intent. */
const MFA_VERIFICATION_INTENT_EVENT_TYPE = 'commerce.portal-auth.mfa-verification-requested.v1' as const;

/**
 * The audit-independent way to take back a session a verification just minted. It writes no audit
 * row on purpose: its only caller is already inside an audit outage — a refused completion row is
 * what brings this about — and an audited revoke writes its row inside the deletion's own
 * transaction, so the continuing outage would roll the deletion back and leave exactly the live
 * credential this exists to take back. The attempt is not invisible either way: the intent row
 * committed before Better Auth was ever asked to judge the code.
 */
export interface CommercePortalAuthMfaSessionRollback {
  /** `false` when the session was already gone; the token is the provider's, never a caller's. */
  readonly revokeIssuedSession: (
    issuedSessionToken: Redacted.Redacted,
  ) => Effect.Effect<boolean, CommercePortalAuthMfaProviderFailure>;
}

/**
 * The provider hands back the raw token of the session it minted, exactly as the sign-in provider
 * does; the durable row it names is what `revokeUnaudited` deletes. The token is consumed here and
 * nowhere else — it is never returned, logged or projected into evidence.
 */
const commercePortalAuthMfaSessionRollbackFor = (
  store: Pick<CommercePortalAuthSessionStore, 'findByToken'>,
  lifecycle: Pick<CommercePortalAuthSessionLifecycleService, 'revokeUnaudited'>,
): CommercePortalAuthMfaSessionRollback => ({
  revokeIssuedSession: Effect.fn('CommercePortalAuthMfaService.revokeIssuedSession')(
    function* revokeIssuedSessionEffect(issuedSessionToken: Redacted.Redacted) {
      // The single boundary that must see the raw value: the durable row is keyed on it.
      const record = yield* store.findByToken(Redacted.value(issuedSessionToken));
      if (Option.isNone(record)) {
        return false;
      }
      const sessionRef = yield* encodeCommerceSessionReference(record.value.id);
      return yield* lifecycle.revokeUnaudited({
        expectedProviderSubjectId: record.value.providerSubjectId,
        sessionRef,
      });
    },
    (effect) =>
      effect.pipe(Effect.mapError((cause) => commercePortalAuthMfaProviderUnavailable(ROLLBACK_OPERATION, cause))),
  ),
});

/**
 * The strict half of the audit contract. The row is written before — or instead of — the state it
 * describes, and its refusal is the caller's refusal: a deployment whose audit store is down
 * refuses the verification outright rather than admitting a second factor nothing records. It
 * carries no provider cookies, so a refusal never hands the browser a credential.
 */
const recordStrictEvidence = (recorder: CommercePortalAuthAuditRecorder, event: CommercePortalAuthAuditEvent) =>
  recorder
    .record(event)
    .pipe(Effect.mapError((cause) => commercePortalAuthMfaProviderUnavailable(event.operation ?? 'audit', cause)));

/** Everything the two evidence rows of one verification name, beyond the outcome itself. */
interface VerificationEvidence {
  readonly attempt: CommercePortalAuthMfaAttemptEvidence;
  readonly intentEventType: CommercePortalAuthAuditEventType;
  readonly method: string;
}

/**
 * A second-factor verification mints or rotates a live credential, so its evidence may not be
 * best-effort. The intent row goes in before Better Auth is asked to judge the code — an audit
 * outage refuses the attempt outright and the provider is never called — and the completion row is
 * strict too: a session the provider already created but whose evidence was refused is taken back
 * rather than handed to the browser. The code, the OTP, the backup code and the TOTP seed are never
 * part of either event.
 */
const strictlyAuditedVerification = Effect.fn('CommercePortalAuthMfaService.strictlyAuditedVerification')(
  function* strictlyAuditedVerificationEffect(
    recorder: CommercePortalAuthAuditRecorder,
    rollback: CommercePortalAuthMfaSessionRollback,
    evidence: VerificationEvidence,
    call: Effect.Effect<CommercePortalAuthMfaVerificationResponse, CommercePortalAuthMfaProviderFailure>,
  ): Effect.fn.Return<
    CommercePortalAuthMfaResponse<CommercePortalAuthMfaVerificationResult>,
    CommercePortalAuthMfaProviderFailure
  > {
    yield* recordStrictEvidence(recorder, {
      correlationDigest: evidence.attempt.clientKeyDigest,
      eventType: evidence.intentEventType,
      occurredAt: yield* DateTime.nowAsDate,
      operation: evidence.method,
      outcome: 'requested',
      subjectDigest: evidence.attempt.subjectDigest,
    });
    const outcome = yield* Effect.result(call);
    const completion = yield* Effect.result(
      recordStrictEvidence(recorder, {
        correlationDigest: evidence.attempt.clientKeyDigest,
        eventType: 'commerce.portal-auth.mfa-verified.v1',
        occurredAt: yield* DateTime.nowAsDate,
        operation: evidence.method,
        outcome: Result.isSuccess(outcome) ? 'success' : mfaVerificationOutcome(outcome.failure),
        subjectDigest: evidence.attempt.subjectDigest,
      }),
    );
    if (Result.isFailure(completion)) {
      if (Result.isFailure(outcome)) {
        // The provider judged and refused: no credential exists to take back, and the intent row
        // above already stands for the attempt. The refusal keeps its own status.
        yield* Effect.annotateLogs(Effect.logError('Commerce portal MFA verification evidence was not persisted'), {
          auditOperation: evidence.method,
          auditOutcome: mfaVerificationOutcome(outcome.failure),
        });
        return yield* outcome.failure;
      }
      // The provider already minted or rotated this session. Forwarding its cookie would leave a
      // live credential whose admission nothing durable records, so the session is taken back and
      // the caller is told the deployment is unavailable, with no cookies at all.
      const compensated = yield* Effect.result(rollback.revokeIssuedSession(outcome.success.issuedSessionToken));
      // Always an operator fact, however the compensation went: the provider completed a
      // verification the deployment cannot evidence. For `confirm-enable` the activated factor
      // itself stands — Better Auth's only deactivation needs the account password, which that
      // route never receives — so this line is the whole record of that activation.
      yield* Effect.annotateLogs(
        Effect.logError('Commerce portal MFA verification completed with no durable evidence'),
        {
          auditOperation: evidence.method,
          sessionRevoked: Result.isSuccess(compensated) && compensated.success,
        },
      );
      return yield* completion.failure;
    }
    if (Result.isFailure(outcome)) {
      return yield* outcome.failure;
    }
    return { body: outcome.success.body, setCookieHeaders: outcome.success.setCookieHeaders };
  },
);

export const makeCommercePortalAuthMfaService = Effect.fn('CommercePortalAuthMfaService.make')(
  function* makeCommercePortalAuthMfaServiceEffect(
    audit: CommercePortalAuthAuditRecorder,
    rollback: CommercePortalAuthMfaSessionRollback,
  ) {
    const provider = yield* CommercePortalAuthMfaProviderService;
    const enableTwoFactor = (input: CommercePortalAuthMfaEnableProviderRequest) =>
      callProvider('enableTwoFactor', provider.enableTwoFactor(input), CommercePortalAuthMfaEnableResultSchema);

    const disableTwoFactor = (input: CommercePortalAuthMfaDisableProviderRequest) =>
      callProvider('disableTwoFactor', provider.disableTwoFactor(input), CommercePortalAuthMfaStatusResultSchema);

    const sendTwoFactorOTP = (input: CommercePortalAuthMfaSendOtpProviderRequest) =>
      callProvider('sendTwoFactorOTP', provider.sendTwoFactorOTP(input), CommercePortalAuthMfaStatusResultSchema);

    const verifyTOTP = (input: CommercePortalAuthMfaVerifyTotpServiceRequest) =>
      strictlyAuditedVerification(
        audit,
        rollback,
        {
          attempt: input.evidence,
          intentEventType: MFA_VERIFICATION_INTENT_EVENT_TYPE,
          method: 'verify-totp',
        },
        verifyingProvider('verifyTOTP', provider.verifyTOTP({ body: input.body, headers: input.headers })),
      );

    /**
     * The same provider call as `verifyTOTP`, and deliberately not the same evidence: with an
     * established session Better Auth's `verifyTOTP` activates the staged factor. Better Auth
     * offers no un-audited way to undo that activation — `disableTwoFactor` needs the account
     * password, which this route never receives — so a refused completion row cannot take the
     * factor back. What it can do is refuse to forward the success: the rotated session is revoked,
     * no cookie reaches the browser, the caller is told the deployment is unavailable, and the
     * activation that stands with no completion row is logged for an operator.
     */
    const confirmEnableTotp = (input: CommercePortalAuthMfaVerifyTotpServiceRequest) =>
      strictlyAuditedVerification(
        audit,
        rollback,
        {
          attempt: input.evidence,
          intentEventType: 'commerce.portal-auth.mfa-enable-requested.v1',
          method: 'confirm-enable',
        },
        verifyingProvider('verifyTOTP', provider.verifyTOTP({ body: input.body, headers: input.headers })),
      );

    const verifyTwoFactorOTP = (input: CommercePortalAuthMfaVerifyOtpServiceRequest) =>
      strictlyAuditedVerification(
        audit,
        rollback,
        {
          attempt: input.evidence,
          intentEventType: MFA_VERIFICATION_INTENT_EVENT_TYPE,
          method: 'verify-otp',
        },
        verifyingProvider(
          'verifyTwoFactorOTP',
          provider.verifyTwoFactorOTP({ body: input.body, headers: input.headers }),
        ),
      );

    const verifyBackupCode = (input: CommercePortalAuthMfaVerifyBackupCodeServiceRequest) =>
      strictlyAuditedVerification(
        audit,
        rollback,
        {
          attempt: input.evidence,
          intentEventType: MFA_VERIFICATION_INTENT_EVENT_TYPE,
          method: 'verify-backup-code',
        },
        verifyingProvider('verifyBackupCode', provider.verifyBackupCode({ body: input.body, headers: input.headers })),
      );

    const getTOTPURI = (input: CommercePortalAuthMfaPasswordProviderRequest) =>
      callProvider('getTOTPURI', provider.getTOTPURI(input), CommercePortalAuthMfaTotpUriResultSchema);

    const generateBackupCodes = (input: CommercePortalAuthMfaPasswordProviderRequest) =>
      callProvider(
        'generateBackupCodes',
        provider.generateBackupCodes(input),
        CommercePortalAuthMfaBackupCodesResultSchema,
      );

    return {
      confirmEnableTotp,
      disableTwoFactor,
      enableTwoFactor,
      generateBackupCodes,
      getTOTPURI,
      sendTwoFactorOTP,
      verifyBackupCode,
      verifyTOTP,
      verifyTwoFactorOTP,
    } satisfies CommercePortalAuthMfaServiceApi;
  },
);

/**
 * The MFA provider port stays a visible requirement; the composition root supplies it once. The
 * session store and lifecycle are read here for the one thing this service cannot do without them:
 * taking back a session whose admission evidence the audit store refused.
 */
export const CommercePortalAuthMfaServiceLive = Layer.effect(
  CommercePortalAuthMfaService,
  Effect.gen(function* makeCommercePortalAuthMfaServiceLive() {
    const audit = yield* CommercePortalAuthAudit;
    const store = yield* CommercePortalAuthSessionStoreService;
    const lifecycle = yield* CommercePortalAuthSessionLifecycle;
    return yield* makeCommercePortalAuthMfaService(audit, commercePortalAuthMfaSessionRollbackFor(store, lifecycle));
  }),
);
