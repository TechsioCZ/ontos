import { Schema } from 'effect';

import {
  PaymentCustomerConfigurationIdSchema,
  PaymentReasonSchema,
  PaymentRevisionSchema,
} from '../domain/payment-identifiers.ts';
import { PaymentGatewayProviderFamilySchema } from '../domain/payment-vocabulary.ts';
import {
  GatewayHttpsUrlSchema,
  GatewayProviderAccountBindingIdSchema,
  GatewayProviderAccountRefSchema,
} from '../domain/psp-configuration.ts';
import { GatewayEnvironmentSchema } from '../domain/psp-vocabulary.ts';

/**
 * Gateway Enablement of one provider family for one Customer Configuration in the trusted Selling Legal
 * Entity (#1155). Tenant and Selling Legal Entity come from the Core-verified scope, never from this
 * payload. The enablement names one exact Provider Account Binding and environment; the family is that
 * binding's own family. Enabling never creates a source authority, never selects another binding and
 * never falls back to another provider, account or environment.
 */
export const ConfigureGatewayEnablementPayloadSchema = Schema.Struct({
  customerConfigurationId: PaymentCustomerConfigurationIdSchema,
  enabled: Schema.Boolean,
  /** Must equal the binding's own environment: SANDBOX and LIVE are never interchangeable. */
  environment: GatewayEnvironmentSchema,
  /** The Current revision decided against; omit it only for the first configuration of the family. */
  expectedRevision: Schema.optionalKey(PaymentRevisionSchema),
  providerAccountRef: GatewayProviderAccountRefSchema,
  reason: PaymentReasonSchema,
  /** Where the provider returns the customer's browser; the return token is appended per operation. */
  returnUrl: GatewayHttpsUrlSchema,
});
export type ConfigureGatewayEnablementPayload = typeof ConfigureGatewayEnablementPayloadSchema.Type;

export const ConfigureGatewayEnablementResultSchema = Schema.Struct({
  bindingId: GatewayProviderAccountBindingIdSchema,
  /** False when the requested state was already Current: no revision was appended. */
  changed: Schema.Boolean,
  /** Actual time the Current state was configured; never backdated. */
  configuredAt: Schema.DateTimeUtcFromString,
  customerConfigurationId: PaymentCustomerConfigurationIdSchema,
  enabled: Schema.Boolean,
  environment: GatewayEnvironmentSchema,
  providerAccountRef: GatewayProviderAccountRefSchema,
  providerFamily: PaymentGatewayProviderFamilySchema,
  returnUrl: GatewayHttpsUrlSchema,
  revision: PaymentRevisionSchema,
});
export type ConfigureGatewayEnablementResult = typeof ConfigureGatewayEnablementResultSchema.Type;

const GATEWAY_ENABLEMENT_REJECTION_CODES = [
  /** `expectedRevision` is not the enablement's Current revision (stale or blind write). */
  'gateway_enablement_revision_conflict',
  /** Enabling names a binding that is retired for new Payment intents. */
  'gateway_binding_not_current',
  /** No binding with this ref and environment exists in the trusted Tenant and Selling Legal Entity. */
  'gateway_binding_not_found',
  /**
   * D11: the binding has no ACTIVE PAYMENT_GATEWAY source authority for GATEWAY_OUTCOME, or none for
   * REFUND_EXECUTION that is a configured refund route. Its provider evidence could never be accepted.
   */
  'gateway_source_authority_missing',
] as const;

/** The change does not apply: a stale revision, an unusable binding or a fail-closed prerequisite. Nothing was written. */
export class GatewayEnablementRejected extends Schema.TaggedError<GatewayEnablementRejected>()(
  'GatewayEnablementRejected',
  {
    code: Schema.Literals(GATEWAY_ENABLEMENT_REJECTION_CODES),
    reason: Schema.String,
  },
) {}

export const gatewayEnablementRejected = (
  code: GatewayEnablementRejected['code'],
  reason: string,
): GatewayEnablementRejected => new GatewayEnablementRejected({ code, reason });
