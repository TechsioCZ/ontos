import type { TrustedPrincipalContext } from '@app/core-runtime';
import type { PriceProductTargetOutcomeIdentity } from '@app/pricing-contracts/domain/catalog-price-target';
import type {
  PricingCommercialFeeCatalogTargetEvidence,
  PricingCommercialFeeRef,
  PricingCommercialFeeRevisionId,
  PricingCommercialFeeScheduleAcknowledgement,
} from '@app/pricing-contracts/domain/commercial-fee';
import { createHash } from 'node:crypto';
import { Context } from 'effect';
import type { Effect } from 'effect';

import type { ManageProductCommercialFeeOperation } from '../../shared/actions/manage-product-commercial-fees-bulk.ts';

export interface ProductCommercialFeeBulkTrustedContext {
  readonly actionInvocationId: string;
  readonly principalContext: TrustedPrincipalContext;
  readonly requestCorrelationId: string;
  readonly trustedOperationAt: Date;
}

export interface ProductCommercialFeeBulkTargetIntent<Operation> {
  readonly catalogTargetEvidence: PricingCommercialFeeCatalogTargetEvidence;
  readonly identity: PriceProductTargetOutcomeIdentity;
  readonly intentId: string;
  readonly operation: Operation;
  readonly targetCorrelationRef: string;
}

export interface ProductCommercialFeeBulkCanonicalRefs {
  readonly feeRef: PricingCommercialFeeRef;
  readonly revisionId?: PricingCommercialFeeRevisionId;
}

export type ProductCommercialFeeBulkOwnerOutcome =
  | {
      readonly canonical: ProductCommercialFeeBulkCanonicalRefs;
      readonly outcome: 'CREATED' | 'CHANGED' | 'SCHEDULED' | 'CORRECTED' | 'RETIRED' | 'UNCHANGED';
    }
  | {
      readonly acknowledgementChallenge?: PricingCommercialFeeScheduleAcknowledgement;
      readonly outcome: 'CONFLICT' | 'INDETERMINATE' | 'REJECTED';
      readonly reasonCode: string;
    };

export type ProductCommercialFeeBulkReconciliation =
  | { readonly status: 'ABSENT' | 'RETRY_ALLOWED' }
  | { readonly outcome: ProductCommercialFeeBulkOwnerOutcome; readonly status: 'RESOLVED' };

export interface ProductCommercialFeeBulkPortFailure {
  readonly _tag: string;
}

export interface ProductCommercialFeeBulkCommand<Operation> extends ProductCommercialFeeBulkTargetIntent<Operation> {
  readonly trusted: ProductCommercialFeeBulkTrustedContext;
}

/** Stable owner-local Action identity used to reconcile one target across later bulk retries. */
export const productCommercialFeeBulkActionInvocationIdFor = (tenantId: string, intentId: string): string => {
  const digest = createHash('sha256')
    .update(`commerce.pricing:product-commercial-fee-bulk:${tenantId}:${intentId}`)
    .digest('hex');
  const variant = ['8', '9', 'a', 'b'][Number.parseInt(digest[16] ?? '0', 16) % 4] ?? '8';
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

/**
 * The adapter is the only production seam allowed to execute or reconcile the independently
 * authorized single-target Commercial Fee Action. It must never infer Product membership or
 * recursively invoke a public Action inside the outer bulk Action transaction.
 */
export interface ProductCommercialFeeBulkCommandPort<Operation> {
  readonly executeAuthorizedCommercialFeeAction: (
    command: ProductCommercialFeeBulkCommand<Operation>,
  ) => Effect.Effect<ProductCommercialFeeBulkOwnerOutcome, ProductCommercialFeeBulkPortFailure>;
  readonly reconcileAuthorizedCommercialFeeAction: (
    command: ProductCommercialFeeBulkCommand<Operation>,
  ) => Effect.Effect<ProductCommercialFeeBulkReconciliation, ProductCommercialFeeBulkPortFailure>;
}

/** Supplied only by an authoritative owner adapter. */
class ProductCommercialFeeBulkCommandExecution extends Context.Service<
  ProductCommercialFeeBulkCommandExecution,
  ProductCommercialFeeBulkCommandPort<ManageProductCommercialFeeOperation>
>()('@app/pricing/services/product-commercial-fee-bulk-command.port/ProductCommercialFeeBulkCommandExecution') {}

export const productCommercialFeeBulkCommandExecution = (
  port: ProductCommercialFeeBulkCommandPort<ManageProductCommercialFeeOperation>,
): ProductCommercialFeeBulkCommandPort<ManageProductCommercialFeeOperation> =>
  ProductCommercialFeeBulkCommandExecution.of(port);
