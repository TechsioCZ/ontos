import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  AssortmentDiscoveryDisclosureContextSchema,
  AssortmentDiscoveryDisclosureCoverageSchema,
  AssortmentDiscoveryDisclosureEquivalenceSchema,
  AssortmentDiscoveryDisclosureInvalidationSchema,
  AssortmentDiscoveryInclusionDecisionSchema,
  AssortmentPartialDiscoveryResultSchema,
} from '../../shared/domain/disclosure-contracts.ts';
import { AssortmentOwnerResourceRefSchema } from '../../shared/domain/decision-contracts.ts';

const tenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a11';
const otherTenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a22';
const operationTime = '2026-09-22T10:00:00.000Z';

const ref = (moduleId: string, resourceType: string, resourceId: string, nextTenantId = tenantId) =>
  Schema.decodeUnknownSync(AssortmentOwnerResourceRefSchema)({
    moduleId,
    resourceId,
    resourceType,
    tenantId: nextTenantId,
  });

const productRef = (resourceId = 'product-1', nextTenantId = tenantId) =>
  ref('catalog.owner', 'catalog.product', resourceId, nextTenantId);

const subject = (profileId = 'profile-1', nextTenantId = tenantId) => ({
  kind: 'IDENTIFIED' as const,
  subject: {
    kind: 'RETAIL_CUSTOMER_PROFILE' as const,
    profileRef: ref(
      'commerce.customer-context',
      'commerce.customer-context.retail-customer-profile',
      profileId,
      nextTenantId,
    ),
  },
});

const guestSubject = (revision = 'r1') => ({
  guestEvidence: {
    evidenceRef: ref('commerce.guest-context', 'commerce.guest-context.evidence', 'guest-1'),
    ownerModuleId: 'commerce.guest-context',
    sourceRevision: {
      ownerModuleId: 'commerce.guest-context',
      revision,
      sourceRef: ref('commerce.guest-context', 'commerce.guest-context.revision', 'guest-revision-1'),
    },
  },
  kind: 'GUEST_PURCHASE_CONTEXT' as const,
});

const proof = (resourceId: string, nextTenantId = tenantId, ownerModuleId = 'catalog.owner') => ({
  evidenceRef: ref(ownerModuleId, `${ownerModuleId}.disclosure-proof`, resourceId, nextTenantId),
  ownerModuleId,
});

type ContextOverrides = Partial<{
  subject: ReturnType<typeof guestSubject> | ReturnType<typeof subject>;
  trustedContext: {
    channelRef: ReturnType<typeof ref>;
    commerceMarketRef?: ReturnType<typeof ref>;
    operationTime: string;
    sellingLegalEntityRef: ReturnType<typeof ref>;
    storefrontRef?: ReturnType<typeof ref>;
    tenantId: string;
  };
}>;

const context = (overrides: ContextOverrides = {}) =>
  Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureContextSchema)({
    decisionPurpose: 'VISIBILITY',
    subject: subject(),
    trustedContext: {
      channelRef: ref('commerce.channel', 'commerce.channel', 'web'),
      operationTime,
      sellingLegalEntityRef: ref('commerce.legal-entity', 'commerce.legal-entity', 'sle-1'),
      tenantId,
    },
    ...overrides,
  });

const encodedContext = (value: ReturnType<typeof context>) =>
  Schema.encodeSync(AssortmentDiscoveryDisclosureContextSchema)(value);

const coverage = (
  product: ReturnType<typeof productRef> = productRef(),
  state: 'ESTABLISHED' | 'INVALIDATED' = 'ESTABLISHED',
  contextOverride = context(),
  proofOverride = proof('disclosure-proof', tenantId, 'commerce.assortment'),
) =>
  Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureCoverageSchema)({
    context: encodedContext(contextOverride),
    productRef: product,
    proof: proofOverride,
    state,
  });

const encodedCoverage = (value: ReturnType<typeof coverage>) =>
  Schema.encodeSync(AssortmentDiscoveryDisclosureCoverageSchema)(value);

it('accepts exact batch contexts for identified and Guest subjects, rejecting wrong forms and tenants', () => {
  const identified = context();
  expect(identified.subject.kind).toBe('IDENTIFIED');

  const guest = Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureContextSchema)({
    ...encodedContext(identified),
    subject: guestSubject(),
  });
  expect(guest.subject.kind).toBe('GUEST_PURCHASE_CONTEXT');

  expect(() =>
    Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureContextSchema)({
      ...encodedContext(identified),
      subject: { kind: 'PRINCIPAL', principalRef: ref('core', 'core.principal', 'principal-1') },
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureContextSchema)({
      ...encodedContext(identified),
      subject: subject('profile-foreign', otherTenantId),
    }),
  ).toThrow();
});

it('binds established and invalidated coverage to one Product, context, proof owner, and tenant', () => {
  const exactContext = context();
  expect(coverage(productRef(), 'ESTABLISHED', exactContext).state).toBe('ESTABLISHED');
  const invalidated = Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureInvalidationSchema)({
    context: encodedContext(exactContext),
    productRef: productRef(),
    proof: proof('invalidation-proof', tenantId, 'commerce.assortment'),
    state: 'INVALIDATED',
  });
  expect(invalidated.state).toBe('INVALIDATED');

  expect(() =>
    Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureCoverageSchema)({
      context: encodedContext(exactContext),
      productRef: productRef('foreign-product', otherTenantId),
      proof: proof('foreign-proof', otherTenantId, 'commerce.assortment'),
      state: 'ESTABLISHED',
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureCoverageSchema)({
      context: encodedContext(exactContext),
      productRef: productRef(),
      proof: proof('unrelated-owner-proof'),
      state: 'ESTABLISHED',
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureCoverageSchema)({
      context: encodedContext(exactContext),
      productRef: productRef(),
      proof: {
        ...proof('foreign-revision-proof', tenantId, 'commerce.assortment'),
        sourceRevision: {
          ownerModuleId: 'commerce.assortment',
          revision: 'r1',
          sourceRef: ref('commerce.assortment', 'commerce.assortment.revision', 'revision-1', otherTenantId),
        },
      },
      state: 'INVALIDATED',
    }),
  ).toThrow();
});

it('requires explicit Assortment-owned equivalence for one Product across request contexts', () => {
  const source = context();
  const target = context({ subject: subject('profile-2') });
  const equivalent = Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureEquivalenceSchema)({
    kind: 'ASSORTMENT_PROVEN_CONTEXT_EQUIVALENCE',
    productRef: productRef(),
    proof: proof('equivalence-proof', tenantId, 'commerce.assortment'),
    source: encodedContext(source),
    target: encodedContext(target),
  });
  expect(equivalent.kind).toBe('ASSORTMENT_PROVEN_CONTEXT_EQUIVALENCE');

  expect(() =>
    Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureEquivalenceSchema)({
      ...Schema.encodeSync(AssortmentDiscoveryDisclosureEquivalenceSchema)(equivalent),
      productRef: productRef('foreign-product', otherTenantId),
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureEquivalenceSchema)({
      ...Schema.encodeSync(AssortmentDiscoveryDisclosureEquivalenceSchema)(equivalent),
      proof: proof('unrelated-owner-proof'),
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureEquivalenceSchema)({
      ...Schema.encodeSync(AssortmentDiscoveryDisclosureEquivalenceSchema)(equivalent),
      proof: proof('foreign-equivalence-proof', otherTenantId, 'commerce.assortment'),
    }),
  ).toThrow();
});

it('keeps Partial scoped to one batch context while accepting empty and non-empty Product sets', () => {
  const exactContext = context();
  const empty = Schema.decodeUnknownSync(AssortmentPartialDiscoveryResultSchema)({
    context: encodedContext(exactContext),
    includedProductRefs: [],
    knownOmission: true,
  });
  expect(empty.includedProductRefs).toHaveLength(0);

  const nonEmpty = Schema.decodeUnknownSync(AssortmentPartialDiscoveryResultSchema)({
    context: encodedContext(exactContext),
    includedProductRefs: [productRef(), productRef('product-2')],
    knownOmission: true,
  });
  expect(nonEmpty.includedProductRefs).toHaveLength(2);
  const encoded = Schema.encodeSync(AssortmentPartialDiscoveryResultSchema)(empty);
  expect('omittedProductCount' in encoded).toBe(false);
  expect(() =>
    Schema.decodeUnknownSync(AssortmentPartialDiscoveryResultSchema, { onExcessProperty: 'error' })({
      ...encoded,
      omittedProductCount: 1,
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentPartialDiscoveryResultSchema)({
      ...Schema.encodeSync(AssortmentPartialDiscoveryResultSchema)(nonEmpty),
      includedProductRefs: [productRef(), productRef()],
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentPartialDiscoveryResultSchema)({
      ...Schema.encodeSync(AssortmentPartialDiscoveryResultSchema)(empty),
      includedProductRefs: [productRef('foreign-product', otherTenantId)],
    }),
  ).toThrow();
});

it('requires INCLUDE Product and coverage to match exactly, including Guest evidence revisions', () => {
  const exactContext = context();
  const included = Schema.decodeUnknownSync(AssortmentDiscoveryInclusionDecisionSchema)({
    context: encodedContext(exactContext),
    coverage: encodedCoverage(coverage(productRef(), 'ESTABLISHED', exactContext)),
    decision: 'INCLUDE',
    productRef: productRef(),
  });
  expect(included.decision).toBe('INCLUDE');

  const omitted = Schema.decodeUnknownSync(AssortmentDiscoveryInclusionDecisionSchema)({
    context: encodedContext(exactContext),
    decision: 'OMIT',
    productRef: productRef(),
  });
  expect(omitted.decision).toBe('OMIT');

  expect(() =>
    Schema.decodeUnknownSync(AssortmentDiscoveryInclusionDecisionSchema)({
      context: encodedContext(exactContext),
      coverage: encodedCoverage(coverage(productRef('product-2'), 'ESTABLISHED', exactContext)),
      decision: 'INCLUDE',
      productRef: productRef(),
    }),
  ).toThrow();
  const guestContext = context({ subject: guestSubject() });
  expect(() =>
    Schema.decodeUnknownSync(AssortmentDiscoveryInclusionDecisionSchema)({
      context: encodedContext(context({ subject: guestSubject('r2') })),
      coverage: encodedCoverage(coverage(productRef(), 'ESTABLISHED', guestContext)),
      decision: 'OMIT',
      productRef: productRef(),
    }),
  ).toThrow();
});
