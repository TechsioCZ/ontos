import type { OperationalScope } from '@app/core-runtime';
import { executeProductVariantSnapshotWithAuthorization } from '@app/catalog/api/client';
import type { PricingCommercialFeeCatalogTargetEvidence } from '@app/pricing-contracts/domain/commercial-fee';
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

export const makeCommercialFeeCatalogTargetAssessmentPort = (dependencies: {
  readonly acquire: OwnerGatewayConnectionAcquire;
  readonly context: {
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
    readonly scope: OperationalScope;
  };
  readonly execute: SnapshotExecutor;
}): CommercialFeeCatalogTargetAssessmentPort => ({
  validate: (evidence) =>
    dependencies
      .acquire({
        audience: 'catalog',
        compositionRevision: dependencies.context.compositionRevision,
        // Catalog's Product/Variant snapshot is tenant-scoped and forbids Legal Entity context.
        legalEntityScope: 'tenant',
        requestCorrelation: dependencies.context.requestCorrelation,
        scope: dependencies.context.scope,
      })
      .pipe(
        Effect.flatMap(({ baseUrl, credential }) =>
          dependencies.execute(
            { productRef: evidence.productRef },
            credential,
            dependencies.context.requestCorrelation,
            { baseUrl, compositionRevision: dependencies.context.compositionRevision },
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

export const commercialFeeCatalogTargetAssessmentPortFromEnvironment = Effect.fn(
  'commercialFeeCatalogTargetAssessmentPortFromEnvironment',
)(function* commercialFeeCatalogTargetAssessmentPortFromEnvironment(
  context: {
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
    readonly scope: OperationalScope;
  },
  execute: SnapshotExecutor = executeSnapshot,
): Effect.fn.Return<CommercialFeeCatalogTargetAssessmentPort, never, Crypto.Crypto> {
  const crypto = yield* Crypto.Crypto;
  return makeCommercialFeeCatalogTargetAssessmentPort({
    acquire: (input) => acquireOwnerGatewayConnection(input, crypto),
    context,
    execute,
  });
});
