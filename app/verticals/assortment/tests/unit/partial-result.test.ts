import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  AssortmentDiscoveryDisclosureContextSchema,
  AssortmentDiscoveryDisclosureCoverageSchema,
  AssortmentDiscoveryInclusionDecisionSchema,
  AssortmentPartialDiscoveryResultSchema,
} from '../../shared/domain/disclosure-contracts.ts';
import {
  AssortmentSafeDiscoveryProjectionSchema,
  accumulateAssortmentDiscoveryDecisions,
  encodeAssortmentSafeDiscoveryProjection,
} from '../../shared/domain/partial-result.ts';
import { AssortmentOwnerResourceRefSchema } from '../../shared/domain/decision-contracts.ts';
import type { AssortmentDiscoveryInclusionDecision } from '../../shared/domain/disclosure-contracts.ts';

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

const productRef = (resourceId: string, nextTenantId = tenantId) =>
  ref('catalog.owner', 'catalog.product', resourceId, nextTenantId);

const context = () =>
  Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureContextSchema)({
    decisionPurpose: 'VISIBILITY',
    subject: {
      kind: 'IDENTIFIED',
      subject: {
        kind: 'RETAIL_CUSTOMER_PROFILE',
        profileRef: ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', 'profile-1'),
      },
    },
    trustedContext: {
      channelRef: ref('commerce.channel', 'commerce.channel', 'web'),
      operationTime,
      sellingLegalEntityRef: ref('commerce.legal-entity', 'commerce.legal-entity', 'sle-1'),
      tenantId,
    },
  });

const encodedContext = (value: ReturnType<typeof context>) =>
  Schema.encodeSync(AssortmentDiscoveryDisclosureContextSchema)(value);

const coverage = (
  product: ReturnType<typeof productRef>,
  value: ReturnType<typeof context>,
  state: 'ESTABLISHED' | 'INVALIDATED' = 'ESTABLISHED',
) =>
  Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureCoverageSchema)({
    context: encodedContext(value),
    productRef: product,
    proof: {
      evidenceRef: ref('commerce.assortment', 'commerce.assortment.discovery-proof', 'proof-1'),
      ownerModuleId: 'commerce.assortment',
    },
    state,
  });

const include = (product: ReturnType<typeof productRef>, value: ReturnType<typeof context>) =>
  Schema.decodeUnknownSync(AssortmentDiscoveryInclusionDecisionSchema)({
    context: encodedContext(value),
    coverage: Schema.encodeSync(AssortmentDiscoveryDisclosureCoverageSchema)(coverage(product, value)),
    decision: 'INCLUDE',
    productRef: product,
  });

const omit = (
  product: ReturnType<typeof productRef>,
  value: ReturnType<typeof context>,
  withInvalidatedCoverage = false,
) => {
  const input = {
    context: encodedContext(value),
    decision: 'OMIT',
    productRef: product,
  };
  if (withInvalidatedCoverage) {
    return Schema.decodeUnknownSync(AssortmentDiscoveryInclusionDecisionSchema)({
      ...input,
      coverage: Schema.encodeSync(AssortmentDiscoveryDisclosureCoverageSchema)(coverage(product, value, 'INVALIDATED')),
    });
  }
  return Schema.decodeUnknownSync(AssortmentDiscoveryInclusionDecisionSchema)(input);
};

const evaluate = (value: ReturnType<typeof context>, decisions: readonly AssortmentDiscoveryInclusionDecision[]) =>
  accumulateAssortmentDiscoveryDecisions({ context: value, decisions });

it.effect('accumulates A/B/D safely, omits C, deduplicates, and is independent of input order', () =>
  Effect.gen(function* accumulatesInStableOrder() {
    const value = context();
    const firstOrder = yield* evaluate(value, [
      include(productRef('product-b'), value),
      omit(productRef('product-c'), value),
      include(productRef('product-a'), value),
      include(productRef('product-d'), value),
      include(productRef('product-a'), value),
    ]);
    const reverseOrder = yield* evaluate(value, [
      include(productRef('product-d'), value),
      include(productRef('product-a'), value),
      omit(productRef('product-c'), value),
      include(productRef('product-b'), value),
    ]);

    expect(firstOrder?.knownOmission).toBe(true);
    expect(firstOrder?.includedProductRefs).toEqual([
      productRef('product-a'),
      productRef('product-b'),
      productRef('product-d'),
    ]);
    expect(reverseOrder?.includedProductRefs).toEqual(firstOrder?.includedProductRefs);
  }),
);

it.effect('returns an empty Partial for known omission and no Partial for all safe inclusions', () =>
  Effect.gen(function* handlesEmptyAndCompleteResults() {
    const value = context();
    const empty = yield* evaluate(value, [omit(productRef('product-c'), value)]);
    expect(empty).toMatchObject({ includedProductRefs: [], knownOmission: true });

    const noPartial = yield* evaluate(value, [
      include(productRef('product-a'), value),
      include(productRef('product-b'), value),
    ]);
    expect(noPartial).toBeUndefined();
  }),
);

it.effect('treats invalidated and unverifiable slices as omission without fabricating evidence', () =>
  Effect.gen(function* omitsInvalidatedEvidence() {
    const value = context();
    const invalidated = yield* evaluate(value, [omit(productRef('product-c'), value, true)]);
    const unverifiable = yield* evaluate(value, [omit(productRef('product-c'), value)]);

    expect(invalidated).toMatchObject({ includedProductRefs: [], knownOmission: true });
    expect(unverifiable).toMatchObject({ includedProductRefs: [], knownOmission: true });
    if (invalidated !== undefined) {
      expect('proof' in invalidated).toBe(false);
    }
  }),
);

it.effect('rejects wrong request contexts and cross-tenant Product slices before accumulation', () =>
  Effect.gen(function* rejectsContextMismatches() {
    const expected = context();
    const wrongSubject = Schema.decodeUnknownSync(AssortmentDiscoveryDisclosureContextSchema)({
      ...encodedContext(expected),
      subject: {
        kind: 'IDENTIFIED',
        subject: {
          kind: 'RETAIL_CUSTOMER_PROFILE',
          profileRef: ref(
            'commerce.customer-context',
            'commerce.customer-context.retail-customer-profile',
            'profile-2',
          ),
        },
      },
    });
    const contextFailure = yield* Effect.flip(evaluate(expected, [omit(productRef('product-a'), wrongSubject)]));
    expect(contextFailure).toBeDefined();
    expect(() => coverage(productRef('foreign-product', otherTenantId), expected)).toThrow();
  }),
);

it.effect('encodes only safe Product refs and cannot expose internal Partial metadata', () =>
  Effect.gen(function* encodesOnlySafeRefs() {
    const value = context();
    const partial = yield* evaluate(value, [omit(productRef('product-c'), value)]);
    if (partial === undefined) {
      throw new Error('expected known omission');
    }
    const projection = encodeAssortmentSafeDiscoveryProjection(partial);
    expect(projection).toEqual({ includedProductRefs: [] });
    expect('knownOmission' in projection).toBe(false);
    expect('context' in projection).toBe(false);
    expect('omittedProductCount' in projection).toBe(false);
    expect('omittedProductRefs' in projection).toBe(false);
    expect('reason' in projection).toBe(false);
    expect('proof' in projection).toBe(false);

    expect(() =>
      Schema.decodeUnknownSync(AssortmentSafeDiscoveryProjectionSchema, { onExcessProperty: 'error' })({
        includedProductRefs: [],
        knownOmission: true,
        omittedProductCount: 1,
        policyPath: 'private',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AssortmentSafeDiscoveryProjectionSchema)({
        includedProductRefs: [productRef('product-b'), productRef('product-a')],
      }),
    ).toThrow();
  }),
);

it.effect('keeps the internal Partial schema valid for accumulator output', () =>
  Effect.gen(function* validatesAccumulatorOutput() {
    const value = context();
    const partial = yield* evaluate(value, [omit(productRef('product-c'), value)]);
    expect(partial === undefined ? false : Schema.is(AssortmentPartialDiscoveryResultSchema)(partial)).toBe(true);
  }),
);
