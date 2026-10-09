import { executeQuantityPreparationWithAuthorization } from '@app/catalog/api/quantity-preparation-client';
import { CatalogQuantityHandoffSchema } from '@app/catalog/domain/catalog-quantity-handoff';
import type { CatalogQuantityHandoff, CatalogQuantityHandoffReady } from '@app/catalog/domain/catalog-quantity-handoff';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import type { CatalogSelection } from '@app/catalog/domain/catalog-selection-evidence';
import { selectSmallestCompleteCatalogSelectionBasis } from '@app/catalog/domain/catalog-selection-purpose';
import { Context, Effect, Option, Redacted, Schema } from 'effect';

import {
  CatalogSelectionGatewayCredentialService,
  PricingCatalogSelectionUnavailable,
  unavailableCatalogSelectionGatewayCredentialIssuer,
} from '../../shared/domain/catalog-selection-gateway-credential.ts';
import type { CatalogSelectionGatewayCredentialIssuer } from '../../shared/domain/catalog-selection-gateway-credential.ts';

type QuantityPreparationClientEffect = ReturnType<typeof executeQuantityPreparationWithAuthorization>;
type QuantityPreparationClientFailure =
  QuantityPreparationClientEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type QuantityPreparationExecutor = (
  payload: { readonly amount: string; readonly purpose: 'PRICING'; readonly selection: CatalogSelection },
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL; readonly compositionRevision: string },
) => Effect.Effect<unknown, QuantityPreparationClientFailure>;

export interface CatalogQuantityEvidenceRequest {
  readonly amount: string;
  readonly selection: CatalogSelection;
}

export interface CatalogQuantityEvidencePort {
  /** Preserves Catalog's READY/INVALID/UNVERIFIABLE/STALE decision without inventing a conversion. */
  readonly assess: (
    request: CatalogQuantityEvidenceRequest,
  ) => Effect.Effect<CatalogQuantityHandoff, PricingCatalogSelectionUnavailable>;
}

class CatalogQuantityEvidenceService extends Context.Service<
  CatalogQuantityEvidenceService,
  CatalogQuantityEvidencePort
>()('@app/pricing/integrations/catalog-quantity-evidence/CatalogQuantityEvidenceService') {}

const executeAuthorizedQuantityPreparation: QuantityPreparationExecutor = (
  payload,
  credential,
  requestCorrelation,
  options,
) => executeQuantityPreparationWithAuthorization(payload, Redacted.value(credential), requestCorrelation, options);

const unavailable = (reason: string, cause?: unknown): PricingCatalogSelectionUnavailable => {
  const failure = new PricingCatalogSelectionUnavailable({
    code: 'pricing_catalog_selection_unavailable',
    reason,
    retryable: true,
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const sameReference = (
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

const sameSelection = Schema.toEquivalence(CatalogSelectionSchema);

const exactTarget = (selection: CatalogSelection) => selection.packageOption?.optionRef ?? selection.variantRef;

const hasOwnerBasis = (
  handoff: CatalogQuantityHandoffReady,
  role: 'PACKAGE_CONTENT' | 'UNIT_RULE' | 'UNIT_TARGET_DIVISIBILITY',
  reference: { readonly resourceRef: CatalogQuantityHandoffReady['unitRef']; readonly revision: number },
): boolean =>
  handoff.evidence.basis.some(
    (candidate) =>
      candidate.subject === undefined &&
      candidate.role === role &&
      sameReference(candidate.source.resourceRef, reference.resourceRef) &&
      candidate.source.revision === reference.revision,
  );

const packageEvidenceMatches = (handoff: CatalogQuantityHandoffReady): boolean => {
  const selectedPackage = handoff.selection.packageOption;
  if (selectedPackage === undefined) {
    return handoff.packageContent === undefined && handoff.packageRevision === undefined;
  }
  const { packageContent, packageRevision } = handoff;
  if (packageContent === undefined || packageRevision === undefined) {
    return false;
  }
  const pinned = selectedPackage.contentRevision;
  const [firstPathRevision] = packageContent.path;
  return (
    firstPathRevision !== undefined &&
    sameReference(firstPathRevision.resourceRef, pinned.resourceRef) &&
    firstPathRevision.revision === pinned.revision &&
    sameReference(packageRevision.reference.resourceRef, pinned.resourceRef) &&
    packageRevision.reference.revision === pinned.revision &&
    sameReference(packageRevision.form.productRef, handoff.selection.productRef) &&
    sameReference(packageRevision.form.variantRef, handoff.selection.variantRef) &&
    sameReference(packageContent.unitRef, packageRevision.unitRef) &&
    packageContent.path.every((reference) => hasOwnerBasis(handoff, 'PACKAGE_CONTENT', reference)) &&
    (handoff.selection.configuration === undefined || packageRevision.configurationKey !== undefined) &&
    (handoff.selection.setComposition === undefined
      ? packageRevision.setComposition === undefined
      : packageRevision.setComposition !== undefined &&
        sameReference(packageRevision.setComposition.resourceRef, handoff.selection.setComposition.resourceRef) &&
        packageRevision.setComposition.revision === handoff.selection.setComposition.revision)
  );
};

const ownerCurrentnessMatches = (handoff: CatalogQuantityHandoffReady): boolean =>
  handoff.evidence.assessedAt === handoff.completeness.observedAt &&
  handoff.ownerRevision === handoff.completeness.ownerRevision &&
  handoff.evidence.validUntil === handoff.completeness.nextApplicabilityBoundary;

const readyResponseBindsRequest = (
  handoff: CatalogQuantityHandoffReady,
  request: CatalogQuantityEvidenceRequest,
  tenantId: string,
): boolean => {
  const completeBasis = selectSmallestCompleteCatalogSelectionBasis({
    basis: handoff.evidence.basis,
    purpose: 'PRICING',
    selection: handoff.selection,
  });
  const target = exactTarget(request.selection);
  return (
    request.selection.productRef.tenantId === tenantId &&
    sameSelection(handoff.selection, request.selection) &&
    sameSelection(handoff.evidence.selection, request.selection) &&
    handoff.evidence.purpose === 'PRICING' &&
    completeBasis.status === 'COMPLETE' &&
    handoff.quantity.requested === request.amount &&
    handoff.quantity.tenantId === tenantId &&
    handoff.quantity.targetId === target.resourceId &&
    handoff.quantity.unitId === handoff.unitRef.resourceId &&
    handoff.quantity.unitRuleRevision === handoff.quantityBasis.unitRuleRevision &&
    sameReference(handoff.quantityBasis.targetRef, target) &&
    sameReference(handoff.quantityBasis.unitRef, handoff.unitRef) &&
    hasOwnerBasis(handoff, 'UNIT_RULE', {
      resourceRef: handoff.quantityBasis.unitRef,
      revision: handoff.quantityBasis.unitRuleRevision,
    }) &&
    hasOwnerBasis(handoff, 'UNIT_TARGET_DIVISIBILITY', {
      resourceRef: handoff.quantityBasis.targetRef,
      revision: handoff.quantityBasis.targetDivisibilityRevision,
    }) &&
    packageEvidenceMatches(handoff) &&
    ownerCurrentnessMatches(handoff)
  );
};

const unverifiable = (reason: string): CatalogQuantityHandoff => ({ reason, status: 'UNVERIFIABLE' });
const invalid = (reason: string): CatalogQuantityHandoff => ({ reason, status: 'INVALID' });

const makeCatalogQuantityEvidencePort = (dependencies: {
  readonly context: {
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
    readonly tenantId: string;
  };
  readonly execute: QuantityPreparationExecutor;
  readonly issuer: CatalogSelectionGatewayCredentialIssuer;
}): CatalogQuantityEvidencePort =>
  CatalogQuantityEvidenceService.of({
    assess: Effect.fn('CatalogQuantityEvidencePort.assess')(function* assess(request) {
      if (request.selection.productRef.tenantId !== dependencies.context.tenantId) {
        return invalid('Catalog Quantity selection is outside the trusted Tenant');
      }
      const selection = yield* Schema.decodeEffect(CatalogSelectionSchema)(request.selection).pipe(Effect.option);
      if (Option.isNone(selection)) {
        return invalid('Catalog Quantity selection is structurally invalid');
      }
      const { baseUrl, credential } = yield* dependencies.issuer
        .issue({
          audience: 'catalog',
          compositionRevision: dependencies.context.compositionRevision,
          legalEntityId: dependencies.context.legalEntityId,
          requestCorrelation: dependencies.context.requestCorrelation,
        })
        .pipe(Effect.mapError((cause) => unavailable('Catalog Quantity evidence is unavailable', cause)));
      const ownerResponse = yield* dependencies
        .execute(
          { amount: request.amount, purpose: 'PRICING', selection: selection.value },
          credential,
          dependencies.context.requestCorrelation,
          { baseUrl, compositionRevision: dependencies.context.compositionRevision },
        )
        .pipe(Effect.mapError((cause) => unavailable('Catalog Quantity evidence is unavailable', cause)));
      const response = yield* Schema.decodeUnknownEffect(CatalogQuantityHandoffSchema)(ownerResponse).pipe(
        Effect.option,
      );
      if (Option.isNone(response)) {
        return unverifiable('Catalog returned unverifiable Quantity evidence');
      }
      if (response.value.status !== 'READY') {
        return response.value;
      }
      return readyResponseBindsRequest(response.value, request, dependencies.context.tenantId)
        ? response.value
        : unverifiable('Catalog Quantity evidence does not bind the exact request and trusted Current facts');
    }),
  });

export const catalogQuantityEvidencePortFromEnvironment = (
  context: {
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
    readonly tenantId: string;
  },
  execute: QuantityPreparationExecutor = executeAuthorizedQuantityPreparation,
): Effect.Effect<CatalogQuantityEvidencePort> =>
  Effect.serviceOption(CatalogSelectionGatewayCredentialService).pipe(
    Effect.map((issuerOption) =>
      makeCatalogQuantityEvidencePort({
        context,
        execute,
        issuer: Option.isSome(issuerOption) ? issuerOption.value : unavailableCatalogSelectionGatewayCredentialIssuer,
      }),
    ),
  );
