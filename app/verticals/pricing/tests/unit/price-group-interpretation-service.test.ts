import type {
  PriceGroupAssignmentResolutionResponse,
  PriceGroupInterpretation,
  PriceGroupInterpretationInput,
} from '@app/pricing-contracts/domain/price-group-interpretation';
import type { PriceGroupCompatibilityDecision } from '@app/price-group-catalog-contracts';
import { Effect, Match } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PriceGroupInterpretationDependencyFailure,
  makePriceGroupInterpretationService,
} from '../../src/services/price-group-interpretation.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const effectiveAt = '2026-09-27T10:00:00.000Z';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: '40000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const compatibility = {
  catalogRevision: 7,
  definitionEffectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
  definitionRevisionId: '50000000-0000-4000-8000-000000000001',
  definitionRevisionNumber: 3,
  meaningFingerprint: 'a'.repeat(64),
  priceGroupRef,
  requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
  trustedOperationAt: effectiveAt,
  verifiedAt: '2026-09-27T10:00:01.000Z',
} as const;
const basis = {
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: '60000000-0000-4000-8000-000000000001',
      resourceType: 'commerce.catalog.product',
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: '70000000-0000-4000-8000-000000000001',
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
  },
  commercialScope: {
    channelId: 'B2B',
    marketId: 'CZ',
    sellingLegalEntityId: '80000000-0000-4000-8000-000000000001',
  },
  currencyCode: 'CZK',
  unitBasis: {
    quantity: '1',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: '90000000-0000-4000-8000-000000000001',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
} as const;
const profileInput: PriceGroupInterpretationInput = {
  assignmentRequest: { authorizationSubject: { kind: 'RETAIL' }, effectiveAt, profile },
  basis,
};
const assignmentRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'a0000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.customer-price-group-assignment',
  tenantId,
} as const;
const assignmentResponse: PriceGroupAssignmentResolutionResponse = {
  effectiveAt,
  profile,
  resolution: {
    _tag: 'ASSIGNED',
    assignmentRef,
    assignmentRevision: 2,
    compatibility,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    priceGroupRef,
  },
};

const serviceWith = (
  response: PriceGroupAssignmentResolutionResponse = assignmentResponse,
  decision?: PriceGroupCompatibilityDecision,
) => {
  const compatibilityDecision = decision ?? { evidence: compatibility, kind: 'USABLE' as const };
  return makePriceGroupInterpretationService({
    commerce: { resolve: () => Effect.succeed(response) },
    compatibility: { validate: () => Effect.succeed(compatibilityDecision) },
  });
};

const requireAssigned = (result: PriceGroupInterpretation) =>
  Match.value(result).pipe(
    Match.tag('ASSIGNED', (value) => value),
    Match.orElse(() => {
      throw new Error('fixture must resolve as ASSIGNED');
    }),
  );
const requireNone = (result: PriceGroupInterpretation) =>
  Match.value(result).pipe(
    Match.tag('NONE', (value) => value),
    Match.orElse(() => {
      throw new Error('fixture must resolve as NONE');
    }),
  );
const requireBroken = (result: PriceGroupInterpretation) =>
  Match.value(result).pipe(
    Match.tag('BROKEN', (value) => value),
    Match.orElse(() => {
      throw new Error('fixture must resolve as BROKEN');
    }),
  );
const requireUnavailable = (result: PriceGroupInterpretation) =>
  Match.value(result).pipe(
    Match.tag('UNAVAILABLE', (value) => value),
    Match.orElse(() => {
      throw new Error('fixture must resolve as UNAVAILABLE');
    }),
  );
const requireUnverifiable = (result: PriceGroupInterpretation) =>
  Match.value(result).pipe(
    Match.tag('UNVERIFIABLE', (value) => value),
    Match.orElse(() => {
      throw new Error('fixture must resolve as UNVERIFIABLE');
    }),
  );

describe('Price Group interpretation service', () => {
  it.effect('uses legitimate Guest absence without calling either owner', () =>
    Effect.gen(function* guestAbsence() {
      let calls = 0;
      const service = makePriceGroupInterpretationService({
        commerce: {
          resolve: () => {
            calls += 1;
            return Effect.succeed(assignmentResponse);
          },
        },
        compatibility: {
          validate: () => {
            calls += 1;
            return Effect.succeed({ evidence: compatibility, kind: 'USABLE' });
          },
        },
      });

      const result = yield* service.interpret({ assignmentRequest: { kind: 'GUEST' }, basis });

      expect(requireNone(result)).toMatchObject({
        assignmentResolution: { _tag: 'NONE' },
        discountAudience: { kind: 'NONE' },
        priceSelector: { kind: 'NO_GROUP' },
      });
      expect(calls).toBe(0);
    }),
  );

  it.effect('fails malformed Guest-like and mismatched explicit-profile requests closed', () =>
    Effect.gen(function* invalidAssignmentRequests() {
      let calls = 0;
      const service = makePriceGroupInterpretationService({
        commerce: {
          resolve: () => {
            calls += 1;
            return Effect.succeed(assignmentResponse);
          },
        },
        compatibility: {
          validate: () => {
            calls += 1;
            return Effect.succeed({ evidence: compatibility, kind: 'USABLE' });
          },
        },
      });
      const malformedRequests = [
        { kind: 'GUEST', profile },
        {
          authorizationSubject: {
            counterpartyRef: {
              moduleId: 'party.registry',
              resourceId: 'd0000000-0000-4000-8000-000000000001',
              resourceType: 'party.registry.counterparty',
              tenantId,
            },
            kind: 'COUNTERPARTY',
          },
          profile,
        },
      ];

      for (const assignmentRequest of malformedRequests) {
        const result = yield* service.interpret({
          assignmentRequest,
          basis,
        });
        expect(requireUnverifiable(result)).toMatchObject({
          owner: 'COMMERCE_ASSIGNMENT',
          reason: 'DEPENDENCY_EVIDENCE_UNVERIFIABLE',
        });
      }
      expect(calls).toBe(0);
    }),
  );

  it.effect('returns one usable assigned Group while preserving an independent Discount audience', () =>
    Effect.gen(function* assignedGroup() {
      const result = yield* serviceWith().interpret(profileInput);

      expect(requireAssigned(result)).toMatchObject({
        basis,
        discountAudience: { kind: 'PRICE_GROUP', priceGroupRef },
        priceGroupRef,
        priceSelector: { kind: 'PRICE_GROUP', priceGroupRef },
      });
    }),
  );

  it.effect('keeps owner-proven broken assignment and incompatible currentness distinct', () =>
    Effect.gen(function* brokenInterpretations() {
      const commerceBroken = yield* serviceWith({
        ...assignmentResponse,
        resolution: {
          _tag: 'BROKEN',
          assignmentRef,
          assignmentRevision: 2,
          catalogRevision: 8,
          priceGroupRef,
          reason: 'RETIRED',
        },
      }).interpret(profileInput);
      const compatibilityBroken = yield* serviceWith(assignmentResponse, {
        evidence: {
          acceptedCatalogRevision: 8,
          currentDefinitionRevisionId: compatibility.definitionRevisionId,
          currentDefinitionRevisionNumber: compatibility.definitionRevisionNumber,
          priceGroupRef,
          retiredAt: effectiveAt,
          retirementProvenance: {
            actionInvocationId: 'b0000000-0000-4000-8000-000000000001',
            actorPrincipalId: 'c0000000-0000-4000-8000-000000000001',
            reason: 'retired',
            trustedAt: effectiveAt,
          },
          trustedOperationAt: effectiveAt,
          verifiedAt: '2026-09-27T10:00:02.000Z',
        },
        kind: 'RETIRED',
      }).interpret(profileInput);

      expect(requireBroken(commerceBroken)).toMatchObject({
        reason: 'RETIRED',
        source: 'COMMERCE_ASSIGNMENT',
      });
      expect(requireBroken(compatibilityBroken)).toMatchObject({
        reason: 'RETIRED',
        source: 'PRICE_GROUP_COMPATIBILITY',
      });
    }),
  );

  it.effect('does not collapse unavailable dependencies or unverifiable evidence into absence', () =>
    Effect.gen(function* dependencyFailures() {
      const unavailableService = makePriceGroupInterpretationService({
        commerce: {
          resolve: () =>
            Effect.fail(
              new PriceGroupInterpretationDependencyFailure({
                kind: 'UNAVAILABLE',
                owner: 'COMMERCE_ASSIGNMENT',
                reason: 'owner timed out',
              }),
            ),
        },
        compatibility: { validate: () => Effect.succeed({ evidence: compatibility, kind: 'USABLE' }) },
      });
      const unavailable = yield* unavailableService.interpret(profileInput);
      const unverifiable = yield* serviceWith(assignmentResponse, {
        evidence: { ...compatibility, meaningFingerprint: 'b'.repeat(64) },
        kind: 'USABLE',
      }).interpret(profileInput);

      expect(requireUnavailable(unavailable)).toMatchObject({ owner: 'COMMERCE_ASSIGNMENT' });
      expect(requireUnverifiable(unverifiable)).toMatchObject({
        owner: 'PRICE_GROUP_COMPATIBILITY',
        reason: 'COMPATIBILITY_EVIDENCE_MISMATCH',
      });
    }),
  );
});
