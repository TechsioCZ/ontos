import { Schema } from 'effect';

import { CommerceSessionReferenceSchema } from '../../../../shared/portal-auth-contracts.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../config.ts';
import type { CommercePortalAuthSessionCookieHandoff } from '../../session/contracts.ts';

const ProviderSubjectIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).pipe(
  Schema.brand('CommercePortalAuthProviderSubjectId'),
);

/** A challenge id is an opaque bearer identifier; its value is hashed before persistence. */
export const CommercePortalAuthStepUpChallengeIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,200}$/u),
).pipe(Schema.brand('CommercePortalAuthStepUpChallengeId'));

const StepUpCodeSchema = Schema.String.check(Schema.isPattern(/^[0-9]{6}$/u));
const AttemptsRemainingSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(COMMERCE_PORTAL_AUTH_POLICY.mfa.maxAttempts),
);

export const CommercePortalAuthStepUpIssueInputSchema = Schema.Struct({
  providerSubjectId: ProviderSubjectIdSchema,
  sessionRef: CommerceSessionReferenceSchema,
});

export const CommercePortalAuthStepUpVerifyInputSchema = Schema.Struct({
  challengeId: CommercePortalAuthStepUpChallengeIdSchema,
  code: StepUpCodeSchema,
  providerSubjectId: ProviderSubjectIdSchema,
  sessionRef: CommerceSessionReferenceSchema,
});

/** Public issue result. It carries no code, provider cookie, MFA secret, or user record. */
export type CommercePortalAuthStepUpRequired = Readonly<{
  readonly attemptsRemaining: number;
  readonly challengeId: typeof CommercePortalAuthStepUpChallengeIdSchema.Type;
  readonly expiresAt: Date;
  readonly outcome: 'STEP_UP_REQUIRED';
}>;

export const CommercePortalAuthStepUpRequiredSchema = Schema.Struct({
  attemptsRemaining: AttemptsRemainingSchema,
  challengeId: CommercePortalAuthStepUpChallengeIdSchema,
  expiresAt: Schema.Date,
  outcome: Schema.Literal('STEP_UP_REQUIRED'),
});

/** Private result consumed by the owner cookie adapter after a successful proof. */
type CommercePortalAuthStepUpCompleted = Readonly<{
  readonly handoff: CommercePortalAuthSessionCookieHandoff;
  readonly outcome: 'STEP_UP_COMPLETED';
}>;

type CommercePortalAuthStepUpRejectedResult = Readonly<{
  readonly outcome: 'STEP_UP_REJECTED';
}>;

export type CommercePortalAuthStepUpVerificationResult =
  | CommercePortalAuthStepUpCompleted
  | CommercePortalAuthStepUpRejectedResult;

export type CommercePortalAuthStepUpChallengeRecord = Readonly<{
  readonly attemptsRemaining: number;
  readonly consumedAt: Date | null;
  readonly expiresAt: Date;
  readonly providerSubjectId: string;
  readonly sessionId: string;
}>;

export type CommercePortalAuthStepUpCodeInput = Readonly<{
  readonly code: string;
  readonly headers: Headers;
  readonly providerSubjectId: string;
  readonly sessionId: string;
}>;
