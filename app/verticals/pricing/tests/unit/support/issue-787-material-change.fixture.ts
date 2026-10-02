import {
  PricingMaterialOwnerTransitionEvidenceSchema,
  PricingMaterialStateSnapshotSchema,
} from '@app/pricing-contracts/domain/material-change';
import type {
  PricingMaterialBindingKind,
  PricingMaterialOwnerTransitionEvidence,
  PricingMaterialStateSnapshot,
} from '@app/pricing-contracts/domain/material-change';
import type { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import {
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import type { PricingSourceEvidenceFamily } from '@app/pricing-contracts/domain/source-revision-evidence';
import { Schema } from 'effect';

type PricingInstant = typeof PricingInstantSchema.Type;

export const issue787TenantId = '20000000-0000-4000-8000-000000000001';
export const issue787OperationTime = '2026-09-28T10:00:00.000Z';
export const issue787RequestedAt = '2026-09-28T10:00:00.100Z';
export const issue787EvaluatedAt = '2026-09-28T10:00:00.200Z';
export const issue787ObservedAt = '2026-09-28T10:00:00.300Z';
export const issue787CapturedAt = '2026-09-28T10:00:00.400Z';
export const issue787NextBoundary = '2026-09-28T11:00:00.000Z';
const catalogModuleId = 'commerce.catalog' as const;
const catalogObservedAt = '2026-09-28T09:59:59.000Z';

export const issue787UnitRef = {
  moduleId: catalogModuleId,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit',
  tenantId: issue787TenantId,
} as const;
export const issue787ProductRef = {
  moduleId: catalogModuleId,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId: issue787TenantId,
} as const;
export const issue787VariantRef = {
  moduleId: catalogModuleId,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId: issue787TenantId,
} as const;

const selection = { productRef: issue787ProductRef, variantRef: issue787VariantRef };
const catalogEvidence = {
  assessedAt: catalogObservedAt,
  basis: [
    { role: 'PRODUCT' as const, source: { resourceRef: issue787ProductRef, revision: 1 } },
    { role: 'VARIANT' as const, source: { resourceRef: issue787VariantRef, revision: 2 } },
    {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
      role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
      source: { resourceRef: issue787ProductRef, revision: 1 },
    },
  ],
  membership: {
    attestationId: '12121212-1212-4212-8212-121212121212',
    observedAt: catalogObservedAt,
    productRef: issue787ProductRef,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    variant: { resourceRef: issue787VariantRef, revision: 2 },
  },
  purpose: 'PRICING' as const,
  selection,
  status: 'VALID' as const,
};
const catalog = {
  completeness: {
    observedAt: catalogObservedAt,
    ownerRevision: 'catalog-quantity:17',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-quantity:exact-selection' },
  },
  divisible: false,
  equivalentSelectionKey: 'catalog-selection:exact',
  evidence: catalogEvidence,
  hierarchyRevision: 'catalog-hierarchy:9',
  ownerRevision: 'catalog-quantity:17',
  quantity: {
    changed: false,
    notice: null,
    requested: '1',
    resulting: '1',
    rounding: 'HALF_UP' as const,
    status: 'VALID' as const,
    step: '1',
    targetId: issue787VariantRef.resourceId,
    tenantId: issue787TenantId,
    unitId: issue787UnitRef.resourceId,
    unitRuleRevision: 7,
  },
  quantityBasis: {
    targetDivisibilityRevision: 3,
    targetRef: issue787VariantRef,
    unitRef: issue787UnitRef,
    unitRuleRevision: 7,
  },
  selection,
  status: 'READY' as const,
  unitRef: issue787UnitRef,
};

export interface Issue787SourceEvidenceOptions {
  readonly currencyCode?: string;
  readonly evaluatedAt?: PricingInstant;
  readonly family?: PricingSourceEvidenceFamily;
  readonly nextMaterialBoundary?: PricingInstant;
  readonly observedAt?: PricingInstant;
  readonly operationTime?: PricingInstant;
  readonly ownerModuleId?: string;
  readonly ownerRootRef?: string;
  readonly predicateRef?: string;
  readonly requestedAt?: PricingInstant;
  readonly revision?: string;
  readonly state?: 'ABSENT' | 'CONFLICT' | 'PRESENT' | 'UNVERIFIABLE';
}

export const makeIssue787SourceEvidence = (options: Issue787SourceEvidenceOptions = {}) => {
  const currencyCode = options.currencyCode ?? 'CZK';
  const evaluatedAt = options.evaluatedAt ?? issue787EvaluatedAt;
  const family = options.family ?? 'PRICE';
  const nextMaterialBoundary = options.nextMaterialBoundary ?? issue787NextBoundary;
  const observedAt = options.observedAt ?? issue787ObservedAt;
  const operationTime = options.operationTime ?? issue787OperationTime;
  const ownerModuleId = options.ownerModuleId ?? 'commerce.pricing';
  const ownerRootRef = options.ownerRootRef ?? `${ownerModuleId}:root:tenant-1`;
  const predicateRef = options.predicateRef ?? `${family}:candidate-787:exact`;
  const requestedAt = options.requestedAt ?? issue787RequestedAt;
  const revision = options.revision ?? '1';
  const ownerScope = { ownerModuleId, ownerRootRef, predicateRef, tenantId: issue787TenantId };
  const temporal = {
    effectiveAt: operationTime,
    evaluatedAt,
    evaluationMode: 'CURRENT_AT_OWNER_EVALUATION' as const,
    nextMaterialBoundary,
    observedAt,
    requestedAt,
  };
  const request = { currencyCode, effectiveAt: operationTime, family, ownerScope, requestedAt };
  const completeness = {
    completenessEvidence: {
      nextApplicabilityBoundary: nextMaterialBoundary,
      observedAt,
      ownerRevision: `${family}:set:${revision}`,
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef },
    },
    currencyCode,
    family,
    ownerScope,
    ownerSetRevisionRef: `${family}:set:${revision}`,
    temporal,
    verification: {
      kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
      verificationRef: `${family}:set-proof:${revision}`,
    },
  };
  if (options.state === 'UNVERIFIABLE') {
    return {
      _tag: 'UNVERIFIABLE' as const,
      observedAt,
      reason: 'OWNER_UNAVAILABLE' as const,
      request,
      retryable: true,
    };
  }
  if (options.state === 'ABSENT') {
    return { _tag: 'VERIFIED_ABSENT' as const, completeness, request };
  }
  const fact = {
    currencyCode,
    effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: '2026-10-01T00:00:00.000Z' },
    factRef: `${family}:fact:787`,
    factRevisionRef: `${family}:revision:${revision}`,
    family,
    ownerScope,
    temporal,
    verification: {
      kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
      verificationRef: `${family}:fact-proof:${revision}`,
    },
  };
  return options.state === 'CONFLICT'
    ? {
        _tag: 'CONFLICT' as const,
        completeness,
        currentFacts: [fact, { ...fact, factRevisionRef: `${family}:revision:${revision}:collision` }],
        request,
      }
    : { _tag: 'VERIFIED_PRESENT' as const, completeness, currentFacts: [fact], request };
};

export interface Issue787SnapshotOptions {
  readonly attemptId?: string;
  readonly bindingKind?: PricingMaterialBindingKind;
  readonly capturedAt?: PricingInstant;
  readonly currencyCode?: string;
  readonly evaluatedAt?: PricingInstant;
  readonly meaningRef?: string;
  readonly nextMaterialBoundary?: PricingInstant;
  readonly nonMaterialObservations?: PricingMaterialStateSnapshot['nonMaterialObservations'];
  readonly observedAt?: PricingInstant;
  readonly operationTime?: PricingInstant;
  readonly requestedAt?: PricingInstant;
  readonly revision?: string;
  readonly snapshotId?: string;
  readonly sourceState?: Issue787SourceEvidenceOptions['state'];
}

type MutableIssue787SourceEvidenceOptions = {
  -readonly [Key in keyof Issue787SourceEvidenceOptions]: Issue787SourceEvidenceOptions[Key];
};

export const makeIssue787Snapshot = (options: Issue787SnapshotOptions = {}): PricingMaterialStateSnapshot => {
  const currencyCode = options.currencyCode ?? 'CZK';
  const operationTime = options.operationTime ?? issue787OperationTime;
  const requestedAt = options.requestedAt ?? issue787RequestedAt;
  const revision = options.revision ?? '1';
  const sourceOptions: MutableIssue787SourceEvidenceOptions = {
    currencyCode,
    operationTime,
    requestedAt,
    revision,
  };
  if (options.evaluatedAt !== undefined) {
    sourceOptions.evaluatedAt = options.evaluatedAt;
  }
  if (options.nextMaterialBoundary !== undefined) {
    sourceOptions.nextMaterialBoundary = options.nextMaterialBoundary;
  }
  if (options.observedAt !== undefined) {
    sourceOptions.observedAt = options.observedAt;
  }
  if (options.sourceState !== undefined) {
    sourceOptions.state = options.sourceState;
  }
  return Schema.decodeSync(PricingMaterialStateSnapshotSchema, { onExcessProperty: 'error' })({
    attemptId: options.attemptId ?? `attempt-${revision}`,
    calculationVersions: {
      allocationContractVersions: ['allocation-v1'],
      arithmeticProfileVersions: ['arithmetic-v1'],
      publicationProfileVersions: ['publication-v1'],
    },
    candidateRef: 'candidate-787',
    capturedAt: options.capturedAt ?? issue787CapturedAt,
    decision: {
      commercialScope: {
        channelId: 'B2C',
        marketId: 'market-cz',
        sellingLegalEntityId: '55555555-5555-4555-8555-555555555555',
      },
      currencyCode,
      lines: [{ catalog, occurrenceId: 'line-a', pricingBasis: { quantity: '1', unitRef: issue787UnitRef } }],
      monetaryBoundary: 'PRE_TAX',
      operationTime,
      purchasingContext: {
        accessDecision: { decisionRef: 'access-decision:787', decisionRevision: '1' },
        actor: { kind: 'PRINCIPAL', principalId: 'pricing-principal:787' },
        commercialSettingsDecision: {
          decisionRef: 'commercial-settings-decision:787',
          decisionRevision: '1',
        },
        contextRef: 'purchase-1',
        contextRevision: 'purchase-r1',
        currencyResolution: {
          currencyCode,
          resolutionRef: 'currency-resolution:787',
          resolutionRevision: '1',
        },
        subject: {
          authorizationSubject: { kind: 'RETAIL' },
          kind: 'PROFILE',
          profileRef: {
            moduleId: 'commerce.customer-context',
            resourceId: '78700000-0000-4000-8000-000000000001',
            resourceType: 'commerce.customer-context.retail-customer-profile',
            tenantId: issue787TenantId,
          },
        },
      },
      tenantId: issue787TenantId,
    },
    materialBindings: [
      {
        bindingRef: 'binding:price:line-a',
        kind: options.bindingKind ?? 'EXACT_PRICE_SET',
        meaningRef: options.meaningRef ?? `meaning:price:${revision}`,
        sourceEvidence: makeIssue787SourceEvidence(sourceOptions),
      },
    ],
    nonMaterialObservations: options.nonMaterialObservations ?? [
      { kind: 'STOREFRONT_ORIGIN', observationRef: 'storefront:brand-a' },
      { kind: 'TAX_ONLY', observationRef: 'tax:revision-9' },
    ],
    requestedAt,
    snapshotId: options.snapshotId ?? `snapshot-${revision}`,
  });
};

export const makeIssue787OwnerTransition = (
  previous: PricingMaterialStateSnapshot,
  current: PricingMaterialStateSnapshot,
): PricingMaterialOwnerTransitionEvidence => {
  const [previousBinding] = previous.materialBindings;
  const [currentBinding] = current.materialBindings;
  if (previousBinding === undefined || currentBinding === undefined) {
    throw new Error('Issue #787 fixture requires one exact material binding');
  }
  const currentSource = currentBinding.sourceEvidence;
  if (
    (!Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(previousBinding.sourceEvidence) &&
      !Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(previousBinding.sourceEvidence)) ||
    (!Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(currentSource) &&
      !Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(currentSource))
  ) {
    throw new Error('Issue #787 owner transition requires verified before and after evidence');
  }
  return Schema.decodeSync(PricingMaterialOwnerTransitionEvidenceSchema, { onExcessProperty: 'error' })({
    bindingRef: currentBinding.bindingRef,
    confirmedAt: current.capturedAt,
    currentEvidence: currentSource,
    currentSnapshotId: current.snapshotId,
    family: currentSource.request.family,
    ownerScope: currentSource.request.ownerScope,
    previousEvidence: previousBinding.sourceEvidence,
    previousSnapshotId: previous.snapshotId,
    transitionRef: `transition:${previous.snapshotId}:${current.snapshotId}`,
    verification: {
      kind: 'OWNER_CONFIRMED_NON_MATERIAL_TRANSITION',
      verificationRef: `transition-proof:${previous.snapshotId}:${current.snapshotId}`,
    },
  });
};
