import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  AssortmentCatalogSelectionSchema,
  AssortmentOwnerResourceRefSchema,
  AssortmentSetPurchaseCompositionSchema,
} from '../../shared/domain/decision-contracts.ts';
import { AssortmentProspectivePurchaseEvidenceSchema } from '../../shared/domain/consumer-evidence.ts';

const tenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a11';
const ref = (moduleId: string, resourceType: string, resourceId: string, refTenantId = tenantId) =>
  Schema.decodeUnknownSync(AssortmentOwnerResourceRefSchema)({
    moduleId,
    resourceId,
    resourceType,
    tenantId: refTenantId,
  });
const revision = (resourceId: string, revisionValue = 'r1') => ({
  ownerModuleId: 'catalog.owner',
  revision: revisionValue,
  sourceRef: ref('catalog.owner', 'catalog.set-composition-revision', resourceId),
});
const selection = (productId: string, variantId: string) =>
  Schema.decodeUnknownSync(AssortmentCatalogSelectionSchema)({
    configuration: { kind: 'NONE' },
    productRef: ref('catalog.owner', 'catalog.product', productId),
    variantKind: 'ATOMIC',
    variantRef: ref('catalog.owner', 'catalog.variant', variantId),
  });
const decisionEvidence = (resourceId: string) => ({
  evidenceRef: ref('commerce.assortment', 'commerce.assortment.decision-evidence', resourceId),
  ownerModuleId: 'commerce.assortment',
});
const trustedContext = {
  channelRef: ref('commerce.channel', 'commerce.channel.channel', 'web'),
  operationTime: '2026-09-23T08:00:00.000Z',
  sellingLegalEntityRef: ref('commerce.legal-entity', 'commerce.legal-entity.selling-legal-entity', 'sle-1'),
  tenantId,
};
const subject = {
  kind: 'IDENTIFIED' as const,
  subject: {
    kind: 'RETAIL_CUSTOMER_PROFILE' as const,
    profileRef: ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', 'profile-1'),
  },
};

it('publishes one safe non-Set evidence reference without resolver internals', () => {
  const topLevelConstituent = { catalogSelection: selection('product-1', 'variant-1'), role: 'TOP_LEVEL' as const };
  const decoded = Schema.decodeUnknownSync(AssortmentProspectivePurchaseEvidenceSchema)({
    composedOutcome: 'ELIGIBLE',
    evaluatedConstituents: [
      { constituent: topLevelConstituent, decisionEvidence: decisionEvidence('evidence-1'), outcome: 'ELIGIBLE' },
    ],
    subject,
    topLevelConstituent,
    trustedContext,
  });

  expect(decoded.composedOutcome).toBe('ELIGIBLE');
  expect('candidates' in decoded).toBe(false);
  expect('boundaryPath' in decoded).toBe(false);
  expect('attemptId' in decoded).toBe(false);
  expect('confirmationRef' in decoded).toBe(false);
});

it('pins the complete Set identity while preserving only outcomes actually evaluated for a denial', () => {
  const setRevision = revision('composition-1');
  const setSelection = Schema.decodeUnknownSync(AssortmentCatalogSelectionSchema)({
    configuration: { kind: 'NONE' },
    productRef: ref('catalog.owner', 'catalog.product', 'set-product'),
    setCompositionRevision: setRevision,
    variantKind: 'SET',
    variantRef: ref('catalog.owner', 'catalog.variant', 'set-variant'),
  });
  const topLevelConstituent = { catalogSelection: setSelection, role: 'TOP_LEVEL' as const };
  const componentA = { catalogSelection: selection('component-a', 'variant-a'), role: 'REQUIRED_COMPONENT' as const };
  const componentB = { catalogSelection: selection('component-b', 'variant-b'), role: 'REQUIRED_COMPONENT' as const };
  const setComposition = Schema.decodeUnknownSync(AssortmentSetPurchaseCompositionSchema)({
    requiredComponents: [componentA, componentB],
    setCompositionRevision: setRevision,
  });
  const decoded = Schema.decodeUnknownSync(AssortmentProspectivePurchaseEvidenceSchema)({
    composedOutcome: 'INELIGIBLE',
    evaluatedConstituents: [
      { constituent: topLevelConstituent, decisionEvidence: decisionEvidence('set-evidence'), outcome: 'ELIGIBLE' },
      {
        constituent: componentA,
        decisionEvidence: decisionEvidence('component-a-evidence'),
        outcome: 'INELIGIBLE',
        safeReasonCode: 'RULE_DENIED',
      },
    ],
    setComposition,
    subject,
    topLevelConstituent,
    trustedContext,
  });

  expect(decoded.setComposition?.requiredComponents).toHaveLength(2);
  expect(decoded.evaluatedConstituents).toHaveLength(2);
});

it('rejects a fabricated sibling, duplicate evidence reference, and incomplete positive Set', () => {
  const setRevision = revision('composition-1');
  const setSelection = Schema.decodeUnknownSync(AssortmentCatalogSelectionSchema)({
    configuration: { kind: 'NONE' },
    productRef: ref('catalog.owner', 'catalog.product', 'set-product'),
    setCompositionRevision: setRevision,
    variantKind: 'SET',
    variantRef: ref('catalog.owner', 'catalog.variant', 'set-variant'),
  });
  const topLevelConstituent = { catalogSelection: setSelection, role: 'TOP_LEVEL' as const };
  const component = { catalogSelection: selection('component-a', 'variant-a'), role: 'REQUIRED_COMPONENT' as const };
  const setComposition = Schema.decodeUnknownSync(AssortmentSetPurchaseCompositionSchema)({
    requiredComponents: [component],
    setCompositionRevision: setRevision,
  });
  const base = {
    composedOutcome: 'ELIGIBLE',
    evaluatedConstituents: [
      { constituent: topLevelConstituent, decisionEvidence: decisionEvidence('same-evidence'), outcome: 'ELIGIBLE' },
    ],
    setComposition,
    subject,
    topLevelConstituent,
    trustedContext,
  } as const;

  expect(Schema.is(AssortmentProspectivePurchaseEvidenceSchema)(base)).toBe(false);
  expect(
    Schema.is(AssortmentProspectivePurchaseEvidenceSchema)({
      ...base,
      evaluatedConstituents: [
        ...base.evaluatedConstituents,
        {
          constituent: { catalogSelection: selection('foreign', 'foreign-variant'), role: 'REQUIRED_COMPONENT' },
          decisionEvidence: decisionEvidence('foreign-evidence'),
          outcome: 'ELIGIBLE',
        },
      ],
    }),
  ).toBe(false);
  expect(
    Schema.is(AssortmentProspectivePurchaseEvidenceSchema)({
      ...base,
      evaluatedConstituents: [
        ...base.evaluatedConstituents,
        { constituent: component, decisionEvidence: decisionEvidence('same-evidence'), outcome: 'ELIGIBLE' },
      ],
    }),
  ).toBe(false);
});

it('rejects foreign or non-Assortment evidence identities', () => {
  const topLevelConstituent = { catalogSelection: selection('product-1', 'variant-1'), role: 'TOP_LEVEL' as const };
  const base = {
    composedOutcome: 'ELIGIBLE',
    evaluatedConstituents: [
      { constituent: topLevelConstituent, decisionEvidence: decisionEvidence('evidence-1'), outcome: 'ELIGIBLE' },
    ],
    subject,
    topLevelConstituent,
    trustedContext,
  } as const;
  expect(
    Schema.is(AssortmentProspectivePurchaseEvidenceSchema)({
      ...base,
      evaluatedConstituents: [
        {
          ...base.evaluatedConstituents[0],
          decisionEvidence: {
            evidenceRef: ref('catalog.owner', 'catalog.evidence', 'wrong-owner'),
            ownerModuleId: 'catalog.owner',
          },
        },
      ],
    }),
  ).toBe(false);
});

it('rejects a Set composition revision with the same token but a different exact identity', () => {
  const setRevision = revision('composition-1');
  const topLevelConstituent = {
    catalogSelection: Schema.decodeUnknownSync(AssortmentCatalogSelectionSchema)({
      configuration: { kind: 'NONE' },
      productRef: ref('catalog.owner', 'catalog.product', 'set-product'),
      setCompositionRevision: {
        ownerModuleId: 'other.catalog',
        revision: setRevision.revision,
        sourceRef: ref('other.catalog', 'catalog.set-composition-revision', 'composition-1'),
      },
      variantKind: 'SET',
      variantRef: ref('catalog.owner', 'catalog.variant', 'set-variant'),
    }),
    role: 'TOP_LEVEL' as const,
  };
  const component = { catalogSelection: selection('component-a', 'variant-a'), role: 'REQUIRED_COMPONENT' as const };
  const setComposition = Schema.decodeUnknownSync(AssortmentSetPurchaseCompositionSchema)({
    requiredComponents: [component],
    setCompositionRevision: setRevision,
  });

  expect(
    Schema.is(AssortmentProspectivePurchaseEvidenceSchema)({
      composedOutcome: 'INELIGIBLE',
      evaluatedConstituents: [
        {
          constituent: topLevelConstituent,
          decisionEvidence: decisionEvidence('set-evidence'),
          outcome: 'INELIGIBLE',
          safeReasonCode: 'RULE_DENIED',
        },
      ],
      setComposition,
      subject,
      topLevelConstituent,
      trustedContext,
    }),
  ).toBe(false);
});

it('rejects cross-tenant subjects and evidence plus inconsistent retryability', () => {
  const topLevelConstituent = { catalogSelection: selection('product-1', 'variant-1'), role: 'TOP_LEVEL' as const };
  const base = {
    composedOutcome: 'INDETERMINATE',
    evaluatedConstituents: [
      {
        constituent: topLevelConstituent,
        outcome: 'INDETERMINATE',
        retryable: true,
        safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
      },
    ],
    subject,
    topLevelConstituent,
    trustedContext,
  } as const;

  expect(
    Schema.is(AssortmentProspectivePurchaseEvidenceSchema)({
      ...base,
      evaluatedConstituents: [
        {
          constituent: topLevelConstituent,
          decisionEvidence: {
            evidenceRef: ref(
              'commerce.assortment',
              'commerce.assortment.decision-evidence',
              'foreign-evidence',
              '018f8b4e-35a2-7b51-8d56-91a4f37d6a22',
            ),
            ownerModuleId: 'commerce.assortment',
          },
          outcome: 'ELIGIBLE',
        },
      ],
    }),
  ).toBe(false);
  expect(
    Schema.is(AssortmentProspectivePurchaseEvidenceSchema)({
      ...base,
      subject: {
        kind: 'IDENTIFIED',
        subject: {
          kind: 'RETAIL_CUSTOMER_PROFILE',
          profileRef: ref(
            'commerce.customer-context',
            'commerce.customer-context.retail-customer-profile',
            'profile-foreign',
            '018f8b4e-35a2-7b51-8d56-91a4f37d6a22',
          ),
        },
      },
    }),
  ).toBe(false);
  expect(
    Schema.is(AssortmentProspectivePurchaseEvidenceSchema)({
      ...base,
      evaluatedConstituents: [
        {
          constituent: topLevelConstituent,
          outcome: 'INDETERMINATE',
          retryable: false,
          safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
        },
      ],
    }),
  ).toBe(false);
});
