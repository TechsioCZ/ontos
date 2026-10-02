import type { TrustedPrincipalContext } from '@app/core-runtime';
import type { PriceProductTargetOutcomeIdentity } from '@app/pricing-contracts/domain/catalog-price-target';
import type { PriceRef } from '@app/pricing-contracts/resources/price';
import { createHash } from 'node:crypto';
import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

import type { ManageProductPriceOperation } from '../../shared/actions/manage-product-prices-bulk.ts';

export interface ProductPriceBulkTrustedContext {
  readonly actionInvocationId: string;
  readonly principalContext: TrustedPrincipalContext;
  readonly requestCorrelationId: string;
  readonly trustedOperationAt: Date;
}

export interface ProductPriceBulkTargetIntent<Operation> {
  readonly identity: PriceProductTargetOutcomeIdentity;
  readonly intentId: string;
  readonly operation: Operation;
  readonly targetCorrelationRef: string;
}

export interface ProductPriceBulkCanonicalRefs {
  readonly priceRef: PriceRef;
  readonly revisionId?: string;
}

export type ProductPriceBulkOwnerOutcome =
  | { readonly canonical: ProductPriceBulkCanonicalRefs; readonly outcome: 'APPLIED' | 'UNCHANGED' }
  | { readonly outcome: 'REJECTED' | 'CONFLICT' | 'INDETERMINATE'; readonly reasonCode: string };

export type ProductPriceBulkReconciliation =
  | { readonly status: 'ABSENT' | 'RETRY_ALLOWED' }
  | { readonly outcome: ProductPriceBulkOwnerOutcome; readonly status: 'RESOLVED' };

export const ProductPriceBulkPortFailureSchema = Schema.TaggedStruct('ProductPriceBulkPortFailure', {
  cause: Schema.optional(Schema.Unknown),
  code: Schema.String,
});
export type ProductPriceBulkPortFailure = typeof ProductPriceBulkPortFailureSchema.Type;

export interface ProductPriceBulkCommand<Operation> extends ProductPriceBulkTargetIntent<Operation> {
  readonly trusted: ProductPriceBulkTrustedContext;
}

/** Stable owner-local Action identity used to reconcile one target across later bulk retries. */
export const productPriceBulkActionInvocationIdFor = (tenantId: string, intentId: string): string => {
  const digest = createHash('sha256')
    .update(`commerce.pricing:product-price-bulk:${tenantId}:${intentId}`)
    .digest('hex');
  const variant = ['8', '9', 'a', 'b'][Number.parseInt(digest[16] ?? '0', 16) % 4] ?? '8';
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

/**
 * Each command remains one independently authorized exact-Price intent. For REVISE_PRICE, the
 * adapter must authoritatively prove that payload.priceRef owns identity.target before mutation.
 */
export interface ProductPriceBulkCommandPort<Operation> {
  readonly executeAuthorizedExactPriceAction: (
    command: ProductPriceBulkCommand<Operation>,
  ) => Effect.Effect<ProductPriceBulkOwnerOutcome, ProductPriceBulkPortFailure>;
  readonly reconcileAuthorizedExactPriceAction: (
    command: ProductPriceBulkCommand<Operation>,
  ) => Effect.Effect<ProductPriceBulkReconciliation, ProductPriceBulkPortFailure>;
}

/** Supplied only by the authorized exact-Price Action runtime and owner-result adapter. */
class ProductPriceBulkCommandExecution extends Context.Service<
  ProductPriceBulkCommandExecution,
  ProductPriceBulkCommandPort<ManageProductPriceOperation>
>()('@app/pricing/services/product-price-bulk-command.port/ProductPriceBulkCommandExecution') {}

export const productPriceBulkCommandExecution = (
  port: ProductPriceBulkCommandPort<ManageProductPriceOperation>,
): ProductPriceBulkCommandPort<ManageProductPriceOperation> => ProductPriceBulkCommandExecution.of(port);
