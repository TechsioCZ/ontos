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
