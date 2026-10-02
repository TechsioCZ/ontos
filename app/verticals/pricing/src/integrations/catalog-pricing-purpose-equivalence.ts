import type {
  PricingPurposeEquivalenceRequest,
  PricingPurposeEquivalenceResponse,
} from '@app/catalog/api/pricing-purpose-equivalence';
import {
  PricingPurposeEquivalenceRequestSchema,
  PricingPurposeEquivalenceResponseSchema,
} from '@app/catalog/api/pricing-purpose-equivalence';
import { executePricingPurposeEquivalenceWithAuthorization } from '@app/catalog/api/pricing-purpose-equivalence-client';
import { CatalogQuantityBasisSchema } from '@app/catalog/domain/catalog-quantity-handoff';
import type { CatalogQuantityHandoffReady } from '@app/catalog/domain/catalog-quantity-handoff';
import { CatalogResourceRefSchema } from '@app/catalog/domain/catalog-revision-reference';
import {
  CatalogSelectionBasisListSchema,
  CatalogSelectionSchema,
} from '@app/catalog/domain/catalog-selection-evidence';
import type {
  CatalogPricingPurposeEquivalenceResolution,
  QuantityTierAggregationAttempt,
} from '@app/pricing-contracts/domain/quantity-tier-aggregation';
import { CatalogPricingPurposeEquivalenceResolutionSchema } from '@app/pricing-contracts/domain/quantity-tier-aggregation';
import { PricingCommercialScopeSchema } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import { Context, Effect, Option, Redacted, Schema } from 'effect';

import type { CatalogSelectionGatewayCredentialIssuer } from '../../shared/domain/catalog-selection-gateway-credential.ts';
import {
  CatalogSelectionGatewayCredentialService,
  PricingCatalogSelectionUnavailable,
  unavailableCatalogSelectionGatewayCredentialIssuer,
} from '../../shared/domain/catalog-selection-gateway-credential.ts';

type ClientEffect = ReturnType<typeof executePricingPurposeEquivalenceWithAuthorization>;
type ClientFailure = ClientEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type Executor = (
  payload: PricingPurposeEquivalenceRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL },
) => Effect.Effect<unknown, ClientFailure>;

export interface CatalogPricingPurposeEquivalencePort {
  readonly resolve: (
    attempt: QuantityTierAggregationAttempt,
  ) => Effect.Effect<CatalogPricingPurposeEquivalenceResolution, PricingCatalogSelectionUnavailable>;
}

class CatalogPricingPurposeEquivalenceService extends Context.Service<
  CatalogPricingPurposeEquivalenceService,
  CatalogPricingPurposeEquivalencePort
>()('@app/pricing/integrations/catalog-pricing-purpose-equivalence/CatalogPricingPurposeEquivalenceService') {}

const executeAuthorized: Executor = (payload, credential, requestCorrelation, options) =>
  executePricingPurposeEquivalenceWithAuthorization(payload, Redacted.value(credential), requestCorrelation, options);

const unavailable = (reason: string, cause?: unknown): PricingCatalogSelectionUnavailable => {
  const failure = new PricingCatalogSelectionUnavailable({
    code: 'pricing_catalog_selection_unavailable',
    reason,
    retryable: true,
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const sameSelection = Schema.toEquivalence(CatalogSelectionSchema);
const sameCommercialScope = Schema.toEquivalence(PricingCommercialScopeSchema);
const sameQuantityBasis = Schema.toEquivalence(CatalogQuantityBasisSchema);
const sameSelectionBasis = Schema.toEquivalence(CatalogSelectionBasisListSchema);
const sameResourceRef = Schema.toEquivalence(CatalogResourceRefSchema);
const resourceRefKey = (resourceRef: {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}): string => [resourceRef.moduleId, resourceRef.resourceType, resourceRef.resourceId, resourceRef.tenantId].join('|');
const revisionKey = (revision: {
  readonly resourceRef: Parameters<typeof resourceRefKey>[0];
  readonly revision: number;
  readonly revisionId?: string;
}): string => `${resourceRefKey(revision.resourceRef)}|${revision.revision}|${revision.revisionId ?? ''}`;
const packageContentKey = (handoff: CatalogQuantityHandoffReady): string => {
  const content = handoff.packageContent;
  return content === undefined
    ? 'none'
    : `${content.amount}|${resourceRefKey(content.unitRef)}|${content.path.map(revisionKey).join('/')}`;
};
const packageRevisionKey = (handoff: CatalogQuantityHandoffReady): string => {
  const revision = handoff.packageRevision;
  if (revision === undefined) {
    return 'none';
  }
  return [
    revisionKey(revision.reference),
    revision.amount,
    resourceRefKey(revision.unitRef),
    resourceRefKey(revision.form.productRef),
    resourceRefKey(revision.form.variantRef),
    revision.configurationKey ?? '',
    revision.setComposition === undefined ? '' : revisionKey(revision.setComposition),
    revision.lower === undefined ? '' : `${revision.lower.count}:${revisionKey(revision.lower.revision)}`,
  ].join('|');
};
const sameOwnerMetadata = (supplied: CatalogQuantityHandoffReady, current: CatalogQuantityHandoffReady): boolean =>
  supplied.completeness.ownerRevision === supplied.ownerRevision &&
  current.completeness.ownerRevision === current.ownerRevision &&
  supplied.completeness.scope.kind === current.completeness.scope.kind &&
  supplied.completeness.scope.predicateRef === current.completeness.scope.predicateRef;

const semanticHandoffMatches = (supplied: CatalogQuantityHandoffReady, current: CatalogQuantityHandoffReady): boolean =>
  sameSelection(supplied.selection, current.selection) &&
  sameSelection(supplied.evidence.selection, current.evidence.selection) &&
  sameOwnerMetadata(supplied, current) &&
  supplied.equivalentSelectionKey === current.equivalentSelectionKey &&
  supplied.hierarchyRevision === current.hierarchyRevision &&
  supplied.divisible === current.divisible &&
  supplied.quantity.requested === current.quantity.requested &&
  supplied.quantity.resulting === current.quantity.resulting &&
  supplied.quantity.changed === current.quantity.changed &&
  supplied.quantity.notice === current.quantity.notice &&
  supplied.quantity.rounding === current.quantity.rounding &&
  supplied.quantity.step === current.quantity.step &&
  supplied.quantity.targetId === current.quantity.targetId &&
  supplied.quantity.unitId === current.quantity.unitId &&
  supplied.quantity.unitRuleRevision === current.quantity.unitRuleRevision &&
  sameResourceRef(supplied.unitRef, current.unitRef) &&
  sameQuantityBasis(supplied.quantityBasis, current.quantityBasis) &&
  sameSelectionBasis(supplied.evidence.basis, current.evidence.basis) &&
  packageContentKey(supplied) === packageContentKey(current) &&
  packageRevisionKey(supplied) === packageRevisionKey(current);

const requestFor = (attempt: QuantityTierAggregationAttempt) => ({
  anchorSelection:
    attempt.participants[0]?.exactPrice.price.definition.identityKey.catalogSelection ??
    attempt.participants[0]?.line.catalog.selection,
  effectiveAt: attempt.evaluatedAt,
  members: attempt.participants.map(({ line }) => ({
    handoff: line.catalog,
    occurrenceId: line.occurrenceId,
  })),
});

const observedResponseBinds = (
  response: Exclude<PricingPurposeEquivalenceResponse, { readonly outcome: 'CATALOG_EQUIVALENCE_UNAVAILABLE' }>,
  request: PricingPurposeEquivalenceRequest,
): boolean => {
  const expectedStatus = {
    CATALOG_EQUIVALENCE_CONFIRMED: 'CURRENT',
    CATALOG_EQUIVALENCE_CONFLICT: 'CONFLICT',
    CATALOG_EQUIVALENCE_NON_EQUIVALENT: 'CURRENT',
    CATALOG_EQUIVALENCE_STALE: 'STALE',
    CATALOG_EQUIVALENCE_UNVERIFIABLE: 'UNVERIFIABLE',
  } as const;
  if (
    response.currentness.effectiveAt !== request.effectiveAt ||
    response.currentness.status !== expectedStatus[response.outcome] ||
    response.assessments.length > request.members.length + 1
  ) {
    return false;
  }
  if (response.assessments.length === 0) {
    return response.outcome === 'CATALOG_EQUIVALENCE_STALE' || response.outcome === 'CATALOG_EQUIVALENCE_UNVERIFIABLE';
  }
  const [anchor, ...members] = response.assessments;
  if (
    anchor === undefined ||
    anchor.role !== 'ANCHOR' ||
    !sameSelection(anchor.handoff.selection, request.anchorSelection)
  ) {
    return false;
  }
  const membersBind = members.every((assessment, index) => {
    const requested = request.members[index];
    return (
      assessment.role === 'MEMBER' &&
      requested !== undefined &&
      assessment.occurrenceId === requested.occurrenceId &&
      sameSelection(assessment.handoff.selection, requested.handoff.selection)
    );
  });
  return (
    membersBind &&
    (response.outcome === 'CATALOG_EQUIVALENCE_STALE' ||
      response.outcome === 'CATALOG_EQUIVALENCE_UNVERIFIABLE' ||
      response.assessments.length === request.members.length + 1)
  );
};

const confirmedResponseBinds = (
  response: Extract<PricingPurposeEquivalenceResponse, { readonly outcome: 'CATALOG_EQUIVALENCE_CONFIRMED' }>,
  request: PricingPurposeEquivalenceRequest,
): boolean => {
  if (
    response.currentness.status !== 'CURRENT' ||
    response.evidence.effectiveAt !== request.effectiveAt ||
    response.currentness.observedAt !== response.evidence.observedAt ||
    response.currentness.validThrough !== response.evidence.validThrough ||
    !sameSelection(response.evidence.anchorSelection, request.anchorSelection) ||
    response.evidence.members.length !== request.members.length
  ) {
    return false;
  }
  const assessments = response.assessments.filter(
    (assessment): assessment is Extract<(typeof response.assessments)[number], { readonly role: 'MEMBER' }> =>
      assessment.role === 'MEMBER',
  );
  const observedAt = response.assessments
    .map(({ handoff }) => handoff.evidence.assessedAt)
    .toSorted()
    .at(-1);
  const boundaries = response.assessments.map(
    ({ handoff }) => handoff.evidence.validUntil ?? handoff.completeness.nextApplicabilityBoundary,
  );
  const validThrough = boundaries.every((boundary): boundary is string => boundary !== undefined)
    ? boundaries.toSorted().at(0)
    : undefined;
  if (observedAt !== response.currentness.observedAt || validThrough !== response.currentness.validThrough) {
    return false;
  }
  return response.evidence.members.every((member, index) => {
    const requested = request.members[index];
    const assessment = assessments[index];
    return (
      requested !== undefined &&
      assessment !== undefined &&
      member.occurrenceId === requested.occurrenceId &&
      sameSelection(member.selection, requested.handoff.selection) &&
      semanticHandoffMatches(requested.handoff, assessment.handoff)
    );
  });
};

const projectResolution = (response: PricingPurposeEquivalenceResponse) => {
  if (response.outcome === 'CATALOG_EQUIVALENCE_CONFIRMED') {
    return { evidence: response.evidence, outcome: 'CATALOG_EQUIVALENCE_CONFIRMED' };
  }
  if (response.outcome === 'CATALOG_EQUIVALENCE_UNAVAILABLE') {
    return { outcome: 'CATALOG_EQUIVALENCE_UNAVAILABLE' };
  }
  return response.evidenceRef === undefined
    ? { outcome: 'CATALOG_EQUIVALENCE_UNVERIFIABLE' as const }
    : { evidenceRef: response.evidenceRef, outcome: 'CATALOG_EQUIVALENCE_UNVERIFIABLE' as const };
};

const makePort = (dependencies: {
  readonly context: {
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
    readonly tenantId: string;
  };
  readonly execute: Executor;
  readonly issuer: CatalogSelectionGatewayCredentialIssuer;
}): CatalogPricingPurposeEquivalencePort =>
  CatalogPricingPurposeEquivalenceService.of({
    resolve: Effect.fn('CatalogPricingPurposeEquivalencePort.resolve')(function* resolve(attempt) {
      const rawRequest = requestFor(attempt);
      const request = yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceRequestSchema)(rawRequest).pipe(
        Effect.mapError((cause) => unavailable('Catalog Pricing-purpose equivalence request is invalid', cause)),
      );
      if (
        attempt.candidate.tenantId !== dependencies.context.tenantId ||
        request.anchorSelection.productRef.tenantId !== dependencies.context.tenantId
      ) {
        return yield* unavailable('Catalog Pricing-purpose equivalence request is outside the trusted Tenant');
      }
      if (attempt.candidate.commercialScope.sellingLegalEntityId !== dependencies.context.legalEntityId) {
        return yield* unavailable('Catalog Pricing-purpose equivalence request is outside the trusted Legal Entity');
      }
      if (
        attempt.participants.some(
          ({ exactPrice }) =>
            exactPrice.price.definition.priceRef.tenantId !== dependencies.context.tenantId ||
            !sameCommercialScope(
              exactPrice.price.definition.identityKey.commercialScope,
              attempt.candidate.commercialScope,
            ),
        )
      ) {
        return yield* unavailable(
          'Catalog Pricing-purpose equivalence Price scope differs from the trusted candidate Market',
        );
      }
      const { baseUrl, credential } = yield* dependencies.issuer
        .issue({
          audience: 'catalog',
          legalEntityId: dependencies.context.legalEntityId,
          requestCorrelation: dependencies.context.requestCorrelation,
        })
        .pipe(Effect.mapError((cause) => unavailable('Catalog Pricing-purpose equivalence is unavailable', cause)));
      const rawResponse = yield* dependencies
        .execute(request, credential, dependencies.context.requestCorrelation, { baseUrl })
        .pipe(Effect.mapError((cause) => unavailable('Catalog Pricing-purpose equivalence is unavailable', cause)));
      const response = yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceResponseSchema)(rawResponse).pipe(
        Effect.mapError((cause) =>
          unavailable('Catalog returned malformed Pricing-purpose equivalence evidence', cause),
        ),
      );
      if (
        response.currentness.effectiveAt !== request.effectiveAt ||
        (response.outcome !== 'CATALOG_EQUIVALENCE_UNAVAILABLE' && !observedResponseBinds(response, request)) ||
        (response.outcome === 'CATALOG_EQUIVALENCE_CONFIRMED' && !confirmedResponseBinds(response, request))
      ) {
        return yield* unavailable('Catalog Pricing-purpose equivalence evidence does not bind the exact request');
      }
      return yield* Schema.decodeUnknownEffect(CatalogPricingPurposeEquivalenceResolutionSchema)(
        projectResolution(response),
      ).pipe(Effect.mapError((cause) => unavailable('Catalog returned unverifiable Pricing-purpose evidence', cause)));
    }),
  });

export const catalogPricingPurposeEquivalencePortFromEnvironment = (
  context: { readonly legalEntityId: string; readonly requestCorrelation: string; readonly tenantId: string },
  execute: Executor = executeAuthorized,
): Effect.Effect<CatalogPricingPurposeEquivalencePort> =>
  Effect.serviceOption(CatalogSelectionGatewayCredentialService).pipe(
    Effect.map((issuerOption) =>
      makePort({
        context,
        execute,
        issuer: Option.isSome(issuerOption) ? issuerOption.value : unavailableCatalogSelectionGatewayCredentialIssuer,
      }),
    ),
  );
