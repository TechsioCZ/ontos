import { Schema } from 'effect';
import type { Redacted } from 'effect';

import { ExternalUserSubjectSchema } from '../../../../shared/portal-auth-contracts.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../config.ts';

const email = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(3), Schema.isMaxLength(320));
export const CommercePortalAuthProviderSubjectIdSchema = ExternalUserSubjectSchema.fields.providerSubjectId;
const recoveryToken = Schema.Redacted(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)));
const newPassword = Schema.Redacted(
  Schema.String.check(
    Schema.isMinLength(COMMERCE_PORTAL_AUTH_POLICY.password.minLength),
    Schema.isMaxLength(COMMERCE_PORTAL_AUTH_POLICY.password.maxLength),
  ),
);

/** Public recovery input. The provider normalizes the identifier before invoking Better Auth. */
export const CommercePortalAuthPasswordResetRequestSchema = Schema.Struct({
  email,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CommercePortalAuthPasswordResetRequestBoundary = Schema.Codec.Encoded<
  typeof CommercePortalAuthPasswordResetRequestSchema
>;

/** The password and token remain redacted until the final foreign-provider call. */
export const CommercePortalAuthPasswordResetSchema = Schema.Struct({
  newPassword,
  token: recoveryToken,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CommercePortalAuthPasswordResetBoundary = Schema.Codec.Encoded<
  typeof CommercePortalAuthPasswordResetSchema
>;

/** Email verification requests are authorized for one exact provider subject and email pair. */
export const CommercePortalAuthEmailVerificationRequestSchema = Schema.Struct({
  email,
  providerSubjectId: CommercePortalAuthProviderSubjectIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CommercePortalAuthEmailVerificationRequestBoundary = Schema.Codec.Encoded<
  typeof CommercePortalAuthEmailVerificationRequestSchema
>;

export const CommercePortalAuthEmailVerificationTokenSchema = Schema.Struct({
  token: recoveryToken,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CommercePortalAuthEmailVerificationTokenBoundary = Schema.Codec.Encoded<
  typeof CommercePortalAuthEmailVerificationTokenSchema
>;

/** Raw Better Auth callback data is accepted only at the provider delivery bridge. */
export interface CommercePortalAuthEmailVerificationTokenRegistration {
  readonly email: string;
  readonly providerSubjectId: string;
  readonly token: Redacted.Redacted;
}

export interface CommercePortalAuthRecoveryStarted {
  readonly outcome: 'ACCOUNT_RECOVERY_STARTED';
}

export interface CommercePortalAuthRecoveryCompleted {
  readonly outcome: 'ACCOUNT_RECOVERY_COMPLETED_SAME_SUBJECT';
}

export interface CommercePortalAuthEmailVerificationStarted {
  readonly outcome: 'EMAIL_VERIFICATION_STARTED';
}

export interface CommercePortalAuthEmailVerificationCompleted {
  readonly outcome: 'EMAIL_VERIFICATION_COMPLETED_SAME_SUBJECT';
}

/**
 * Every recovery evidence conflict this realm can detect. Detection never resolves the conflict
 * and never restores access; it only records that a support operator needs to look at the account.
 *
 * - `VERIFICATION_LEDGER_SUBJECT_MISMATCH`: the email-verification ledger's recorded provider
 *   subject for an identifier disagrees with the provider's current account for that identifier.
 * - `IDENTIFIER_REBOUND`: the password-reset ledger's recorded provider subject for an identifier
 *   disagrees with the provider's current account for that identifier — the identifier was rebound
 *   to a different subject between issuance and use.
 * - `TOKEN_SUBJECT_STALE`: the ledger's recorded provider subject no longer names any active
 *   account at all.
 * - `RESET_OUTCOME_INDETERMINATE`: the provider was asked to spend a reset token and never answered
 *   — or answered after the deployment could no longer record the completion — so whether the
 *   password actually changed is unknown to this realm. Unlike the three above it is not a
 *   disagreement between issuance-time and current evidence: it is the absence of an outcome.
 */
export const CommercePortalAuthRecoveryReconciliationConflictClassSchema = Schema.Literals([
  'VERIFICATION_LEDGER_SUBJECT_MISMATCH',
  'IDENTIFIER_REBOUND',
  'TOKEN_SUBJECT_STALE',
  'RESET_OUTCOME_INDETERMINATE',
]);
export type CommercePortalAuthRecoveryReconciliationConflictClass =
  typeof CommercePortalAuthRecoveryReconciliationConflictClassSchema.Type;

/**
 * Raised instead of a normal completion when recovery evidence conflicts. This outcome is
 * terminal for the request that produced it: it never grants a token, resets a password, or marks
 * an email verified. The conflict is recorded durably for a support operator; the caller only
 * learns that reconciliation is required, never which account or subject was involved.
 */
export interface CommercePortalAuthRecoveryReconciliationRequired {
  readonly conflictClass: CommercePortalAuthRecoveryReconciliationConflictClass;
  readonly outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED';
}
