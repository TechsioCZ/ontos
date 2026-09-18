import { AuthenticationNamespaceIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Result, Schema } from 'effect';

/** Trusted namespace registration for this Shell deployment's existing staff provider. */
export const STAFF_AUTHENTICATION_NAMESPACE_ID = Result.getOrThrow(
  Schema.decodeResult(AuthenticationNamespaceIdSchema)('ontos.staff.better-auth.v1'),
);
