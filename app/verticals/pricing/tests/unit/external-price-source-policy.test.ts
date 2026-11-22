import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ManageExternalPriceSourcePolicyPayloadSchema } from '../../shared/actions/manage-external-price-source-policy.ts';
import { ExternalPriceSourcePolicySchema } from '../../shared/domain/external-price-source-policy.ts';
import type { ExternalPriceSourcePolicy } from '../../shared/domain/external-price-source-policy.ts';
import {
  ExternalPriceSourcePolicyConflict,
  ExternalPriceSourcePolicyRejected,
  applyManageExternalPriceSourcePolicy,
} from '../../src/actions/manage-external-price-source-policy.action.ts';
import { decodeExternalPriceSourceAuthorityAssessment } from '../../src/persistence/external-price-source-authority-persistence.ts';
import type { ExternalPriceSourceAuthorityPersistence } from '../../src/persistence/external-price-source-authority-persistence.ts';
import {
  makeExternalPriceInputBoundary,
  policyCoversRequest,
} from '../../src/services/external-price-input-boundary.service.ts';
import type { ExternalPriceInputBoundaryRequest } from '../../src/services/external-price-input-boundary.service.ts';
import {
  priceGroupRef,
  priceKey,
  priceListMapping,
  policyTerms,
  productMapping,
  sourceAssertionFor,
  unitRefFor,
} from '../support/standing-price-source-policy.fixture.ts';

const world = {
  legalEntityId: 'f1000000-0000-4000-8000-000000000002',
  tenantId: 'f1000000-0000-4000-8000-000000000001',
  unitId: 'f1000000-0000-4000-8000-000000000003',
};
const newVariant = {
  productId: 'f1000000-0000-4000-8000-000000000011',
  variantId: 'f1000000-0000-4000-8000-000000000012',
};
const groupId = 'f1000000-0000-4000-8000-000000000021';
const operationAt = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-20T10:00:00.000Z'));

describe('Standing source policy native identifier boundary', () => {
  it('rejects wildcard authority and mapping references that canonical Price assertions cannot store', () => {
    const terms = policyTerms(world);
    const payload = { intent: 'ESTABLISH', policy: terms, reason: 'Source authority', verificationRef: 'verified' };
    expect(Schema.is(ManageExternalPriceSourcePolicyPayloadSchema)(payload)).toBe(true);
    for (const policy of [
      { ...terms, authority: { ...terms.authority, sourceAuthorityRef: '*' } },
      { ...terms, authority: { ...terms.authority, sourceAuthorityVersion: '*' } },
      { ...terms, mapping: { ...terms.mapping, mappingContractRef: '*' } },
      { ...terms, mapping: { ...terms.mapping, mappingContractVersion: '*' } },
    ]) {
      expect(Schema.is(ManageExternalPriceSourcePolicyPayloadSchema)({ ...payload, policy })).toBe(false);
    }
  });

  it('preserves trimmed verification references up to 300 UTF-16 code units', () => {
    const payload = { intent: 'ESTABLISH', policy: policyTerms(world), reason: 'Source authority' };
    const accepts = (verificationRef: string) =>
      Schema.is(ManageExternalPriceSourcePolicyPayloadSchema)({ ...payload, verificationRef });
    expect(accepts(`a\t${'🔖'.repeat(149)}`)).toBe(true);
    for (const ref of ['trailing\t', '\u00A0leading', 'trailing\uFEFF', '🔖'.repeat(151)]) {
      expect(accepts(ref)).toBe(false);
    }
  });

  it('rejects an uppercase END identifier before it can become a persistence-unavailable error', () => {
    const payload = {
      effectiveTo: '2026-11-21T00:00:00.000Z',
      intent: 'END',
      policyId: 'f1000000-0000-4000-8000-000000000031',
      reason: 'End the source authority',
      verificationRef: 'policy-end-proof',
    };
    expect(Schema.is(ManageExternalPriceSourcePolicyPayloadSchema)(payload)).toBe(true);
    expect(
      Schema.is(ManageExternalPriceSourcePolicyPayloadSchema)({
        ...payload,
        policyId: payload.policyId.toUpperCase(),
      }),
    ).toBe(false);
  });

  it('requires canonical native Unit, Price Group, Tenant and Legal Entity identifiers on ESTABLISH', () => {
    const terms = policyTerms(world);
    const payload = {
      intent: 'ESTABLISH',
      policy: terms,
      reason: 'Establish the source authority',
      verificationRef: 'policy-establish-proof',
    };
    expect(Schema.is(ManageExternalPriceSourcePolicyPayloadSchema)(payload)).toBe(true);
    const noncanonicalPolicies = [
      {
        ...terms,
        unitBasis: {
          ...terms.unitBasis,
          unitRef: { ...terms.unitBasis.unitRef, resourceId: world.unitId.toUpperCase() },
        },
      },
      {
        ...terms,
        unitBasis: {
          ...terms.unitBasis,
          unitRef: { ...terms.unitBasis.unitRef, tenantId: world.tenantId.toUpperCase() },
        },
      },
      {
        ...terms,
        commercialScope: { ...terms.commercialScope, sellingLegalEntityId: world.legalEntityId.toUpperCase() },
      },
      {
        ...terms,
        priceGroupCoverage: {
          kind: 'PRICE_GROUP',
          priceGroupRef: priceGroupRef(world.tenantId, groupId.toUpperCase()),
        },
      },
      {
        ...terms,
        priceGroupCoverage: {
          kind: 'PRICE_GROUP',
          priceGroupRef: priceGroupRef(world.tenantId.toUpperCase(), groupId),
        },
      },
    ];
    for (const policy of noncanonicalPolicies) {
      expect(Schema.is(ManageExternalPriceSourcePolicyPayloadSchema)({ ...payload, policy })).toBe(false);
    }
  });
});

const storedPolicy = (overrides: Partial<ExternalPriceSourcePolicy> = {}): ExternalPriceSourcePolicy =>
  Schema.decodeSync(ExternalPriceSourcePolicySchema)({
    ...policyTerms(world),
    family: 'PRICE',
    ownerModuleId: 'commerce.pricing',
    policyId: 'f1000000-0000-4000-8000-000000000031',
    schemaVersion: '1',
    verificationRef: 'akros-erp-price-source-policy',
    verifiedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  });

const requestFor = (
  key = priceKey(world, newVariant),
  effectiveAt = '2026-11-20T09:00:00.000Z',
  mapping: typeof priceListMapping | typeof productMapping = productMapping,
): ExternalPriceInputBoundaryRequest => {
  const sourceAssertion = sourceAssertionFor(key, {
    effectiveAt,
    mapping,
    sourceAssertionId: 'f1000000-0000-4000-8000-000000000041',
  });
  return {
    actingPrincipalId: 'f1000000-0000-4000-8000-000000000051',
    effectiveFrom: effectiveAt,
    identityKey: key,
    monetaryAmount: { amount: '199.90', currencyCode: key.currencyCode },
    sourceAssertion,
    tenantId: world.tenantId,
    trustedOperationAt: operationAt,
  };
};

const boundaryCovering = (policy: ExternalPriceSourcePolicy) =>
  makeExternalPriceInputBoundary({
    assess: () => Effect.succeed({ outcome: 'AUTHORITY_COVERED_BY_POLICY', policy }),
  });

describe('Standing external Price source policy at the external Price input boundary', () => {
  it.effect('rejects noncanonical Unit and Price Group IDs before consulting exact or standing authority', () =>
    Effect.gen(function* rejectNoncanonicalIdentity() {
      const boundary = makeExternalPriceInputBoundary({ assess: () => Effect.die('invalid key reached authority') });
      // The shared Price key and source contracts accept uppercase UUIDs. Pricing source admission is stricter.
      const keys = [
        priceKey(world, newVariant, {
          unitBasis: { quantity: '1', unitRef: unitRefFor(world, world.unitId.toUpperCase()) },
        }),
        priceKey(world, newVariant, {
          priceGroupSelector: {
            kind: 'PRICE_GROUP',
            priceGroupRef: priceGroupRef(world.tenantId, groupId.toUpperCase()),
          },
        }),
      ];
      for (const key of keys) {
        expect(yield* boundary.assess(requestFor(key))).toMatchObject({
          outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID',
          reason: 'MAPPING_REJECTED',
        });
      }
    }),
  );

  it.effect('accepts a never-seen variant under the policy and keeps the exact source evidence', () =>
    Effect.gen(function* acceptsNewVariant() {
      const request = requestFor();
      const result = yield* boundaryCovering(storedPolicy()).assess(request);

      expect(result.outcome).toBe('READY_FOR_CANONICAL_WRITE');
      if (result.outcome === 'READY_FOR_CANONICAL_WRITE') {
        expect(result.evidence.sourceAssertion).toEqual(request.sourceAssertion);
        expect(result.evidence.tenantId).toBe(world.tenantId);
      }
    }),
  );

  it('covers exactly the keys inside its scope, currency, unit basis and Price Group coverage', () => {
    const policy = storedPolicy();
    expect(policyCoversRequest(policy, requestFor())).toBe('MATCH');
    expect(
      policyCoversRequest(
        policy,
        requestFor(
          priceKey(world, newVariant, {
            unitBasis: { quantity: '1.000000000', unitRef: policy.unitBasis.unitRef },
          }),
        ),
      ),
    ).toBe('MATCH');

    const outside = [
      priceKey(world, newVariant, {
        commercialScope: { ...policy.commercialScope, marketId: 'akros-sk' },
      }),
      priceKey(world, newVariant, { commercialScope: { ...policy.commercialScope, channelId: 'B2B' } }),
      priceKey(world, newVariant, {
        commercialScope: { ...policy.commercialScope, sellingLegalEntityId: 'f1000000-0000-4000-8000-000000000099' },
      }),
      priceKey(world, newVariant, { currencyCode: 'EUR' }),
      priceKey(world, newVariant, { unitBasis: { ...policy.unitBasis, quantity: '10' } }),
      priceKey(world, newVariant, {
        unitBasis: {
          quantity: '1',
          unitRef: { ...policy.unitBasis.unitRef, resourceId: 'f1000000-0000-4000-8000-000000000098' },
        },
      }),
      priceKey(world, newVariant, {
        priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef: priceGroupRef(world.tenantId, groupId) },
      }),
    ];
    for (const key of outside) {
      expect(policyCoversRequest(policy, requestFor(key))).toBe('MAPPING_MISMATCH');
    }
  });

  it('matches Price Group coverage: NO_GROUP only base Prices, one exact group, or any group but never a base Price', () => {
    const groupKey = priceKey(world, newVariant, {
      priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef: priceGroupRef(world.tenantId, groupId) },
    });
    const otherGroupKey = priceKey(world, newVariant, {
      priceGroupSelector: {
        kind: 'PRICE_GROUP',
        priceGroupRef: priceGroupRef(world.tenantId, 'f1000000-0000-4000-8000-000000000022'),
      },
    });
    const exactGroup = storedPolicy({
      mapping: priceListMapping,
      priceGroupCoverage: { kind: 'PRICE_GROUP', priceGroupRef: priceGroupRef(world.tenantId, groupId) },
    });
    const anyGroup = storedPolicy({ mapping: priceListMapping, priceGroupCoverage: { kind: 'ANY_PRICE_GROUP' } });

    expect(policyCoversRequest(exactGroup, requestFor(groupKey, undefined, priceListMapping))).toBe('MATCH');
    expect(policyCoversRequest(exactGroup, requestFor(otherGroupKey, undefined, priceListMapping))).toBe(
      'MAPPING_MISMATCH',
    );
    expect(policyCoversRequest(anyGroup, requestFor(otherGroupKey, undefined, priceListMapping))).toBe('MATCH');
    const foreignGroupRequest = {
      ...requestFor(otherGroupKey, undefined, priceListMapping),
      identityKey: {
        ...otherGroupKey,
        priceGroupSelector: {
          kind: 'PRICE_GROUP' as const,
          priceGroupRef: priceGroupRef('f1000000-0000-4000-8000-000000000099', groupId),
        },
      },
    };
    expect(policyCoversRequest(anyGroup, foreignGroupRequest)).toBe('MAPPING_MISMATCH');
    expect(policyCoversRequest(anyGroup, requestFor(priceKey(world, newVariant), undefined, priceListMapping))).toBe(
      'MAPPING_MISMATCH',
    );
  });

  it('takes authority and mapping from the policy, never from the incoming row, and honours its period', () => {
    const policy = storedPolicy({
      effectivePeriod: { effectiveFrom: '2026-11-01T00:00:00.000Z', effectiveTo: '2026-11-15T00:00:00.000Z' },
    });
    // The row claims the price-list mapping; the policy authorizes only the product mapping.
    expect(policyCoversRequest(policy, requestFor(undefined, '2026-11-10T00:00:00.000Z', priceListMapping))).toBe(
      'MAPPING_MISMATCH',
    );
    expect(policyCoversRequest(policy, requestFor(undefined, '2026-11-10T00:00:00.000Z'))).toBe('MATCH');
    // Ended: from its end the policy authorizes nothing.
    expect(policyCoversRequest(policy, requestFor(undefined, '2026-11-15T00:00:00.000Z'))).toBe('AUTHORITY_MISMATCH');
    expect(policyCoversRequest(policy, requestFor(undefined, '2026-10-31T23:59:59.999Z'))).toBe('AUTHORITY_MISMATCH');
    // A policy verified after the operation cannot authorize it.
    expect(policyCoversRequest(storedPolicy({ verifiedAt: '2026-11-21T00:00:00.000Z' }), requestFor())).toBe(
      'AUTHORITY_MISMATCH',
    );
  });

  it.effect('refuses a resolved policy that does not cover the request, and fails closed on a malformed one', () =>
    Effect.gen(function* refuses() {
      const outside = yield* boundaryCovering(storedPolicy()).assess(
        requestFor(priceKey(world, newVariant, { currencyCode: 'EUR' })),
      );
      expect(outside).toMatchObject({ outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID', reason: 'MAPPING_REJECTED' });

      const ended = yield* boundaryCovering(
        storedPolicy({
          effectivePeriod: { effectiveFrom: '2026-11-01T00:00:00.000Z', effectiveTo: '2026-11-10T00:00:00.000Z' },
        }),
      ).assess(requestFor());
      expect(ended).toMatchObject({
        outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID',
        reason: 'SOURCE_AUTHORITY_REJECTED',
      });

      const malformed = yield* makeExternalPriceInputBoundary({
        assess: () =>
          Effect.succeed({
            outcome: 'AUTHORITY_COVERED_BY_POLICY',
            policy: { ...storedPolicy(), verificationRef: ' not a verified reference ' },
          }),
      }).assess(requestFor());
      expect(malformed).toMatchObject({ outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE' });
    }),
  );

  it.effect('decodes the owner routine policy outcome as Pricing stores it', () =>
    Effect.gen(function* decodes() {
      const policy = storedPolicy({
        unitBasis: { quantity: '1.000000000', unitRef: storedPolicy().unitBasis.unitRef },
      });
      const decoded = yield* decodeExternalPriceSourceAuthorityAssessment([
        { payload: { outcome: 'AUTHORITY_COVERED_BY_POLICY', policy } },
      ]);
      expect(decoded).toEqual({ outcome: 'AUTHORITY_COVERED_BY_POLICY', policy });
    }),
  );
});

const persistence = (
  overrides: Partial<Pick<ExternalPriceSourceAuthorityPersistence, 'endPolicy' | 'storePolicy'>>,
): Pick<ExternalPriceSourceAuthorityPersistence, 'endPolicy' | 'storePolicy'> => ({
  endPolicy: () => Effect.die('unexpected end'),
  storePolicy: () => Effect.die('unexpected store'),
  ...overrides,
});

describe('Manage external Price source policy Action', () => {
  const trusted = { legalEntityId: world.legalEntityId, tenantId: world.tenantId, trustedOperationAt: operationAt };

  it.effect('stamps the verification time itself and stores the policy in the trusted Selling Legal Entity', () =>
    Effect.gen(function* stores() {
      const stored: unknown[] = [];
      const result = yield* applyManageExternalPriceSourcePolicy(
        {
          intent: 'ESTABLISH',
          policy: policyTerms(world),
          reason: 'Akros ERP owns its prices.',
          verificationRef: 'v-1',
        },
        trusted,
        persistence({
          storePolicy: (policy) => {
            stored.push(policy);
            return Effect.succeed({
              outcome: 'STORED',
              policyId: storedPolicy().policyId,
              verifiedAt: policy.verifiedAt,
            });
          },
        }),
      );
      expect(result).toEqual({
        intent: 'ESTABLISH',
        outcome: 'STORED',
        policyId: storedPolicy().policyId,
        verifiedAt: '2026-11-20T10:00:00.000Z',
      });
      expect(stored).toEqual([
        {
          ...policyTerms(world),
          family: 'PRICE',
          ownerModuleId: 'commerce.pricing',
          schemaVersion: '1',
          verificationRef: 'v-1',
          verifiedAt: '2026-11-20T10:00:00.000Z',
        },
      ]);
    }),
  );

  it.effect('refuses another company, overlapping coverage and an end outside the policy period', () =>
    Effect.gen(function* refuses() {
      const foreign = yield* applyManageExternalPriceSourcePolicy(
        {
          intent: 'ESTABLISH',
          policy: policyTerms(world, {
            commercialScope: {
              channelId: 'B2C',
              marketId: 'akros-cz',
              sellingLegalEntityId: 'f1000000-0000-4000-8000-000000000099',
            },
          }),
          reason: 'Other company.',
          verificationRef: 'v-2',
        },
        trusted,
        persistence({}),
      ).pipe(Effect.flip);
      expect(foreign).toBeInstanceOf(ExternalPriceSourcePolicyRejected);

      const overlap = yield* applyManageExternalPriceSourcePolicy(
        { intent: 'ESTABLISH', policy: policyTerms(world), reason: 'Twice.', verificationRef: 'v-3' },
        trusted,
        persistence({ storePolicy: () => Effect.succeed({ outcome: 'CONFLICT', reason: 'POLICY_OVERLAP' }) }),
      ).pipe(Effect.flip);
      expect(overlap).toBeInstanceOf(ExternalPriceSourcePolicyConflict);
      expect(overlap).toMatchObject({ code: 'external_price_source_policy_overlap' });

      const end = {
        effectiveTo: '2026-11-19T00:00:00.000Z',
        intent: 'END' as const,
        policyId: storedPolicy().policyId,
        reason: 'Source replaced.',
        verificationRef: 'v-4',
      };
      const past = yield* applyManageExternalPriceSourcePolicy(
        end,
        trusted,
        persistence({ endPolicy: () => Effect.succeed({ outcome: 'REJECTED', reason: 'END_OUTSIDE_PERIOD' }) }),
      ).pipe(Effect.flip);
      expect(past).toMatchObject({ code: 'external_price_source_policy_end_outside_period' });

      const missing = yield* applyManageExternalPriceSourcePolicy(
        end,
        trusted,
        persistence({ endPolicy: () => Effect.succeed({ outcome: 'NOT_FOUND' }) }),
      ).pipe(Effect.flip);
      expect(missing).toMatchObject({ code: 'external_price_source_policy_not_found' });

      const ended = yield* applyManageExternalPriceSourcePolicy(
        end,
        trusted,
        persistence({
          endPolicy: (record) => {
            expect(record.endedAt).toBe('2026-11-20T10:00:00.000Z');
            return Effect.succeed({ effectiveTo: record.effectiveTo, outcome: 'ENDED' });
          },
        }),
      );
      expect(ended).toEqual({
        effectiveTo: end.effectiveTo,
        intent: 'END',
        outcome: 'ENDED',
        policyId: end.policyId,
      });
    }),
  );
});
