import { Context, Schema } from 'effect';
import type { Effect } from 'effect';
import type { PurchaseLimitComparableValue } from './purchase-limit-evaluation.ts';
import type { PurchaseValue } from './purchase-limit.ts';

export const PurchaseLimitFxUnavailableSchema = Schema.TaggedStruct('PurchaseLimitFxUnavailable', {
  code: Schema.Literal('purchase_limit_fx_unavailable'),
  reason: Schema.String,
});
export type PurchaseLimitFxUnavailable = typeof PurchaseLimitFxUnavailableSchema.Type;

export type PurchaseLimitFxPort = Readonly<{
  comparableValue: (input: {
    readonly purchaseValue: PurchaseValue;
    readonly targetCurrency: string;
  }) => Effect.Effect<PurchaseLimitComparableValue, PurchaseLimitFxUnavailable>;
}>;

export class PurchaseLimitFx extends Context.Service<PurchaseLimitFx, PurchaseLimitFxPort>()(
  '@app/commerce-customer-context/shared/domain/purchase-limit-fx-port/PurchaseLimitFx',
) {}
