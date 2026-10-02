import { executeProductVariantSnapshotWithAuthorization } from '@app/catalog/api/client';
import type { PricingCommercialFeeCatalogTargetEvidence } from '@app/pricing-contracts/domain/commercial-fee';
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

export interface CommercialFeeCatalogTargetAssessmentPort {
  readonly validate: (
    evidence: PricingCommercialFeeCatalogTargetEvidence,
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

const snapshotMatchesEvidence = (
  snapshot: SnapshotResponse,
  evidence: PricingCommercialFeeCatalogTargetEvidence,
): boolean =>
  sameResourceRef(snapshot.productRef, evidence.productRef) &&
  // Catalog observes the same revision cut at statement time on every read. A later observation
  // of the same deterministic snapshot is valid; requiring timestamp equality would reject every
  // real revalidation round-trip even when no Product or Variant revision changed.
  snapshot.capturedAt >= evidence.capturedAt &&
  snapshot.catalogOwnerRevision === evidence.catalogOwnerRevision &&
  snapshot.snapshotId === evidence.snapshotId &&
  snapshot.targets.some(
    ({ target, targetId }) =>
      targetId === evidence.targetId &&
      target.configuration === undefined &&
      target.packageOption === undefined &&
      target.setComposition === undefined &&
      sameResourceRef(target.variantRef, evidence.variantRef),
  );

const makePort = (dependencies: {
  readonly context: { readonly legalEntityId: string; readonly requestCorrelation: string };
  readonly execute: SnapshotExecutor;
  readonly issuer: CatalogSelectionGatewayCredentialIssuer;
}): CommercialFeeCatalogTargetAssessmentPort => ({
  validate: (evidence) =>
    dependencies.issuer
      .issue({
        audience: 'catalog',
        legalEntityId: dependencies.context.legalEntityId,
        requestCorrelation: dependencies.context.requestCorrelation,
      })
      .pipe(
        Effect.flatMap(({ baseUrl, credential }) =>
          dependencies.execute(
            { productRef: evidence.productRef },
            credential,
            dependencies.context.requestCorrelation,
            { baseUrl },
          ),
        ),
        Effect.mapError((cause) =>
          Schema.is(PricingCatalogSelectionUnavailable)(cause)
            ? cause
            : unavailable('Catalog Product/Variant snapshot validation is unavailable', cause),
        ),
        Effect.map((snapshot) => snapshotMatchesEvidence(snapshot, evidence)),
      ),
});

export const commercialFeeCatalogTargetAssessmentPortFromEnvironment = (
  context: { readonly legalEntityId: string; readonly requestCorrelation: string },
  execute: SnapshotExecutor = executeSnapshot,
): Effect.Effect<CommercialFeeCatalogTargetAssessmentPort> =>
  Effect.serviceOption(CatalogSelectionGatewayCredentialService).pipe(
    Effect.map((issuerOption) =>
      makePort({
        context,
        execute,
        issuer: Option.isSome(issuerOption) ? issuerOption.value : unavailableCatalogSelectionGatewayCredentialIssuer,
      }),
    ),
  );
