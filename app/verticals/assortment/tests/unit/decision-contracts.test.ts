import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import {
  AssortmentCatalogSelectorSchema,
  AssortmentCatalogSelectionSchema,
  AssortmentConfigurationConflictError,
  AssortmentDecisionFailureSchema,
  AssortmentDecisionEvidenceSchema,
  AssortmentDependencyFailureError,
  AssortmentMissingConfigurationError,
  AssortmentOwnerResourceRefSchema,
  AssortmentPurchaseConstituentSchema,
  AssortmentPurchaseRequestSchema,
  AssortmentPublicDecisionResponseSchema,
  AssortmentRetryExhaustedError,
  AssortmentRuleRevisionSchema,
  AssortmentSetPurchaseCompositionSchema,
  AssortmentVisibilityRequestSchema,
  composeAssortmentPurchaseOutcome,
} from '../../shared/domain/decision-contracts.ts';

const tenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a11';
const otherTenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a22';
const ref = (moduleId: string, resourceType: string, resourceId: string) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId,
});
const catalogRef = (resourceType: string, resourceId: string) => ref('catalog.owner', resourceType, resourceId);
const ownerRevision = (sourceRef: ReturnType<typeof ref>, revision = 'r1') => ({
  ownerModuleId: sourceRef.moduleId,
  revision,
  sourceRef,
});
const evidence = (resourceId: string) => ({
  evidenceRef: ref('catalog.owner', 'catalog.selection-evidence', resourceId),
  ownerModuleId: 'catalog.owner',
  sourceRevision: ownerRevision(catalogRef('catalog.variant', 'variant-1')),
});
const context = {
  channelRef: ref('commerce.channel', 'commerce.channel.channel', 'web'),
  operationTime: '2026-09-22T10:00:00.000Z',
  sellingLegalEntityRef: ref('commerce.legal-entity', 'commerce.legal-entity.selling-legal-entity', 'sle-1'),
  tenantId,
};
const profileSubject = {
  kind: 'IDENTIFIED' as const,
  subject: {
    kind: 'RETAIL_CUSTOMER_PROFILE' as const,
    profileRef: ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', 'profile-1'),
  },
};
const atomicSelection = {
  configuration: { kind: 'NONE' as const },
  productRef: catalogRef('catalog.product', 'product-1'),
  variantKind: 'ATOMIC' as const,
  variantRef: catalogRef('catalog.variant', 'variant-1'),
};
const setSelection = {
  ...atomicSelection,
  setCompositionRevision: ownerRevision(catalogRef('catalog.set-composition-revision', 'set-composition-1')),
  variantKind: 'SET' as const,
};

const withTenant = <T extends { tenantId: string }>(value: T, nextTenantId = otherTenantId): T => ({
  ...value,
  tenantId: nextTenantId,
});

it('accepts exact visibility and purchase contracts with owner-qualified refs', () => {
  expect(
    Schema.decodeUnknownSync(AssortmentVisibilityRequestSchema)({
      decisionPurpose: 'VISIBILITY',
      productRef: atomicSelection.productRef,
      subject: profileSubject,
      trustedContext: context,
    }),
  ).toMatchObject({ decisionPurpose: 'VISIBILITY', productRef: atomicSelection.productRef });

  const purchase = Schema.decodeUnknownSync(AssortmentPurchaseRequestSchema)({
    constituent: { catalogSelection: atomicSelection, role: 'TOP_LEVEL' },
    decisionPurpose: 'PURCHASE',
    subject: profileSubject,
    trustedContext: context,
  });
  expect(purchase.constituent.catalogSelection).toEqual(atomicSelection);
  const componentPurchase = Schema.decodeUnknownSync(AssortmentPurchaseRequestSchema)({
    constituent: { catalogSelection: atomicSelection, role: 'REQUIRED_COMPONENT' },
    decisionPurpose: 'PURCHASE',
    subject: profileSubject,
    trustedContext: context,
  });
  expect(componentPurchase.constituent.role).toBe('REQUIRED_COMPONENT');
  expect(componentPurchase.constituent.catalogSelection).toEqual(atomicSelection);
});

it('rejects VISIBILITY variant/package-option selectors while allowing PURCHASE selectors', () => {
  expect(() =>
    Schema.decodeUnknownSync(AssortmentRuleRevisionSchema)({
      decisionPurpose: 'VISIBILITY',
      effect: 'ALLOW',
      revision: ownerRevision(ref('commerce.assortment', 'commerce.assortment.rule-revision', 'rule-revision-1')),
      selector: { kind: 'VARIANT', variantRef: atomicSelection.variantRef },
    }),
  ).toThrow();
  expect(
    Schema.decodeUnknownSync(AssortmentRuleRevisionSchema)({
      decisionPurpose: 'PURCHASE',
      effect: 'ALLOW',
      revision: ownerRevision(ref('commerce.assortment', 'commerce.assortment.rule-revision', 'rule-revision-1')),
      selector: { kind: 'PACKAGE_OPTION', packageOptionRef: catalogRef('catalog.package-option', 'option-1') },
    }).decisionPurpose,
  ).toBe('PURCHASE');
  expect(() =>
    Schema.decodeUnknownSync(AssortmentCatalogSelectorSchema)({
      kind: 'PRODUCT',
      productRef: { ...atomicSelection.productRef, resourceType: '' },
    }),
  ).toThrow();
});

it('keeps Guest, Purchasing Subject, and Principal identities separate', () => {
  const guest = Schema.decodeUnknownSync(AssortmentVisibilityRequestSchema)({
    decisionPurpose: 'VISIBILITY',
    productRef: atomicSelection.productRef,
    subject: {
      guestEvidence: evidence('guest-proof-1'),
      kind: 'GUEST_PURCHASE_CONTEXT',
    },
    trustedContext: context,
  });
  expect(guest.subject.kind).toBe('GUEST_PURCHASE_CONTEXT');
  expect(() =>
    Schema.decodeUnknownSync(AssortmentVisibilityRequestSchema)({
      decisionPurpose: 'VISIBILITY',
      productRef: atomicSelection.productRef,
      subject: { kind: 'PRINCIPAL', principalRef: { principalId: 'not-a-subject', tenantId } },
      trustedContext: context,
    }),
  ).toThrow();
});

it('rejects cross-tenant trusted context, actor, subject, Guest evidence, and Product input', () => {
  expect(() =>
    Schema.decodeUnknownSync(AssortmentVisibilityRequestSchema)({
      decisionPurpose: 'VISIBILITY',
      productRef: atomicSelection.productRef,
      subject: profileSubject,
      trustedContext: { ...context, channelRef: withTenant(context.channelRef) },
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentVisibilityRequestSchema)({
      decisionPurpose: 'VISIBILITY',
      principalRef: { principalId: '00000000-0000-0000-0000-000000000001', tenantId: otherTenantId },
      productRef: atomicSelection.productRef,
      subject: profileSubject,
      trustedContext: context,
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentVisibilityRequestSchema)({
      decisionPurpose: 'VISIBILITY',
      productRef: withTenant(atomicSelection.productRef),
      subject: profileSubject,
      trustedContext: context,
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentVisibilityRequestSchema)({
      decisionPurpose: 'VISIBILITY',
      productRef: atomicSelection.productRef,
      subject: {
        guestEvidence: {
          ...evidence('guest-cross-tenant'),
          evidenceRef: withTenant(evidence('guest-cross-tenant').evidenceRef),
        },
        kind: 'GUEST_PURCHASE_CONTEXT',
      },
      trustedContext: context,
    }),
  ).toThrow();
});

it('requires a pinned Set composition and independent non-Set components', () => {
  const component = {
    catalogSelection: atomicSelection,
    role: 'REQUIRED_COMPONENT' as const,
  };
  const composition = Schema.decodeUnknownSync(AssortmentSetPurchaseCompositionSchema)({
    requiredComponents: [component],
    setCompositionRevision: ownerRevision(catalogRef('catalog.set-composition-revision', 'set-composition-1')),
  });
  expect(composition.requiredComponents).toHaveLength(1);
  expect(() =>
    Schema.decodeUnknownSync(AssortmentPurchaseRequestSchema)({
      constituent: { catalogSelection: setSelection, role: 'TOP_LEVEL' },
      decisionPurpose: 'PURCHASE',
      subject: profileSubject,
      trustedContext: context,
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentPurchaseRequestSchema)({
      constituent: { catalogSelection: setSelection, role: 'TOP_LEVEL' },
      decisionPurpose: 'PURCHASE',
      setComposition: {
        requiredComponents: [
          {
            catalogSelection: {
              ...atomicSelection,
              productRef: withTenant(atomicSelection.productRef),
            },
            role: 'REQUIRED_COMPONENT',
          },
        ],
        setCompositionRevision: ownerRevision(catalogRef('catalog.set-composition-revision', 'set-composition-1')),
      },
      subject: profileSubject,
      trustedContext: context,
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentPurchaseRequestSchema)({
      constituent: { catalogSelection: setSelection, role: 'TOP_LEVEL' },
      decisionPurpose: 'PURCHASE',
      setComposition: {
        requiredComponents: [component],
        setCompositionRevision: ownerRevision(catalogRef('catalog.set-composition-revision', 'different-revision')),
      },
      subject: profileSubject,
      trustedContext: context,
    }),
  ).toThrow();
  expect(
    Schema.is(AssortmentDecisionFailureSchema)(
      new AssortmentRetryExhaustedError({
        attempts: 4,
        code: 'RETRY_EXHAUSTED',
        maxAttempts: 3,
        safeReasonCode: 'RETRY_EXHAUSTED',
      }),
    ),
  ).toBe(false);
  expect(
    Schema.is(AssortmentDecisionFailureSchema)(
      new AssortmentRetryExhaustedError({
        attempts: 2,
        code: 'RETRY_EXHAUSTED',
        maxAttempts: 3,
        safeReasonCode: 'RETRY_EXHAUSTED',
      }),
    ),
  ).toBe(false);
  expect(() =>
    Schema.decodeUnknownSync(AssortmentSetPurchaseCompositionSchema)({
      requiredComponents: [{ catalogSelection: setSelection, role: 'REQUIRED_COMPONENT' }],
      setCompositionRevision: composition.setCompositionRevision,
    }),
  ).toThrow();
});

it('composes only established constituent outcomes and never invents siblings', () => {
  const topLevel = Schema.decodeUnknownSync(AssortmentPurchaseConstituentSchema)({
    catalogSelection: setSelection,
    role: 'TOP_LEVEL',
  });
  const component = Schema.decodeUnknownSync(AssortmentPurchaseConstituentSchema)({
    catalogSelection: atomicSelection,
    role: 'REQUIRED_COMPONENT',
  });
  expect(composeAssortmentPurchaseOutcome([])).toBe('INDETERMINATE');
  expect(composeAssortmentPurchaseOutcome([{ constituent: topLevel, outcome: 'INELIGIBLE' }])).toBe('INELIGIBLE');
  expect(
    composeAssortmentPurchaseOutcome([
      { constituent: topLevel, outcome: 'ELIGIBLE' },
      { constituent: component, outcome: 'INDETERMINATE' },
    ]),
  ).toBe('INDETERMINATE');
  expect(
    composeAssortmentPurchaseOutcome([
      { constituent: topLevel, outcome: 'ELIGIBLE' },
      { constituent: component, outcome: 'ELIGIBLE' },
    ]),
  ).toBe('ELIGIBLE');
});

it('keeps public responses safe and failures typed/sanitized', () => {
  expect(
    Schema.decodeUnknownSync(AssortmentPublicDecisionResponseSchema)({
      outcome: 'INDETERMINATE',
      retryable: true,
      safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
    }),
  ).toEqual({ outcome: 'INDETERMINATE', retryable: true, safeReasonCode: 'DEPENDENCY_UNAVAILABLE' });
  expect(() =>
    Schema.decodeUnknownSync(AssortmentPublicDecisionResponseSchema)({
      outcome: 'ELIGIBLE',
      retryable: true,
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentPublicDecisionResponseSchema)({
      outcome: 'INELIGIBLE',
      retryable: false,
      safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentPublicDecisionResponseSchema)({
      outcome: 'INDETERMINATE',
      retryable: false,
      safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentPublicDecisionResponseSchema)({
      outcome: 'INDETERMINATE',
      retryable: true,
      safeReasonCode: 'CONFIGURATION_CONFLICT',
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentDecisionEvidenceSchema)({
      factCurrentness: [],
      operationTime: context.operationTime,
      setCompleteness: [],
      subject: profileSubject,
      target: { kind: 'PRODUCT', productRef: atomicSelection.productRef },
      trustedContext: context,
    }),
  ).not.toThrow();
  expect(
    Schema.is(AssortmentConfigurationConflictError)(
      new AssortmentConfigurationConflictError({
        code: 'CONFIGURATION_CONFLICT',
        conflictKind: 'BOUNDARY',
        safeReasonCode: 'CONFIGURATION_CONFLICT',
      }),
    ),
  ).toBe(true);
  expect(
    Schema.is(AssortmentMissingConfigurationError)(
      new AssortmentMissingConfigurationError({
        code: 'MISSING_CONFIGURATION',
        safeReasonCode: 'MISSING_CONFIGURATION',
      }),
    ),
  ).toBe(true);
  expect(
    Schema.is(AssortmentDependencyFailureError)(
      new AssortmentDependencyFailureError({
        code: 'DEPENDENCY_FAILURE',
        ownerModuleId: Schema.decodeUnknownSync(AssortmentOwnerResourceRefSchema)(
          ref('catalog.owner', 'catalog.resource', 'resource-1'),
        ).moduleId,
        retryable: true,
        safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
      }),
    ),
  ).toBe(true);
  expect(
    Schema.is(AssortmentRetryExhaustedError)(
      new AssortmentRetryExhaustedError({
        attempts: 3,
        code: 'RETRY_EXHAUSTED',
        maxAttempts: 3,
        safeReasonCode: 'RETRY_EXHAUSTED',
      }),
    ),
  ).toBe(true);
});

it('rejects unqualified revision and evidence ownership', () => {
  expect(() =>
    Schema.decodeUnknownSync(AssortmentCatalogSelectionSchema)({
      ...atomicSelection,
      packageOption: {
        contentRevision: {
          ownerModuleId: 'catalog.owner',
          revision: 'r1',
          sourceRef: ref('catalog.other', 'catalog.other.revision', 'content-1'),
        },
        packageOptionRef: catalogRef('catalog.package-option', 'option-1'),
      },
    }),
  ).toThrow();
});
