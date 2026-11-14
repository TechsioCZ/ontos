import type { ActionServicePreparationContext, OperationalScope } from '@app/core-runtime';
import { OperationContextUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { executeProductVariantSnapshotWithAuthorization } from '@app/catalog/api/client';
import type { PricingCommercialFeeCatalogTargetEvidence } from '@app/pricing-contracts/domain/commercial-fee';
import { PricingCommercialFeeCatalogTargetEvidenceSchema } from '@app/pricing-contracts/domain/commercial-fee';
import { Crypto, DateTime, Effect, Redacted, Schema } from 'effect';

import { PricingCatalogSelectionUnavailable } from '../../shared/domain/pricing-catalog-selection-unavailable.ts';
import { CommercialFeePersistenceUnavailable } from '../services/commercial-fee-persistence.service.ts';
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

const observePreparedFeeTarget = Effect.fn('CommercialFeeCatalogTarget.observePrepared')(
  function* observeTarget(input: {
    readonly context: ActionServicePreparationContext;
    readonly selector: PricingCommercialFeeCatalogTargetEvidence;
  }) {
    const { context, selector } = input;
    let snapshot: SnapshotResponse | undefined;
    const live = yield* commercialFeeCatalogTargetAssessmentPortFromEnvironment(
      {
        compositionRevision: context.compositionRevision,
        legalEntityId: context.scope.legalEntityId ?? '',
        requestCorrelation: context.scope.correlationId,
        scope: context.scope,
      },
      (payload, credential, correlation, options) =>
        executeSnapshot(payload, credential, correlation, options).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              snapshot = value;
            }),
          ),
        ),
    );
    const valid = yield* Effect.result(live.validate(selector));
    return { selector, snapshot, valid };
  },
);

/** Immutable payload selectors only. Never fall back to HTTP for a different target. */
export const prepareCommercialFeeCatalogTargets = Effect.fn('CommercialFeeCatalogTarget.prepare')(function* prepare(
  evidence: readonly PricingCommercialFeeCatalogTargetEvidence[],
  context: ActionServicePreparationContext,
) {
  const { legalEntityId } = context.scope;
  if (
    legalEntityId === undefined ||
    evidence.some(
      (item) =>
        item.productRef.tenantId !== context.scope.tenantId || item.variantRef.tenantId !== context.scope.tenantId,
    )
  ) {
    return yield* new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason: 'Fee Catalog preparation requires the exact Tenant and Legal Entity',
    });
  }
  const observations = yield* Effect.forEach(evidence, (selector) => observePreparedFeeTarget({ context, selector }), {
    concurrency: 1,
  });
  const same = Schema.toEquivalence(PricingCommercialFeeCatalogTargetEvidenceSchema);
  return {
    validate: (selector) => {
      const observed = observations.find((item) => same(item.selector, selector));
      return observed === undefined
        ? Effect.fail(unavailable('No Catalog assessment exists for this exact invocation selector'))
        : Effect.gen(function* validatePreparedTarget() {
            const valid = yield* Effect.fromResult(observed.valid);
            if (!valid) {
              return false;
            }
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const target = observed.snapshot?.targets.find((item) => item.targetId === selector.targetId);
            if (
              observed.snapshot === undefined ||
              target === undefined ||
              DateTime.toEpochMillis(DateTime.makeUnsafe(observed.snapshot.capturedAt)) > now ||
              (target.catalogEvidence.validUntil !== undefined &&
                DateTime.toEpochMillis(DateTime.makeUnsafe(target.catalogEvidence.validUntil)) <= now)
            ) {
              return yield* unavailable('Prepared Catalog evidence is missing, not yet valid, or expired');
            }
            return true;
          });
    },
  } satisfies CommercialFeeCatalogTargetAssessmentPort;
});

export const assertPreparedPricingScope = (
  context: ActionServicePreparationContext,
  scope: OperationalScope,
  compositionRevision: string,
) =>
  compositionRevision === context.compositionRevision &&
  scope.correlationId === context.scope.correlationId &&
  Schema.toEquivalence(TrustedPrincipalContextSchema)(scope, context.scope)
    ? Effect.void
    : Effect.fail(
        new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'Prepared Pricing evidence belongs to another operation scope or composition',
        }),
      );

/** Recheck retained validity after a potentially blocking SQL write, without another HTTP call. */
export const fencePreparedCommercialFeeTarget = (
  catalog: CommercialFeeCatalogTargetAssessmentPort,
  evidence: PricingCommercialFeeCatalogTargetEvidence,
) =>
  catalog.validate(evidence).pipe(
    Effect.mapError((cause) =>
      Object.defineProperty(
        new CommercialFeePersistenceUnavailable({
          reason: 'Prepared Catalog evidence expired while writing the Commercial Fee',
        }),
        'cause',
        { value: cause },
      ),
    ),
    Effect.flatMap((valid) =>
      valid
        ? Effect.void
        : Effect.fail(
            new CommercialFeePersistenceUnavailable({
              reason: 'Prepared Catalog evidence no longer validates the Commercial Fee target',
            }),
          ),
    ),
  );
