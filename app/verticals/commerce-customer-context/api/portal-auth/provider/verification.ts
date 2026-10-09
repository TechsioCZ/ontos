import { Context, DateTime, Effect, Option, Schema } from 'effect';

import {
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  VerifyExternalAuthenticationRequestSchema,
} from '../../../shared/portal-auth-contracts.ts';
import { COMMERCE_PORTAL_AUTH_VERIFY_OPERATION } from '../../../shared/portal-auth-verification.ts';
import type {
  VerifyExternalAuthenticationRequest,
  VerifyExternalAuthenticationResult,
} from '../../../shared/portal-auth-contracts.ts';
import { CommerceEnrollmentProofService } from '../enrollment-proof-port.ts';
import type { CommerceEnrollmentProof } from '../enrollment-proof-port.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from './config.ts';
import { parseCommerceSessionReference } from './session-reference.ts';
import type { CommercePortalAuthVerificationCallerRejected } from './verification-caller-rejected.ts';
import type { CommercePortalAuthVerificationCallerUnavailable } from './verification-caller-unavailable.ts';
import { CommercePortalAuthVerificationInvalidRequest } from './verification-invalid-request.ts';
import { CommercePortalAuthVerificationCaller } from './verification-caller-service.ts';
import type { CommercePortalAuthSessionReader } from './session-reader-service.ts';

export { CommercePortalAuthVerificationCallerRejected } from './verification-caller-rejected.ts';
export { CommercePortalAuthVerificationInvalidRequest } from './verification-invalid-request.ts';
export { CommercePortalAuthSessionReadUnavailable } from './session-read-unavailable.ts';
export { CommercePortalAuthVerificationCaller } from './verification-caller-service.ts';

/** Trusted workload authorization is injected by the owner composition; there is no allow default. */
export interface CommercePortalAuthVerificationAuthorization extends VerifyExternalAuthenticationRequest {
  readonly operation: typeof COMMERCE_PORTAL_AUTH_VERIFY_OPERATION;
}

/**
 * The reader deliberately has no token member. It can only obtain state by the provider session
 * id parsed from a namespaced Core reference.
 */
export interface CommercePortalAuthAuthoritativeSession {
  readonly banExpiresAt: Date | null;
  readonly banned: boolean;
  readonly createdAt: Date;
  readonly emailVerified: boolean;
  readonly expiresAt: Date;
  readonly providerSubjectId: string;
  readonly sessionId: string;
}

export type CommercePortalAuthVerificationInput = Schema.Codec.Encoded<
  typeof VerifyExternalAuthenticationRequestSchema
>;

export type CommercePortalAuthVerificationFailure =
  | CommercePortalAuthVerificationCallerRejected
  | CommercePortalAuthVerificationCallerUnavailable
  | CommercePortalAuthVerificationInvalidRequest;

export class CommercePortalAuthVerificationService extends Context.Service<
  CommercePortalAuthVerificationService,
  {
    readonly verifyExternalAuthentication: (
      input: CommercePortalAuthVerificationInput,
    ) => Effect.Effect<VerifyExternalAuthenticationResult, CommercePortalAuthVerificationFailure>;
  }
>()('@app/commerce-customer-context/api/portal-auth/provider/verification/CommercePortalAuthVerificationService') {}

const rejectedResult = (nonce: string, observedAt: Schema.Schema.Type<typeof Schema.DateTimeUtc>) => ({
  nonce,
  observedAt,
  outcome: 'REJECTED' as const,
});

const unavailableResult = (nonce: string, observedAt: Schema.Schema.Type<typeof Schema.DateTimeUtc>) => ({
  nonce,
  observedAt,
  outcome: 'UNAVAILABLE' as const,
});

const callerRejected = () => Effect.succeed('REJECTED' as const);
const callerUnavailable = () => Effect.succeed('UNAVAILABLE' as const);
const enrollmentProofRejected = () => Effect.succeed({ outcome: 'REJECTED' as const });
const enrollmentProofUnavailable = () => Effect.succeed({ outcome: 'UNAVAILABLE' as const });

const toUtc = (date: Date): Schema.Schema.Type<typeof Schema.DateTimeUtc> => DateTime.makeUnsafe(date);

const epochMillis = (date: Date): number => {
  const decoded = DateTime.make(date);
  return Option.isSome(decoded) ? DateTime.toEpochMillis(decoded.value) : Number.NaN;
};

const activeBan = (record: CommercePortalAuthAuthoritativeSession, now: number): boolean => {
  if (!record.banned) {
    return false;
  }
  if (record.banExpiresAt === null) {
    return true;
  }
  const expiresAt = epochMillis(record.banExpiresAt);
  return !Number.isFinite(expiresAt) || expiresAt > now;
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
  request: VerifyExternalAuthenticationRequest,
  now: number,
): boolean => {
  const createdAt = epochMillis(record.createdAt);
  const expiresAt = epochMillis(record.expiresAt);
  return (
    record.providerSubjectId === request.providerSubjectId &&
    request.authenticationNamespaceId === COMMERCE_AUTHENTICATION_NAMESPACE_ID &&
    request.subjectType === 'user' &&
    Number.isFinite(createdAt) &&
    Number.isFinite(expiresAt) &&
    createdAt <= now &&
    absoluteExpiry(record) > now &&
    expiresAt > now &&
    !activeBan(record, now) &&
    record.emailVerified
  );
};

/**
 * Construct the live verifier with mandatory caller and Attempt-proof services from Context.
 * Provider state is read by session.id and checked against the claimed subject; raw tokens never
 * enter this service or its result.
 */
export const makeCommercePortalAuthVerificationService = Effect.fn('CommercePortalAuthVerification.make')(
  function* makeCommercePortalAuthVerificationServiceEffect(
    sessionReader: CommercePortalAuthSessionReader,
  ): Effect.fn.Return<
    CommercePortalAuthVerificationService['Service'],
    never,
    CommercePortalAuthVerificationCaller | CommerceEnrollmentProofService
  > {
    const caller = yield* CommercePortalAuthVerificationCaller;
    const enrollmentProof = yield* CommerceEnrollmentProofService;

    const verifyExternalAuthentication = Effect.fn('CommercePortalAuthVerification.verify')(function* verify(
      input: CommercePortalAuthVerificationInput,
    ): Effect.fn.Return<VerifyExternalAuthenticationResult, CommercePortalAuthVerificationFailure> {
      const request = yield* Schema.decodeEffect(VerifyExternalAuthenticationRequestSchema, {
        onExcessProperty: 'error',
      })(input).pipe(
        Effect.mapError((cause) =>
          Object.defineProperty(
            new CommercePortalAuthVerificationInvalidRequest({
              reason: 'Commerce portal authentication verification input is invalid',
            }),
            'cause',
            { configurable: true, value: cause },
          ),
        ),
      );
      const observedAtDate = yield* DateTime.nowAsDate;
      const observedAt = toUtc(observedAtDate);

      const authorization = yield* caller
        .authorize({ operation: COMMERCE_PORTAL_AUTH_VERIFY_OPERATION, ...request })
        .pipe(
          Effect.map(() => 'AUTHORIZED' as const),
          Effect.catchTags({
            CommercePortalAuthVerificationCallerRejected: callerRejected,
            CommercePortalAuthVerificationCallerUnavailable: callerUnavailable,
          }),
        );
      if (authorization === 'REJECTED') {
        return rejectedResult(request.nonce, observedAt);
      }
      if (authorization === 'UNAVAILABLE') {
        return unavailableResult(request.nonce, observedAt);
      }

      const sessionId = yield* parseCommerceSessionReference(request.sessionRef).pipe(
        Effect.mapError((cause) =>
          Object.defineProperty(
            new CommercePortalAuthVerificationInvalidRequest({
              reason: 'Commerce portal session reference is invalid',
            }),
            'cause',
            { configurable: true, value: cause },
          ),
        ),
      );
      const readResult = yield* sessionReader.findBySessionId(sessionId).pipe(
        Effect.map((record) => ({ outcome: 'FOUND' as const, record })),
        Effect.catchTag('CommercePortalAuthSessionReadUnavailable', () =>
          Effect.succeed({ outcome: 'UNAVAILABLE' as const }),
        ),
      );
      if (readResult.outcome === 'UNAVAILABLE') {
        return unavailableResult(request.nonce, observedAt);
      }
      const { record } = readResult;
      if (Option.isNone(record) || record.value.sessionId !== sessionId) {
        return rejectedResult(request.nonce, observedAt);
      }

      const now = DateTime.toEpochMillis(observedAt);
      if (!isLiveSession(record.value, request, now)) {
        return rejectedResult(request.nonce, observedAt);
      }

      if (request.enrollmentAttemptId === undefined) {
        return {
          ...request,
          authenticatedAt: toUtc(record.value.createdAt),
          emailVerified: record.value.emailVerified,
          observedAt,
          outcome: 'ALLOWED' as const,
        };
      }

      const proofResult = yield* enrollmentProof
        .verify({
          authenticationNamespaceId: request.authenticationNamespaceId,
          enrollmentAttemptId: request.enrollmentAttemptId,
          providerSubjectId: request.providerSubjectId,
          subjectType: request.subjectType,
          tenantId: request.tenantId,
        })
        .pipe(
          Effect.map((value: CommerceEnrollmentProof) => ({ outcome: 'ALLOWED' as const, value })),
          Effect.catchTags({
            CommerceEnrollmentProofRejected: enrollmentProofRejected,
            CommerceEnrollmentProofUnavailable: enrollmentProofUnavailable,
          }),
        );
      if (proofResult.outcome === 'REJECTED') {
        return rejectedResult(request.nonce, observedAt);
      }
      if (proofResult.outcome === 'UNAVAILABLE') {
        return unavailableResult(request.nonce, observedAt);
      }
      if (proofResult.value.enrollmentAttemptId !== request.enrollmentAttemptId || proofResult.value.revision < 1) {
        return rejectedResult(request.nonce, observedAt);
      }

      return {
        ...request,
        authenticatedAt: toUtc(record.value.createdAt),
        emailVerified: record.value.emailVerified,
        enrollmentProof: proofResult.value,
        observedAt,
        outcome: 'ALLOWED' as const,
      };
    });

    return { verifyExternalAuthentication };
  },
);
