import { Schema } from 'effect';

/**
 * Raw Better Auth failures remain private: only the classified provider code and status cross
 * this boundary, and the original throwable is carried on the non-schema `cause` property.
 */
export class CommercePortalAuthRecoveryProviderFailure extends Schema.TaggedError<CommercePortalAuthRecoveryProviderFailure>()(
  'CommercePortalAuthRecoveryProviderFailure',
  {
    operation: Schema.String,
    providerCode: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
    providerStatus: Schema.optional(Schema.Finite.check(Schema.isInt())),
  },
) {}
