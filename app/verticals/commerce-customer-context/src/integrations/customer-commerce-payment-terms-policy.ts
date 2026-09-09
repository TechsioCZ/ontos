import { Config, Effect, Schema } from 'effect';

import type {
  CustomerCommercePaymentTermsPolicyContext,
  PaymentTermsPolicyResolution,
} from '../../shared/domain/payment-terms.ts';
import {
  CustomerCommercePaymentTermsPolicyConfigurationSchema,
  resolveCustomerCommercePaymentTermsPolicy,
} from '../../shared/domain/payment-terms.ts';
import type { PaymentTermsDependencyUnavailable } from '../../shared/domain/payment-term-errors.ts';
import { PaymentTermsDependencyUnavailable as PaymentTermsDependencyUnavailableError } from '../../shared/domain/payment-term-errors.ts';

export const CUSTOMER_COMMERCE_PAYMENT_TERMS_POLICY_CONFIG =
  'CUSTOMER_COMMERCE_PAYMENT_TERMS_POLICY_CONFIG' as const;

const policyConfiguration = Config.string(CUSTOMER_COMMERCE_PAYMENT_TERMS_POLICY_CONFIG).pipe(
  Effect.flatMap(
    Schema.decodeUnknownEffect(
      Schema.fromJsonString(CustomerCommercePaymentTermsPolicyConfigurationSchema),
    ),
  ),
);

const unavailable = (cause: unknown): PaymentTermsDependencyUnavailable => {
  const failure = new PaymentTermsDependencyUnavailableError({
    code: 'payment_terms_dependency_unavailable',
    dependency: 'CUSTOMER_COMMERCE_POLICY',
    reason: 'The Current Customer Commerce Payment Terms Policy could not be resolved',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

export type CustomerCommercePaymentTermsPolicyRequest = Readonly<{
  at: string;
  purchasingContext: CustomerCommercePaymentTermsPolicyContext['purchasingContext'];
}>;

export type CustomerCommercePaymentTermsPolicyResolver = Readonly<{
  resolve: (
    input: CustomerCommercePaymentTermsPolicyRequest,
  ) => Effect.Effect<PaymentTermsPolicyResolution, PaymentTermsDependencyUnavailable>;
}>;

export const customerCommercePaymentTermsPolicyResolver = (
  audience: CustomerCommercePaymentTermsPolicyContext['audience'],
  trustedScope: Readonly<{
    tenantId: string;
    trustedStorefrontId: string;
  }>,
): CustomerCommercePaymentTermsPolicyResolver => ({
  resolve: (input) =>
    policyConfiguration.pipe(
      Effect.mapError(unavailable),
      Effect.map((configuration) =>
        resolveCustomerCommercePaymentTermsPolicy(configuration, {
          at: input.at,
          audience,
          purchasingContext: input.purchasingContext,
          tenantId: trustedScope.tenantId,
          trustedStorefrontId: trustedScope.trustedStorefrontId,
        }),
      ),
    ),
});
