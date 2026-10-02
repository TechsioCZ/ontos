import { executeProductVariantSnapshotWithAuthorization } from '@app/catalog/api/client';
import { CatalogSelectionValidEvidenceSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { priceCatalogTargetsEqual } from '@app/pricing-contracts/domain/catalog-price-target';
import type { PricingCommercialFeeProductTargetSnapshot } from '@app/pricing-contracts/domain/commercial-fee';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Effect, Option, Redacted, Schema } from 'effect';

import {
  CatalogSelectionGatewayCredentialService,
  PricingCatalogSelectionUnavailable,
  unavailableCatalogSelectionGatewayCredentialIssuer,
} from '../../shared/domain/catalog-selection-gateway-credential.ts';
import type { CatalogSelectionGatewayCredentialIssuer } from '../../shared/domain/catalog-selection-gateway-credential.ts';

type SnapshotRequest = Parameters<typeof executeProductVariantSnapshotWithAuthorization>[0];
type SnapshotEffect = ReturnType<typeof executeProductVariantSnapshotWithAuthorization>;
type SnapshotResponse = SnapshotEffect extends Effect.Effect<infer Success, unknown, unknown> ? Success : never;
type SnapshotFailure = SnapshotEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type SnapshotExecutor = (
  payload: SnapshotRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL },
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

const makePort = (dependencies: {
  readonly context: { readonly legalEntityId: string; readonly requestCorrelation: string };
  readonly execute: SnapshotExecutor;
  readonly issuer: CatalogSelectionGatewayCredentialIssuer;
}): ProductCommercialFeeBulkCatalogSnapshotPort => ({
  validateCurrent: (snapshot) =>
    dependencies.issuer
      .issue({
        audience: 'catalog',
        legalEntityId: dependencies.context.legalEntityId,
        requestCorrelation: dependencies.context.requestCorrelation,
      })
      .pipe(
        Effect.flatMap(({ baseUrl, credential }) =>
          dependencies.execute(
            { productRef: snapshot.productRef },
            credential,
            dependencies.context.requestCorrelation,
            { baseUrl },
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

export const productCommercialFeeBulkCatalogSnapshotPortFromEnvironment = (
  context: { readonly legalEntityId: string; readonly requestCorrelation: string },
  execute: SnapshotExecutor = executeSnapshot,
): Effect.Effect<ProductCommercialFeeBulkCatalogSnapshotPort> =>
  Effect.serviceOption(CatalogSelectionGatewayCredentialService).pipe(
    Effect.map((issuerOption) =>
      makePort({
        context,
        execute,
        issuer: Option.isSome(issuerOption) ? issuerOption.value : unavailableCatalogSelectionGatewayCredentialIssuer,
      }),
    ),
  );
