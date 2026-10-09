import { Effect, Schema } from 'effect';
import type { CurrentCommerceQuantityPolicySet } from './customer-commerce-policy-administration.ts';

export const CommerceQuantityPolicyUnavailableSchema = Schema.TaggedStruct('CommerceQuantityPolicyUnavailable', {
  reason: Schema.String,
  retryable: Schema.Literal(true),
});
export type CommerceQuantityPolicyUnavailable = typeof CommerceQuantityPolicyUnavailableSchema.Type;

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- The governed Read factory supplies this transaction-scoped policy port explicitly rather than through ambient Context.
export interface CommerceQuantityPolicyPortService {
  readonly readCurrent: (
    at: string,
  ) => Effect.Effect<CurrentCommerceQuantityPolicySet, CommerceQuantityPolicyUnavailable>;
}

export const unavailableCommerceQuantityPolicyPort = (): CommerceQuantityPolicyPortService => ({
  readCurrent: () =>
    Effect.fail({
      _tag: 'CommerceQuantityPolicyUnavailable',
      reason: 'The Current Commerce Quantity Policy provider is not configured',
      retryable: true,
    }),
});
