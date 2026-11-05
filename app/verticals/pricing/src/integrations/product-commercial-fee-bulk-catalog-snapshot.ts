import type { OperationalScope } from '@app/core-runtime';
import { executeProductVariantSnapshotWithAuthorization } from '@app/catalog/api/client';
import { CatalogSelectionValidEvidenceSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { priceCatalogTargetsEqual } from '@app/pricing-contracts/domain/catalog-price-target';
import type { PricingCommercialFeeProductTargetSnapshot } from '@app/pricing-contracts/domain/commercial-fee';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Crypto, Effect, Redacted, Schema } from 'effect';

import { PricingCatalogSelectionUnavailable } from '../../shared/domain/pricing-catalog-selection-unavailable.ts';
import { acquireOwnerGatewayConnection } from './owner-gateway-connection.ts';
import type { OwnerGatewayConnectionAcquire } from './owner-gateway-connection.ts';

type SnapshotRequest = Parameters<typeof executeProductVariantSnapshotWithAuthorization>[0];
type SnapshotEffect = ReturnType<typeof executeProductVariantSnapshotWithAuthorization>;
type SnapshotResponse = SnapshotEffect extends Effect.Effect<infer Success, unknown, unknown> ? Success : never;
type SnapshotFailure = SnapshotEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type SnapshotExecutor = (
  payload: SnapshotRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL; readonly compositionRevision: string },
) => Effect.Effect<SnapshotResponse, SnapshotFailure>;

export interface ProductCommercialFeeBulkCatalogSnapshotPort {
  readonly validateCurrent: (
    snapshot: PricingCommercialFeeProductTargetSnapshot,
  ) => Effect.Effect<boolean, PricingCatalogSelectionUnavailable>;
}

const sameResourceRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameCatalogEvidence = Schema.toEquivalence(CatalogSelectionValidEvidenceSchema);
const sameCompleteness = Schema.toEquivalence(Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema));

const executeSnapshot: SnapshotExecutor = (payload, credential, requestCorrelation, options) =>
  executeProductVariantSnapshotWithAuthorization(payload, Redacted.value(credential), requestCorrelation, options);

const unavailable = (reason: string, cause?: unknown): PricingCatalogSelectionUnavailable => {
  const failure = new PricingCatalogSelectionUnavailable({
    code: 'pricing_catalog_selection_unavailable',
    reason,
    retryable: true,
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

export interface ProductCommercialFeeBulkOwnerSnapshotObservation {
  readonly capturedAt: PricingCommercialFeeProductTargetSnapshot['capturedAt'];
  readonly catalogOwnerRevision: string;
  readonly productRef: PricingCommercialFeeProductTargetSnapshot['productRef'];
  readonly snapshotId: string;
  readonly targets: readonly {
    readonly catalogEvidence: PricingCommercialFeeProductTargetSnapshot['targets'][number]['catalogEvidence'];
    readonly target: PricingCommercialFeeProductTargetSnapshot['targets'][number]['target'];
    readonly targetId: string;
  }[];
  readonly targetSetCompleteness: PricingCommercialFeeProductTargetSnapshot['targetSetCompleteness'];
}

export const productCommercialFeeBulkSnapshotMatchesCurrentOwnerRead = (
  supplied: PricingCommercialFeeProductTargetSnapshot,
  current: ProductCommercialFeeBulkOwnerSnapshotObservation,
): boolean =>
  sameResourceRef(supplied.productRef, current.productRef) &&
  supplied.capturedAt <= current.capturedAt &&
  supplied.catalogOwnerRevision === current.catalogOwnerRevision &&
  supplied.snapshotId === current.snapshotId &&
  sameCompleteness(
    { ...supplied.targetSetCompleteness, observedAt: current.targetSetCompleteness.observedAt },
    current.targetSetCompleteness,
  ) &&
  supplied.targets.length === current.targets.length &&
  supplied.targets.every((target, index) => {
    const ownerTarget = current.targets[index];
    return (
      ownerTarget !== undefined &&
      target.targetId === ownerTarget.targetId &&
      priceCatalogTargetsEqual(target.target, ownerTarget.target) &&
      target.catalogEvidence.assessedAt <= ownerTarget.catalogEvidence.assessedAt &&
      sameCatalogEvidence(
        {
          ...target.catalogEvidence,
          assessedAt: ownerTarget.catalogEvidence.assessedAt,
          membership: {
            ...target.catalogEvidence.membership,
            attestationId: ownerTarget.catalogEvidence.membership.attestationId,
            observedAt: ownerTarget.catalogEvidence.membership.observedAt,
          },
        },
        ownerTarget.catalogEvidence,
      )
    );
  });

export const makeProductCommercialFeeBulkCatalogSnapshotPort = (dependencies: {
  readonly acquire: OwnerGatewayConnectionAcquire;
  readonly context: {
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
    readonly scope: OperationalScope;
  };
  readonly execute: SnapshotExecutor;
}): ProductCommercialFeeBulkCatalogSnapshotPort => ({
  validateCurrent: (snapshot) =>
    dependencies
      .acquire({
        audience: 'catalog',
        compositionRevision: dependencies.context.compositionRevision,
        // The Catalog snapshot contract is tenant-scoped and forbids Legal Entity context.
        legalEntityScope: 'tenant',
        requestCorrelation: dependencies.context.requestCorrelation,
        scope: dependencies.context.scope,
      })
      .pipe(
        Effect.flatMap(({ baseUrl, credential }) =>
          dependencies.execute(
            { productRef: snapshot.productRef },
            credential,
            dependencies.context.requestCorrelation,
            { baseUrl, compositionRevision: dependencies.context.compositionRevision },
          ),
        ),
        Effect.mapError((cause) =>
          Schema.is(PricingCatalogSelectionUnavailable)(cause)
            ? cause
            : unavailable('Catalog Product/Variant snapshot revalidation is unavailable', cause),
        ),
        Effect.map((current) => productCommercialFeeBulkSnapshotMatchesCurrentOwnerRead(snapshot, current)),
      ),
});

export const productCommercialFeeBulkCatalogSnapshotPortFromEnvironment = Effect.fn(
  'productCommercialFeeBulkCatalogSnapshotPortFromEnvironment',
)(function* productCommercialFeeBulkCatalogSnapshotPortFromEnvironment(
  context: {
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
    readonly scope: OperationalScope;
  },
  execute: SnapshotExecutor = executeSnapshot,
): Effect.fn.Return<ProductCommercialFeeBulkCatalogSnapshotPort, never, Crypto.Crypto> {
  const crypto = yield* Crypto.Crypto;
  return makeProductCommercialFeeBulkCatalogSnapshotPort({
    acquire: (input) => acquireOwnerGatewayConnection(input, crypto),
    context,
    execute,
  });
});
