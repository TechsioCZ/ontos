import type { QuantityBasisCompatibilityRequest } from '@app/catalog/api/quantity-basis-compatibility';
import {
  QuantityBasisCompatibilityRequestSchema,
  QuantityBasisCompatibilityResponseSchema,
} from '@app/catalog/api/quantity-basis-compatibility';
import { executeQuantityBasisCompatibilityWithAuthorization } from '@app/catalog/api/quantity-basis-compatibility-client';
import { CatalogQuantityBasisSchema } from '@app/catalog/domain/catalog-quantity-handoff';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { priceDecimalValuesEqual } from '@app/pricing-contracts/domain/price-definition';
import { PricingCatalogQuantityBasisDecisionSchema } from '@app/pricing-contracts/domain/quantity-unit-package-basis';
import type { PricingCatalogQuantityBasisDecision } from '@app/pricing-contracts/domain/quantity-unit-package-basis';
import { Context, DateTime, Effect, Option, Redacted, Schema } from 'effect';

import {
  CatalogSelectionGatewayCredentialService,
  PricingCatalogSelectionUnavailable,
  unavailableCatalogSelectionGatewayCredentialIssuer,
} from '../../shared/domain/catalog-selection-gateway-credential.ts';
import type { CatalogSelectionGatewayCredentialIssuer } from '../../shared/domain/catalog-selection-gateway-credential.ts';

type QuantityBasisCompatibilityClientEffect = ReturnType<typeof executeQuantityBasisCompatibilityWithAuthorization>;
type QuantityBasisCompatibilityClientFailure =
  QuantityBasisCompatibilityClientEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type QuantityBasisCompatibilityExecutor = (
  payload: QuantityBasisCompatibilityRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL; readonly compositionRevision: string },
) => Effect.Effect<unknown, QuantityBasisCompatibilityClientFailure>;

export interface CatalogQuantityBasisCompatibilityPort {
  readonly assess: (
    request: QuantityBasisCompatibilityRequest,
  ) => Effect.Effect<PricingCatalogQuantityBasisDecision, PricingCatalogSelectionUnavailable>;
}

class CatalogQuantityBasisCompatibilityService extends Context.Service<
  CatalogQuantityBasisCompatibilityService,
  CatalogQuantityBasisCompatibilityPort
>()('@app/pricing/integrations/catalog-quantity-basis-compatibility/CatalogQuantityBasisCompatibilityService') {}

const executeAuthorizedCompatibility: QuantityBasisCompatibilityExecutor = (
  payload,
  credential,
  requestCorrelation,
  options,
) =>
  executeQuantityBasisCompatibilityWithAuthorization(payload, Redacted.value(credential), requestCorrelation, options);

const unavailable = (reason: string, cause?: unknown): PricingCatalogSelectionUnavailable => {
  const failure = new PricingCatalogSelectionUnavailable({
    code: 'pricing_catalog_selection_unavailable',
    reason,
    retryable: true,
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const sameSelection = Schema.toEquivalence(CatalogSelectionSchema);
const sameBasis = Schema.toEquivalence(CatalogQuantityBasisSchema);
const instantAtOrAfter = (later: string, earlier: string): boolean =>
  DateTime.Order(DateTime.makeUnsafe(later), DateTime.makeUnsafe(earlier)) >= 0;
const instantBefore = (earlier: string, later: string): boolean =>
  DateTime.Order(DateTime.makeUnsafe(earlier), DateTime.makeUnsafe(later)) < 0;

const sameEndpoint = (
  left: { readonly quantity: string; readonly quantityBasis: typeof CatalogQuantityBasisSchema.Type },
  right: { readonly quantity: string; readonly quantityBasis: typeof CatalogQuantityBasisSchema.Type },
): boolean =>
  priceDecimalValuesEqual(left.quantity, right.quantity) && sameBasis(left.quantityBasis, right.quantityBasis);

const ownerEvidenceBindsRequest = (
  decision: Exclude<PricingCatalogQuantityBasisDecision, { readonly outcome: 'UNAVAILABLE' }>,
  request: QuantityBasisCompatibilityRequest,
): boolean => {
  if (!('selection' in decision)) {
    return decision.effectiveAt === request.effectiveAt;
  }
  return (
    sameSelection(decision.selection, request.handoff.selection) &&
    decision.effectiveAt === request.effectiveAt &&
    decision.requestedOwnerRevision === request.handoff.ownerRevision &&
    instantAtOrAfter(decision.observedAt, decision.effectiveAt) &&
    decision.completeness.observedAt === decision.observedAt &&
    decision.completeness.ownerRevision === decision.ownerRevision
  );
};

const successBindsRequest = (
  decision: Extract<
    PricingCatalogQuantityBasisDecision,
    { readonly outcome: 'COMPATIBLE_CONVERSION' | 'NO_CONVERSION_REQUIRED' }
  >,
  request: QuantityBasisCompatibilityRequest,
): boolean => {
  const expectedTier = request.tier;
  const decidedTier = decision.endpoints.tier;
  return (
    ownerEvidenceBindsRequest(decision, request) &&
    decision.hierarchyRevision === request.handoff.hierarchyRevision &&
    decision.equivalentSelectionKey === request.handoff.equivalentSelectionKey &&
    sameEndpoint(decision.endpoints.requested, {
      quantity: request.handoff.quantity.requested,
      quantityBasis: request.handoff.quantityBasis,
    }) &&
    sameEndpoint(decision.endpoints.purchase, {
      quantity: request.handoff.quantity.resulting,
      quantityBasis: request.handoff.quantityBasis,
    }) &&
    sameEndpoint(decision.endpoints.price, request.price) &&
    (expectedTier === undefined
      ? decidedTier === undefined
      : decidedTier !== undefined && sameEndpoint(decidedTier, expectedTier))
  );
};

const makeCatalogQuantityBasisCompatibilityPort = (dependencies: {
  readonly context: {
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
    readonly tenantId: string;
  };
  readonly execute: QuantityBasisCompatibilityExecutor;
  readonly issuer: CatalogSelectionGatewayCredentialIssuer;
}): CatalogQuantityBasisCompatibilityPort =>
  CatalogQuantityBasisCompatibilityService.of({
    assess: Effect.fn('CatalogQuantityBasisCompatibilityPort.assess')(function* assess(request) {
      const payload = yield* Schema.decodeEffect(QuantityBasisCompatibilityRequestSchema)(request).pipe(
        Effect.mapError((cause) => unavailable('Catalog Quantity-basis request is invalid', cause)),
      );
      if (payload.handoff.selection.productRef.tenantId !== dependencies.context.tenantId) {
        return yield* unavailable('Catalog Quantity-basis request is outside the trusted Tenant');
      }
      const { baseUrl, credential } = yield* dependencies.issuer
        .issue({
          audience: 'catalog',
          compositionRevision: dependencies.context.compositionRevision,
          legalEntityId: dependencies.context.legalEntityId,
          requestCorrelation: dependencies.context.requestCorrelation,
        })
        .pipe(Effect.mapError((cause) => unavailable('Catalog Quantity-basis compatibility is unavailable', cause)));
      const ownerResponse = yield* dependencies
        .execute(payload, credential, dependencies.context.requestCorrelation, {
          baseUrl,
          compositionRevision: dependencies.context.compositionRevision,
        })
        .pipe(Effect.mapError((cause) => unavailable('Catalog Quantity-basis compatibility is unavailable', cause)));
      const decodedOwner = yield* Schema.decodeUnknownEffect(QuantityBasisCompatibilityResponseSchema, {
        onExcessProperty: 'error',
      })(ownerResponse).pipe(
        Effect.mapError((cause) => unavailable('Catalog returned malformed Quantity-basis evidence', cause)),
      );
      if (decodedOwner.outcome === 'UNAVAILABLE') {
        if (decodedOwner.effectiveAt !== payload.effectiveAt) {
          return yield* unavailable('Catalog Quantity-basis unavailability does not bind the exact request');
        }
        return decodedOwner;
      }
      const decision = yield* Schema.decodeEffect(PricingCatalogQuantityBasisDecisionSchema)(decodedOwner).pipe(
        Effect.mapError((cause) => unavailable('Catalog returned unverifiable Quantity-basis evidence', cause)),
      );
      if (decision.outcome === 'UNAVAILABLE') {
        return yield* unavailable('Catalog returned an incoherent Quantity-basis unavailability');
      }
      if (!('selection' in decision)) {
        return decision.effectiveAt === payload.effectiveAt
          ? decision
          : yield* unavailable('Catalog Quantity-basis failure does not bind the exact request');
      }
      if (
        !ownerEvidenceBindsRequest(decision, payload) ||
        decision.currentness.status !== 'CURRENT' ||
        decision.currentness.observedAt !== decision.observedAt ||
        decision.currentness.ownerRevision !== decision.ownerRevision ||
        decision.currentness.validUntil !== decision.completeness.nextApplicabilityBoundary ||
        (decision.currentness.validUntil !== undefined &&
          !instantBefore(decision.observedAt, decision.currentness.validUntil))
      ) {
        return yield* unavailable('Catalog Quantity-basis evidence does not bind the trusted Current handoff');
      }
      if (
        (decision.outcome === 'NO_CONVERSION_REQUIRED' || decision.outcome === 'COMPATIBLE_CONVERSION') &&
        !successBindsRequest(decision, payload)
      ) {
        return yield* unavailable('Catalog Quantity-basis success does not bind the exact request');
      }
      return decision;
    }),
  });

export const catalogQuantityBasisCompatibilityPortFromEnvironment = (
  context: {
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
    readonly tenantId: string;
  },
  execute: QuantityBasisCompatibilityExecutor = executeAuthorizedCompatibility,
): Effect.Effect<CatalogQuantityBasisCompatibilityPort> =>
  Effect.serviceOption(CatalogSelectionGatewayCredentialService).pipe(
    Effect.map((issuerOption) =>
      makeCatalogQuantityBasisCompatibilityPort({
        context,
        execute,
        issuer: Option.isSome(issuerOption) ? issuerOption.value : unavailableCatalogSelectionGatewayCredentialIssuer,
      }),
    ),
  );
