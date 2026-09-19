import { createHash, randomBytes } from 'node:crypto';

import { DateTime, Effect, Option, Result, Schema } from 'effect';

import { auditedLayer, commercePortalAuthAuditEmitter } from '../../../../src/portal-auth/audit/audit.ts';
import { withCause } from '../../problems-support.ts';
import type { CommercePortalAuthAuditRecorder } from '../../../../src/portal-auth/audit/audit.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../config.ts';
import { parseCommerceSessionReference } from '../session-reference.ts';
import type { CommercePortalAuthAuthoritativeSession } from '../verification.ts';
import { CommercePortalAuthSessionReaderService } from '../session-reader-service.ts';
import type { CommercePortalAuthSessionReader } from '../session-reader-service.ts';
import { CommercePortalAuthSessionLifecycle } from '../../session/lifecycle-service.ts';
import {
  CommercePortalAuthStepUpChallengeIdSchema,
  CommercePortalAuthStepUpIssueInputSchema,
  CommercePortalAuthStepUpRequiredSchema,
  CommercePortalAuthStepUpVerifyInputSchema,
} from './contracts.ts';
import type { CommercePortalAuthStepUpRequired, CommercePortalAuthStepUpVerificationResult } from './contracts.ts';
import { CommercePortalAuthStepUpChallengeStoreService } from './challenge-store-service.ts';
import { CommercePortalAuthStepUpCodeRejected } from './code-rejected.ts';
import { CommercePortalAuthStepUpCodeVerifierService } from './code-verifier-service.ts';
import { CommercePortalAuthStepUpInvalidRequest } from './invalid-request.ts';
import { CommercePortalAuthStepUpRejected } from './rejected.ts';
import { CommercePortalAuthStepUpUnavailable } from './unavailable.ts';
import { CommercePortalAuthStepUpService } from './step-up-service.ts';
import type { CommercePortalAuthStepUp, CommercePortalAuthStepUpFailure } from './step-up-service.ts';

const STEP_UP_EXPIRED_EVENT = 'commerce.portal-auth.step-up-expired.v1' as const;
const STEP_UP_VERIFIED_EVENT = 'commerce.portal-auth.step-up-verified.v1' as const;

const invalidRequest = (cause?: unknown): CommercePortalAuthStepUpInvalidRequest =>
  cause === undefined
    ? new CommercePortalAuthStepUpInvalidRequest({
        reason: 'Commerce portal step-up input is invalid',
      })
    : withCause(
        new CommercePortalAuthStepUpInvalidRequest({
          reason: 'Commerce portal step-up input is invalid',
        }),
        cause,
      );

const rejected = (reason: string): CommercePortalAuthStepUpRejected => new CommercePortalAuthStepUpRejected({ reason });

const unavailable = (operation: string, cause: unknown): CommercePortalAuthStepUpUnavailable =>
  withCause(
    new CommercePortalAuthStepUpUnavailable({
      operation,
      reason: `Commerce portal step-up ${operation} could not complete`,
    }),
    cause,
  );

const epochMillis = (value: Date): number => {
  const date = DateTime.make(value);
  return Option.isSome(date) ? DateTime.toEpochMillis(date.value) : Number.NaN;
};

const activeBan = (record: CommercePortalAuthAuthoritativeSession, now: number): boolean => {
  if (!record.banned) {
    return false;
  }
  if (record.banExpiresAt === null) {
    return true;
  }
  const banExpiresAt = epochMillis(record.banExpiresAt);
  return !Number.isFinite(banExpiresAt) || banExpiresAt > now;
};

const absoluteExpiry = (record: Pick<CommercePortalAuthAuthoritativeSession, 'createdAt'>): number => {
  const createdAt = DateTime.make(record.createdAt);
  return Option.isSome(createdAt)
    ? DateTime.toEpochMillis(
        DateTime.add(createdAt.value, {
          seconds: COMMERCE_PORTAL_AUTH_POLICY.session.absoluteLifetimeSeconds,
        }),
      )
    : Number.NaN;
};

const isLiveSession = (
  record: CommercePortalAuthAuthoritativeSession,
  providerSubjectId: string,
  sessionId: string,
  now: number,
): boolean => {
  const createdAt = epochMillis(record.createdAt);
  const expiresAt = epochMillis(record.expiresAt);
  return (
    record.providerSubjectId === providerSubjectId &&
    record.sessionId === sessionId &&
    record.emailVerified &&
    Number.isFinite(createdAt) &&
    Number.isFinite(expiresAt) &&
    createdAt <= now &&
    expiresAt > now &&
    absoluteExpiry(record) > now &&
    !activeBan(record, now)
  );
};

const challengeExpiresAt = (record: CommercePortalAuthAuthoritativeSession, now: Date): Date | undefined => {
  const nowMillis = epochMillis(now);
  const providerExpiry = epochMillis(record.expiresAt);
  const absoluteSessionExpiry = absoluteExpiry(record);
  const maximumAgeExpiry = DateTime.toEpochMillis(
    DateTime.add(DateTime.makeUnsafe(now), {
      seconds: COMMERCE_PORTAL_AUTH_POLICY.mfa.challengeMaxAgeSeconds,
    }),
  );
  const expiresAt = Math.min(providerExpiry, absoluteSessionExpiry, maximumAgeExpiry);
  return Number.isFinite(nowMillis) && Number.isFinite(expiresAt) && expiresAt > nowMillis
    ? DateTime.toDate(DateTime.makeUnsafe(expiresAt))
    : undefined;
};

const hashChallengeId = (challengeId: string): string =>
  createHash('sha256').update(challengeId, 'utf-8').digest('base64url');

const newChallengeId = (): Effect.Effect<string, CommercePortalAuthStepUpUnavailable> =>
  Effect.try({
    catch: (cause) => unavailable('challenge-id', cause),
    try: () => randomBytes(32).toString('base64url'),
  });

const newAttemptReservationId = (): Effect.Effect<string, CommercePortalAuthStepUpUnavailable> =>
  Effect.try({
    catch: (cause) => unavailable('attempt-reservation-id', cause),
    try: () => randomBytes(16).toString('base64url'),
  });

const sessionRecord = Effect.fn('CommercePortalAuthStepUp.sessionRecord')(function* sessionRecordEffect(
  sessionReader: CommercePortalAuthSessionReader,
  providerSubjectId: string,
  sessionId: string,
  now: Date,
): Effect.fn.Return<CommercePortalAuthAuthoritativeSession, CommercePortalAuthStepUpFailure> {
  const recordOption = yield* sessionReader
    .findBySessionId(sessionId)
    .pipe(Effect.mapError((cause) => unavailable('session-read', cause)));
  if (
    Option.isNone(recordOption) ||
    !isLiveSession(recordOption.value, providerSubjectId, sessionId, epochMillis(now))
  ) {
    return yield* rejected('Commerce portal step-up session is not current');
  }
  return recordOption.value;
});

export const makeCommercePortalAuthStepUp = Effect.fn('CommercePortalAuthStepUp.make')(
  function* makeCommercePortalAuthStepUpEffect(
    audit: CommercePortalAuthAuditRecorder,
  ): Effect.fn.Return<
    CommercePortalAuthStepUp,
    never,
    | CommercePortalAuthStepUpChallengeStoreService
    | CommercePortalAuthStepUpCodeVerifierService
    | CommercePortalAuthSessionLifecycle
    | CommercePortalAuthSessionReaderService
  > {
    const challengeStore = yield* CommercePortalAuthStepUpChallengeStoreService;
    const codeVerifier = yield* CommercePortalAuthStepUpCodeVerifierService;
    const lifecycle = yield* CommercePortalAuthSessionLifecycle;
    const sessionReader = yield* CommercePortalAuthSessionReaderService;
    const emitAudit = commercePortalAuthAuditEmitter(audit);

    const issue = Effect.fn('CommercePortalAuthStepUp.issue')(function* issueEffect(
      input: Schema.Codec.Encoded<typeof CommercePortalAuthStepUpIssueInputSchema>,
    ): Effect.fn.Return<CommercePortalAuthStepUpRequired, CommercePortalAuthStepUpFailure> {
      const request = yield* Schema.decodeEffect(CommercePortalAuthStepUpIssueInputSchema)(input).pipe(
        Effect.mapError((cause) => invalidRequest(cause)),
      );
      const sessionId = yield* parseCommerceSessionReference(request.sessionRef).pipe(
        Effect.mapError((cause) => invalidRequest(cause)),
      );
      const now = yield* DateTime.nowAsDate;
      const record = yield* sessionRecord(sessionReader, request.providerSubjectId, sessionId, now);
      const expiresAt = challengeExpiresAt(record, now);
      if (expiresAt === undefined) {
        return yield* rejected('Commerce portal step-up challenge cannot outlive its session');
      }
      const generatedChallengeId = yield* newChallengeId();
      const challengeId = yield* Schema.decodeEffect(CommercePortalAuthStepUpChallengeIdSchema)(
        generatedChallengeId,
      ).pipe(Effect.mapError((cause) => unavailable('challenge-id', cause)));
      const attemptsRemaining = COMMERCE_PORTAL_AUTH_POLICY.mfa.maxAttempts;
      yield* challengeStore
        .create({
          attemptsRemaining,
          challengeIdHash: hashChallengeId(challengeId),
          expiresAt,
          now,
          providerSubjectId: request.providerSubjectId,
          sessionId,
        })
        .pipe(Effect.mapError((cause) => unavailable('challenge-create', cause)));
      const result = {
        attemptsRemaining,
        challengeId,
        expiresAt,
        outcome: 'STEP_UP_REQUIRED' as const,
      } satisfies CommercePortalAuthStepUpRequired;
      const issued = yield* Schema.decodeEffect(CommercePortalAuthStepUpRequiredSchema)(result).pipe(
        Effect.mapError((cause) => unavailable('challenge-result', cause)),
      );
      yield* emitAudit({
        eventType: 'commerce.portal-auth.step-up-issued.v1',
        occurredAt: now,
        operation: 'step-up-issue',
        outcome: 'success',
        providerSubjectId: request.providerSubjectId,
        sessionRef: request.sessionRef,
      });
      return issued;
    });

    const verify = Effect.fn('CommercePortalAuthStepUp.verify')(function* verifyEffect(
      input: Schema.Codec.Encoded<typeof CommercePortalAuthStepUpVerifyInputSchema> & {
        readonly headers: Headers;
      },
    ): Effect.fn.Return<CommercePortalAuthStepUpVerificationResult, CommercePortalAuthStepUpFailure> {
      const { headers, ...encodedInput } = input;
      const request = yield* Schema.decodeEffect(CommercePortalAuthStepUpVerifyInputSchema)(encodedInput).pipe(
        Effect.mapError((cause) => invalidRequest(cause)),
      );
      const sessionId = yield* parseCommerceSessionReference(request.sessionRef).pipe(
        Effect.mapError((cause) => invalidRequest(cause)),
      );
      const now = yield* DateTime.nowAsDate;
      const auditVerification = (
        eventType: typeof STEP_UP_EXPIRED_EVENT | typeof STEP_UP_VERIFIED_EVENT,
        outcome: 'authentication_failed' | 'session_expired' | 'success',
        occurredAt: Date,
      ) =>
        emitAudit({
          eventType,
          occurredAt,
          operation: 'step-up-verify',
          outcome,
          providerSubjectId: request.providerSubjectId,
          sessionRef: request.sessionRef,
        });
      const challengeIdHash = hashChallengeId(request.challengeId);
      const challengeOption = yield* challengeStore
        .findByChallengeIdHash(challengeIdHash)
        .pipe(Effect.mapError((cause) => unavailable('challenge-read', cause)));
      if (Option.isNone(challengeOption)) {
        // An unknown challenge id is indistinguishable from one whose window already closed.
        yield* auditVerification(STEP_UP_EXPIRED_EVENT, 'session_expired', now);
        return { outcome: 'STEP_UP_REJECTED' };
      }
      const challenge = challengeOption.value;
      const nowMillis = epochMillis(now);
      if (!Number.isFinite(nowMillis) || epochMillis(challenge.expiresAt) <= nowMillis) {
        yield* auditVerification(STEP_UP_EXPIRED_EVENT, 'session_expired', now);
        return { outcome: 'STEP_UP_REJECTED' };
      }
      if (
        challenge.providerSubjectId !== request.providerSubjectId ||
        challenge.sessionId !== sessionId ||
        challenge.consumedAt !== null ||
        challenge.attemptsRemaining <= 0
      ) {
        yield* auditVerification(STEP_UP_VERIFIED_EVENT, 'authentication_failed', now);
        return { outcome: 'STEP_UP_REJECTED' };
      }
      yield* sessionRecord(sessionReader, request.providerSubjectId, sessionId, now);

      const reservationId = yield* newAttemptReservationId();
      const reserved = yield* challengeStore
        .reserveAttempt({
          challengeIdHash,
          now,
          providerSubjectId: request.providerSubjectId,
          reservationId,
          sessionId,
        })
        .pipe(Effect.mapError((cause) => unavailable('challenge-reserve', cause)));
      if (!reserved) {
        yield* auditVerification(STEP_UP_VERIFIED_EVENT, 'authentication_failed', now);
        return { outcome: 'STEP_UP_REJECTED' };
      }

      const codeResult = yield* Effect.result(
        codeVerifier.verify({
          code: request.code,
          headers,
          providerSubjectId: request.providerSubjectId,
          sessionId,
        }),
      );
      if (Result.isFailure(codeResult)) {
        const { failure } = codeResult;
        if (Schema.is(CommercePortalAuthStepUpCodeRejected)(failure)) {
          yield* challengeStore
            .recordFailure({
              challengeIdHash,
              now,
              providerSubjectId: request.providerSubjectId,
              reservationId,
              sessionId,
            })
            .pipe(Effect.mapError((cause) => unavailable('challenge-failure', cause)));
          yield* auditVerification(STEP_UP_VERIFIED_EVENT, 'authentication_failed', now);
          return { outcome: 'STEP_UP_REJECTED' };
        }
        const released = yield* challengeStore
          .releaseAttempt({
            challengeIdHash,
            now,
            providerSubjectId: request.providerSubjectId,
            reservationId,
            sessionId,
          })
          .pipe(Effect.mapError((cause) => unavailable('challenge-release', cause)));
        if (!released) {
          return yield* unavailable('challenge-release', 'The step-up attempt reservation was not active');
        }
        return yield* failure;
      }

      const verifiedAt = yield* DateTime.nowAsDate;
      yield* sessionRecord(sessionReader, request.providerSubjectId, sessionId, verifiedAt);
      const consumed = yield* challengeStore
        .consume({
          challengeIdHash,
          now: verifiedAt,
          providerSubjectId: request.providerSubjectId,
          reservationId,
          sessionId,
        })
        .pipe(Effect.mapError((cause) => unavailable('challenge-consume', cause)));
      if (!consumed) {
        yield* auditVerification(STEP_UP_VERIFIED_EVENT, 'authentication_failed', verifiedAt);
        return { outcome: 'STEP_UP_REJECTED' };
      }
      const handoff = yield* lifecycle.rotateIdentifierForCookie({
        expectedProviderSubjectId: request.providerSubjectId,
        reason: 'step-up',
        sessionRef: request.sessionRef,
      });
      yield* auditVerification(STEP_UP_VERIFIED_EVENT, 'success', verifiedAt);
      return { handoff, outcome: 'STEP_UP_COMPLETED' };
    });

    return Object.freeze({ issue, verify });
  },
);

/** Challenge store, code verifier, lifecycle and session reader stay visible requirements. */
export const CommercePortalAuthStepUpLive = auditedLayer(CommercePortalAuthStepUpService, makeCommercePortalAuthStepUp);
