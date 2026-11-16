import { Schema } from 'effect';

import { PaymentReasonSchema, PaymentRevisionSchema } from '../domain/payment-identifiers.ts';
import {
  GatewayCredentialRevisionViewSchema,
  GatewayCredentialSecretRefSchema,
  GatewayProviderAccountBindingViewSchema,
  GatewayProviderAccountRefSchema,
} from '../domain/psp-configuration.ts';

/**
 * Rotate the Credential Revision of one Provider Account Binding (#1155). The account identity does not
 * change: revision n+1 becomes ACTIVE and revision n is retired. Retired bindings may rotate too, because
 * their historical operations (late evidence, recovery, refunds) still authenticate through them.
 */
export const RotateProviderCredentialPayloadSchema = Schema.Struct({
  /** The binding's Current revision the rotation was decided against. */
  expectedRevision: PaymentRevisionSchema,
  providerAccountRef: GatewayProviderAccountRefSchema,
  reason: PaymentReasonSchema,
  /** Name of the new credential material in the deployment secret store; never the secret itself. */
  secretRef: GatewayCredentialSecretRefSchema,
});
export type RotateProviderCredentialPayload = typeof RotateProviderCredentialPayloadSchema.Type;

/** No secret and no secret reference is ever returned. */
export const RotateProviderCredentialResultSchema = Schema.Struct({
  binding: GatewayProviderAccountBindingViewSchema,
  /** Actual time of the rotation; never backdated. */
  configuredAt: Schema.DateTimeUtcFromString,
  /** The new ACTIVE revision. */
  credential: GatewayCredentialRevisionViewSchema,
  /** The revision this rotation retired. */
  retired: GatewayCredentialRevisionViewSchema,
});
export type RotateProviderCredentialResult = typeof RotateProviderCredentialResultSchema.Type;
