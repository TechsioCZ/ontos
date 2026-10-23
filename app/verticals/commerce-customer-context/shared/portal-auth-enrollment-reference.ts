import { Option, Schema } from 'effect';

import {
  EnrollmentAttemptIdSchema,
  EnrollmentOwnerOperationIdSchema,
  EnrollmentLegalEntityIdSchema,
} from './enrollment-identifiers.ts';

/** A credential-free reference to the original, durable provider-account transition. */
export const CommerceEnrollmentAuthenticationReferencePayloadSchema = Schema.Struct({
  enrollmentAttemptId: EnrollmentAttemptIdSchema,
  kind: Schema.Literal('commerce-enrollment-binding.v1'),
  providerOwnerOperationId: EnrollmentOwnerOperationIdSchema,
  sellingLegalEntityId: EnrollmentLegalEntityIdSchema,
});
export const CommerceEnrollmentAuthenticationReferenceJsonSchema = Schema.fromJsonString(
  CommerceEnrollmentAuthenticationReferencePayloadSchema,
);
export const decodeCommerceEnrollmentAuthenticationReference = Schema.decodeUnknownOption(
  CommerceEnrollmentAuthenticationReferenceJsonSchema,
  { onExcessProperty: 'error' },
);

/** Not an opaque token: only this complete, exact data shape can name an enrollment proof. */
export const CommerceEnrollmentAuthenticationReferenceSchema = Schema.String.check(
  Schema.isMaxLength(500),
  Schema.makeFilter((value) =>
    Option.isSome(decodeCommerceEnrollmentAuthenticationReference(value))
      ? undefined
      : 'A complete Commerce enrollment binding reference is required',
  ),
);
