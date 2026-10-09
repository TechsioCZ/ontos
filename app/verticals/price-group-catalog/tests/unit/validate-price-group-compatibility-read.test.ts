import type { OperationalScope } from '@app/core-runtime';
import { Effect, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { getReadServiceFactory } from '../../../../packages/core-runtime/src/reads/definition.ts';

import { ValidatePriceGroupCompatibilityRequestSchema } from '../../shared/apis/validate-price-group-compatibility.ts';
import {
  PriceGroupCurrentnessFailure,
  PriceGroupExpectedCurrentConflict,
  PriceGroupLifecycleConflict,
  PriceGroupNotFound,
  PriceGroupPersistenceUnavailable,
} from '../../shared/domain/price-group-errors.ts';
import {
  PriceGroupCompatibilityDecisionSchema,
  PriceGroupDefinitionRevisionSchema,
  PriceGroupIdentitySchema,
} from '../../shared/domain/price-group.ts';
import type { ExpectedPriceGroupCurrentEvidence } from '../../shared/domain/price-group.ts';
import {
  validatePriceGroupCompatibilityPermissionTarget,
  validatePriceGroupCompatibilityRead,
  validatePriceGroupCompatibilityFromServices,
} from '../../src/api/validate-price-group-compatibility.read.ts';
import type { ValidatePriceGroupCompatibilityServices } from '../../src/api/validate-price-group-compatibility.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const priceGroupId = '22222222-2222-4222-8222-222222222222';
const definitionRevisionId = '33333333-3333-4333-8333-333333333333';
const trustedOperationAt = '2026-11-01T00:00:00.000Z';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: priceGroupId,
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};
const requiredContract = {
  contractId: 'commerce.customer-price-group-assignment',
  version: 1,
};
const definition = Schema.decodeUnknownSync(PriceGroupDefinitionRevisionSchema)({
  acceptedCatalogRevision: 7,
  classificationPurpose: 'Classifies customers eligible for dealer pricing.',
  compatibilityContracts: [requiredContract],
  created: {
    actionInvocationId: '44444444-4444-4444-8444-444444444444',
    actorPrincipalId: '55555555-5555-4555-8555-555555555555',
    reason: 'Approved current definition.',
    trustedAt: '2026-09-23T12:00:00.000Z',
  },
  definitionRevisionId,
  description: 'Dealer pricing classification.',
  displayName: 'Dealer',
  effectivePeriod: {
    effectiveFrom: '2026-10-01T00:00:00.000Z',
    effectiveTo: '2027-01-01T00:00:00.000Z',
  },
  meaningFingerprint: 'a'.repeat(64),
  previousDefinitionRevisionId: '77777777-7777-4777-8777-777777777777',
  priceGroupRef,
  revisionNumber: 3,
  semanticContinuity: {
    comparedDefinitionRevisionId: '77777777-7777-4777-8777-777777777777',
    decision: 'SAME_MEANING',
    provenance: {
      actionInvocationId: '44444444-4444-4444-8444-444444444444',
      actorPrincipalId: '55555555-5555-4555-8555-555555555555',
      reason: 'Approved current definition.',
      trustedAt: '2026-09-23T12:00:00.000Z',
    },
  },
});
const identity = Schema.decodeUnknownSync(PriceGroupIdentitySchema)({
  businessCode: 'DEALER',
  created: definition.created,
  createdAtCatalogRevision: 1,
  lifecycle: {
    activeFrom: definition.effectivePeriod.effectiveFrom,
    retiredAt: null,
    state: 'ACTIVE',
  },
  meaningFingerprint: definition.meaningFingerprint,
  priceGroupRef,
});
// Revision 11 accepted a future definition, but the trusted instant is still inside revision 3.
const currentSnapshot = { catalogRevision: 11, definition, identity } as const;
const expectedCurrent: ExpectedPriceGroupCurrentEvidence = {
  catalogRevision: currentSnapshot.catalogRevision,
  definitionRevisionId: definition.definitionRevisionId,
  definitionRevisionNumber: definition.revisionNumber,
  meaningFingerprint: definition.meaningFingerprint,
  priceGroupRef: definition.priceGroupRef,
};
const inputWithoutExpected = Schema.decodeUnknownSync(ValidatePriceGroupCompatibilityRequestSchema)({
  priceGroupRef,
  requiredContract,
  trustedOperationAt,
});
const inputWithExpected = Schema.decodeUnknownSync(ValidatePriceGroupCompatibilityRequestSchema)({
  ...inputWithoutExpected,
  expectedCurrent,
});
const usable = Schema.decodeUnknownSync(PriceGroupCompatibilityDecisionSchema)({
  evidence: {
    catalogRevision: 7,
    definitionEffectivePeriod: definition.effectivePeriod,
    definitionRevisionId,
    definitionRevisionNumber: 3,
    meaningFingerprint: definition.meaningFingerprint,
    priceGroupRef,
    requiredContract,
    trustedOperationAt,
    verifiedAt: '2026-11-01T00:00:01.000Z',
  },
  kind: 'USABLE',
});
const immediatelyBeforeRetirement = '2026-10-31T23:59:59.999Z';
const usableImmediatelyBeforeRetirement = Schema.decodeUnknownSync(PriceGroupCompatibilityDecisionSchema)({
  evidence: {
    catalogRevision: 7,
    definitionEffectivePeriod: definition.effectivePeriod,
    definitionRevisionId,
    definitionRevisionNumber: 3,
    meaningFingerprint: definition.meaningFingerprint,
    priceGroupRef,
    requiredContract,
    trustedOperationAt: immediatelyBeforeRetirement,
    verifiedAt: '2026-11-01T00:00:00.000Z',
  },
  kind: 'USABLE',
});
const missing = Schema.decodeUnknownSync(PriceGroupCompatibilityDecisionSchema)({
  catalogObservation: {
    catalogRevision: 7,
    observedAt: '2026-11-01T00:00:01.000Z',
    trustedOperationAt,
  },
  kind: 'MISSING',
  priceGroupRef,
});
const retired = Schema.decodeUnknownSync(PriceGroupCompatibilityDecisionSchema)({
  evidence: {
    acceptedCatalogRevision: 8,
    currentDefinitionRevisionId: definitionRevisionId,
    currentDefinitionRevisionNumber: 3,
    priceGroupRef,
    retiredAt: trustedOperationAt,
    retirementProvenance: definition.created,
    trustedOperationAt,
    verifiedAt: '2026-11-01T00:00:01.000Z',
  },
  kind: 'RETIRED',
});
const incompatible = Schema.decodeUnknownSync(PriceGroupCompatibilityDecisionSchema)({
  evidence: {
    definitionRevisionId,
    definitionRevisionNumber: 3,
    evaluatedCatalogRevision: 7,
    meaningFingerprint: definition.meaningFingerprint,
    priceGroupRef,
    requiredContract,
    trustedOperationAt,
    verifiedAt: '2026-11-01T00:00:01.000Z',
  },
  kind: 'INCOMPATIBLE',
});

const servicesWithDecision = (
  decision: typeof PriceGroupCompatibilityDecisionSchema.Type,
): ValidatePriceGroupCompatibilityServices => ({
  readCurrentDefinition: () => Effect.succeed(currentSnapshot),
  validateCompatibility: () => Effect.succeed(decision),
});

describe('Validate Price Group Compatibility governed Read', () => {
  it.effect('derives Expected Current from the authoritative schedule fence before a future-definition boundary', () =>
    Effect.gen(function* deriveExactEvidence() {
      let receivedExpected: ExpectedPriceGroupCurrentEvidence | undefined;
      let currentAt: Date | undefined;
      let compatibilityAt: Date | undefined;
      const result = yield* validatePriceGroupCompatibilityFromServices(inputWithoutExpected, tenantId, {
        readCurrentDefinition: (_ref, at) => {
          currentAt = at;
          return Effect.succeed(currentSnapshot);
        },
        validateCompatibility: (_ref, contract, at, expected) => {
          receivedExpected = expected;
          compatibilityAt = at;
          expect(contract).toEqual(requiredContract);
          return Effect.succeed(usable);
        },
      });

      expect(result).toEqual(usable);
      expect(receivedExpected).toEqual(expectedCurrent);
      expect(currentAt?.toISOString()).toBe(trustedOperationAt);
      expect(compatibilityAt?.toISOString()).toBe(trustedOperationAt);
    }),
  );

  it.effect('uses a safe internal sentinel only after authoritative absence and preserves MISSING', () =>
    Effect.gen(function* preserveMissing() {
      let receivedExpected: ExpectedPriceGroupCurrentEvidence | undefined;
      const result = yield* validatePriceGroupCompatibilityFromServices(inputWithoutExpected, tenantId, {
        readCurrentDefinition: () =>
          Effect.fail(
            new PriceGroupNotFound({
              code: 'price_group_not_found',
              reason: 'The Price Group does not exist in this tenant',
            }),
          ),
        validateCompatibility: (_ref, _contract, _at, expected) => {
          receivedExpected = expected;
          return Effect.succeed(missing);
        },
      });

      expect(result).toEqual(missing);
      expect(receivedExpected).toMatchObject({
        catalogRevision: 1,
        definitionRevisionId: '00000000-0000-4000-8000-000000000000',
        definitionRevisionNumber: 1,
        priceGroupRef,
      });
    }),
  );

  it.effect('preserves retirement dominance and incompatible evidence as canonical decisions', () =>
    Effect.gen(function* preserveCanonicalDecisions() {
      for (const decision of [retired, incompatible] as const) {
        const result = yield* validatePriceGroupCompatibilityFromServices(
          inputWithExpected,
          tenantId,
          servicesWithDecision(decision),
        );
        expect(result).toEqual(decision);
      }
    }),
  );

  it.effect('preserves USABLE immediately before retirement and RETIRED exactly at retiredAt', () =>
    Effect.gen(function* preserveRetirementBoundary() {
      const delegatedInstants: string[] = [];
      const cases = [
        [immediatelyBeforeRetirement, usableImmediatelyBeforeRetirement],
        [trustedOperationAt, retired],
      ] as const;

      for (const [operationAt, decision] of cases) {
        const boundaryInput = Schema.decodeUnknownSync(ValidatePriceGroupCompatibilityRequestSchema)({
          ...inputWithExpected,
          trustedOperationAt: operationAt,
        });
        const result = yield* validatePriceGroupCompatibilityFromServices(boundaryInput, tenantId, {
          readCurrentDefinition: () => Effect.die('explicit evidence must skip current-definition derivation'),
          validateCompatibility: (ref, _contract, at) => {
            expect(ref).toEqual(priceGroupRef);
            delegatedInstants.push(at.toISOString());
            return Effect.succeed(decision);
          },
        });

        expect(result).toBe(decision);
      }

      expect(delegatedInstants).toEqual([immediatelyBeforeRetirement, trustedOperationAt]);
    }),
  );

  it.effect('delegates exact half-open boundary instants without changing owner semantics', () =>
    Effect.gen(function* delegateBoundaries() {
      const delegated: string[] = [];
      for (const instant of [definition.effectivePeriod.effectiveFrom, definition.effectivePeriod.effectiveTo]) {
        if (instant === null) {
          continue;
        }
        const boundaryInput = Schema.decodeUnknownSync(ValidatePriceGroupCompatibilityRequestSchema)({
          ...inputWithExpected,
          trustedOperationAt: instant,
        });
        yield* validatePriceGroupCompatibilityFromServices(boundaryInput, tenantId, {
          readCurrentDefinition: () => Effect.die('explicit evidence must skip current-definition derivation'),
          validateCompatibility: (_ref, _contract, at) => {
            delegated.push(at.toISOString());
            return Effect.succeed(incompatible);
          },
        });
      }
      expect(delegated).toEqual([definition.effectivePeriod.effectiveFrom, definition.effectivePeriod.effectiveTo]);
    }),
  );

  it.effect('passes explicit evidence unchanged and preserves stale-evidence conflicts', () =>
    Effect.gen(function* preserveExpectedConflict() {
      let currentReads = 0;
      let receivedExpected: ExpectedPriceGroupCurrentEvidence | undefined;
      const failure = yield* validatePriceGroupCompatibilityFromServices(inputWithExpected, tenantId, {
        readCurrentDefinition: () => {
          currentReads += 1;
          return Effect.succeed(currentSnapshot);
        },
        validateCompatibility: (_ref, _contract, _at, expected) => {
          receivedExpected = expected;
          return Effect.fail(
            new PriceGroupExpectedCurrentConflict({
              code: 'price_group_expected_current_conflict',
              priceGroupRef,
              reason: 'Expected Current evidence does not match durable owner state',
            }),
          );
        },
      }).pipe(Effect.flip);

      expect(Predicate.isTagged(failure, 'PriceGroupExpectedCurrentConflict')).toBe(true);
      expect(receivedExpected).toEqual(expectedCurrent);
      expect(currentReads).toBe(0);
    }),
  );

  it.effect('fails cross-tenant before any owner persistence call', () =>
    Effect.gen(function* rejectCrossTenant() {
      let calls = 0;
      const failure = yield* validatePriceGroupCompatibilityFromServices(
        {
          ...inputWithoutExpected,
          priceGroupRef: { ...priceGroupRef, tenantId: otherTenantId },
        },
        tenantId,
        {
          readCurrentDefinition: () => {
            calls += 1;
            return Effect.succeed(currentSnapshot);
          },
          validateCompatibility: () => {
            calls += 1;
            return Effect.succeed(usable);
          },
        },
      ).pipe(Effect.flip);

      expect(Predicate.isTagged(failure, 'ReadHandlerNotFound')).toBe(true);
      expect(calls).toBe(0);
    }),
  );

  it.effect('preserves currentness corruption and owner outage without attempting compatibility', () =>
    Effect.gen(function* preserveUnavailableFailures() {
      const failures = [
        new PriceGroupCurrentnessFailure({
          candidateDefinitionRevisionIds: [definitionRevisionId],
          code: 'price_group_currentness_failure',
          priceGroupRef,
          reason: 'UNVERIFIABLE_CURRENTNESS',
        }),
        new PriceGroupPersistenceUnavailable({
          code: 'price_group_persistence_unavailable',
          reason: 'private database diagnostic',
          retryable: true,
        }),
      ] as const;

      for (const expectedFailure of failures) {
        let compatibilityCalls = 0;
        const failure = yield* validatePriceGroupCompatibilityFromServices(inputWithoutExpected, tenantId, {
          readCurrentDefinition: () => Effect.fail(expectedFailure),
          validateCompatibility: () => {
            compatibilityCalls += 1;
            return Effect.succeed(usable);
          },
        }).pipe(Effect.flip);
        expect(failure).toEqual(expectedFailure);
        expect(compatibilityCalls).toBe(0);
      }
    }),
  );

  it.effect('sanitizes owner failures that cannot be valid compatibility-read outcomes', () =>
    Effect.gen(function* sanitizeImpossibleOwnerFailure() {
      const failure = yield* validatePriceGroupCompatibilityFromServices(inputWithExpected, tenantId, {
        readCurrentDefinition: () => Effect.succeed(currentSnapshot),
        validateCompatibility: () =>
          Effect.fail(
            new PriceGroupLifecycleConflict({
              code: 'price_group_lifecycle_conflict',
              priceGroupRef,
              reason: 'private impossible owner state',
            }),
          ),
      }).pipe(Effect.flip);

      expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
      expect(JSON.stringify(failure)).not.toContain('private impossible owner state');
    }),
  );

  it('declares the forbidden Legal Entity scope and exact trusted-tenant permission target', () => {
    const scope: OperationalScope = {
      authMethod: 'system',
      correlationId: 'compatibility-read',
      principalId: '66666666-6666-4666-8666-666666666666',
      tenantId,
    };

    expect(validatePriceGroupCompatibilityRead.descriptor).toMatchObject({
      legalEntityScope: 'forbidden',
      permissionTarget: 'business_permission',
      readKey: 'pricing.price-group-catalog.api.validate-price-group-compatibility',
      schemaVersion: '1',
    });
    expect(getReadServiceFactory(validatePriceGroupCompatibilityRead).toString()).toContain(
      'priceGroupCatalogPersistenceForScope',
    );
    expect(validatePriceGroupCompatibilityPermissionTarget(inputWithoutExpected, scope)).toEqual({
      businessPermission: {
        permission: 'pricing.price_group.read',
        target: {
          kind: 'price_group',
          priceGroupId,
          pricingCatalogId: tenantId,
          tenantId,
        },
      },
      kind: 'business_permission',
    });
  });
});
