import { Schema } from 'effect';

import type {
  CatalogQuantityBasis,
  CatalogQuantityHandoff,
  CatalogQuantityHandoffReady,
} from '../../shared/domain/catalog-quantity-handoff.ts';
import { CatalogQuantityBasisSchema } from '../../shared/domain/catalog-quantity-handoff.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type {
  QuantityBasisCompatibilityRequest,
  QuantityBasisCompatibilityResponse,
} from '../../shared/apis/quantity-basis-compatibility.ts';

type NoConversionDecision = Extract<QuantityBasisCompatibilityResponse, { readonly outcome: 'NO_CONVERSION_REQUIRED' }>;

const sameBasis = Schema.toEquivalence(CatalogQuantityBasisSchema);
const sameSelection = Schema.toEquivalence(CatalogSelectionSchema);

const evidence = (request: QuantityBasisCompatibilityRequest, observed: CatalogQuantityHandoffReady) => {
  const { completeness, evidence: observedEvidence, ownerRevision } = observed;
  const currentness: NoConversionDecision['currentness'] = {
    observedAt: observedEvidence.assessedAt,
    ownerRevision,
    status: 'CURRENT',
  };
  if (observedEvidence.validUntil !== undefined) {
    Object.assign(currentness, { validUntil: observedEvidence.validUntil });
  }
  const generation = ownerRevision;
  const {
    scope: { predicateRef },
  } = completeness;
  const predicate = {
    effectiveAt: request.effectiveAt,
    price: request.price,
    requestedQuantity: observed.quantity.requested,
    requestedQuantityBasis: observed.quantityBasis,
    requestedUnitRef: observed.unitRef,
    selection: observed.selection,
  };
  if (request.tier !== undefined) {
    Object.assign(predicate, { tier: request.tier });
  }
  const currentnessEvidence = {
    effectiveAt: request.effectiveAt,
    generation,
    observedAt: observedEvidence.assessedAt,
    predicateRef,
    revalidatedAt: observedEvidence.assessedAt,
    verificationMode: 'OWNER_CURRENT_QUANTITY_REVALIDATED' as const,
  };
  if (observedEvidence.validUntil !== undefined) {
    Object.assign(currentnessEvidence, { validUntil: observedEvidence.validUntil });
  }
  return {
    completeness,
    currentness,
    currentnessEvidence,
    effectiveAt: request.effectiveAt,
    equivalentSelectionKey: observed.equivalentSelectionKey,
    generation,
    hierarchyRevision: observed.hierarchyRevision,
    observedAt: observedEvidence.assessedAt,
    ownerModuleId: 'commerce.catalog' as const,
    ownerRevision,
    requestedOwnerRevision: request.handoff.ownerRevision,
    requestedQuantity: observed.quantity.requested,
    requestedQuantityBasis: observed.quantityBasis,
    requestedUnitRef: observed.unitRef,
    selection: observed.selection,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    verificationReceipt: {
      generation,
      issuedAt: observedEvidence.assessedAt,
      ownerModuleId: 'commerce.catalog' as const,
      ownerRevision,
      predicate,
      predicateRef,
      verificationRef: `commerce.catalog.quantity-basis-verification:${generation}:${predicateRef}`,
    },
  };
};

const currentMeaningMatches = (requested: CatalogQuantityHandoffReady, current: CatalogQuantityHandoffReady): boolean =>
  sameSelection(requested.selection, current.selection) &&
  requested.equivalentSelectionKey === current.equivalentSelectionKey &&
  requested.hierarchyRevision === current.hierarchyRevision &&
  requested.quantity.requested === current.quantity.requested &&
  requested.quantity.resulting === current.quantity.resulting &&
  sameBasis(requested.quantityBasis, current.quantityBasis);

const endpoint = (quantity: string, quantityBasis: CatalogQuantityBasis) => ({ quantity, quantityBasis });

/**
 * Catalog can currently prove only the identity conversion for one exact Product Unit rule.
 * A different Product Unit requires durable owner conversion evidence, which Catalog does not
 * currently persist; it therefore fails closed instead of inferring from a code, label, or SKU.
 */
export const assessQuantityBasisCompatibility = (
  request: QuantityBasisCompatibilityRequest,
  current: CatalogQuantityHandoff,
): QuantityBasisCompatibilityResponse => {
  if (current.status !== 'READY') {
    if (current.status === 'INVALID') {
      return { effectiveAt: request.effectiveAt, outcome: 'INVALID', reason: current.reason };
    }
    return {
      effectiveAt: request.effectiveAt,
      outcome: 'UNVERIFIABLE',
      reason: current.reason,
    };
  }
  if (!currentMeaningMatches(request.handoff, current)) {
    return {
      ...evidence(request, current),
      outcome: 'UNVERIFIABLE',
      reason: 'The supplied Quantity handoff is not the exact Current Catalog meaning',
    };
  }
  const candidateBases = [request.price.quantityBasis, request.tier?.quantityBasis].filter(
    (basis): basis is CatalogQuantityBasis => basis !== undefined,
  );
  if (!candidateBases.every((basis) => sameBasis(current.quantityBasis, basis))) {
    return {
      ...evidence(request, current),
      outcome: 'UNVERIFIABLE',
      reason: 'Catalog has no authoritative stored conversion for the requested Product Unit bases',
    };
  }
  const endpoints: NoConversionDecision['endpoints'] = {
    price: request.price,
    purchase: endpoint(current.quantity.resulting, current.quantityBasis),
    requested: endpoint(current.quantity.requested, current.quantityBasis),
  };
  if (request.tier !== undefined) {
    Object.assign(endpoints, { tier: request.tier });
  }
  return { ...evidence(request, current), endpoints, outcome: 'NO_CONVERSION_REQUIRED' };
};

export const quantityBasisUnavailable = (
  request: QuantityBasisCompatibilityRequest,
  cause?: unknown,
): QuantityBasisCompatibilityResponse => {
  const result: QuantityBasisCompatibilityResponse = {
    effectiveAt: request.effectiveAt,
    outcome: 'UNAVAILABLE',
    reason: 'Catalog Quantity basis currentness is temporarily unavailable',
    retryable: true,
  };
  if (cause !== undefined) {
    Object.defineProperty(result, 'cause', { configurable: true, value: cause });
  }
  return result;
};
