import type {
  PriceGroupAssignmentResolutionResponse,
  PriceGroupInterpretation,
  PriceGroupInterpretationInput,
} from '@app/pricing-contracts/domain/price-group-interpretation';
import type { PriceGroupCompatibilityDecision } from '@app/price-group-catalog-contracts/price-group';
import type { ValidatePriceGroupCompatibilityRequest } from '@app/price-group-catalog-contracts/validate-price-group-compatibility';
import { Effect, Match } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  makePriceGroupInterpretationService,
  PriceGroupInterpretationDependencyFailure,
} from '../../src/services/price-group-interpretation.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '99999999-9999-4999-8999-999999999999';
const effectiveAt = '2026-03-01T00:00:00.000Z';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const basis = {
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: '22222222-2222-4222-8222-222222222222',
      resourceType: 'commerce.catalog.product',
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: '33333333-3333-4333-8333-333333333333',
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
  },
  commercialScope: {
    channelId: 'B2C',
    marketId: 'cz-launch',
    sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  currencyCode: 'CZK',
  unitBasis: {
    quantity: '1',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: '44444444-4444-4444-8444-444444444444',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
} as const;
const compatibilityEvidence = {
  catalogRevision: 7,
  definitionEffectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
  definitionRevisionId: '55555555-5555-4555-8555-555555555555',
  definitionRevisionNumber: 4,
  meaningFingerprint: 'a'.repeat(64),
  priceGroupRef,
  requiredContract: { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
  trustedOperationAt: effectiveAt,
  verifiedAt: '2026-03-01T00:00:01.000Z',
} as const;
const assignedResolution = {
  _tag: 'ASSIGNED',
  assignmentRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '88888888-8888-4888-8888-888888888888',
    resourceType: 'commerce.customer-context.customer-price-group-assignment',
    tenantId,
  },
  assignmentRevision: 3,
  compatibility: compatibilityEvidence,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  priceGroupRef,
} as const;
const profileInput = {
  assignmentRequest: { authorizationSubject: { kind: 'RETAIL' }, effectiveAt, profile },
  basis,
} as const satisfies PriceGroupInterpretationInput;

const ownerResponse = (
  resolution: PriceGroupAssignmentResolutionResponse['resolution'],
  overrides: Partial<PriceGroupAssignmentResolutionResponse> = {},
): PriceGroupAssignmentResolutionResponse => ({ effectiveAt, profile, resolution, ...overrides });

const usableDecision: PriceGroupCompatibilityDecision = { evidence: compatibilityEvidence, kind: 'USABLE' };

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

const requireUnverifiable = (result: PriceGroupInterpretation) =>
  Match.value(result).pipe(
    Match.tag('UNVERIFIABLE', (value) => value),
    Match.orElse(() => {
      throw new Error('fixture must resolve as UNVERIFIABLE');
    }),
  );

describe('Issue #761 Price Group interpretation runtime acceptance', () => {
  it.effect('uses usable owner-issued ASSIGNED(G) without amount-based reclassification', () =>
    Effect.gen(function* interpretAssigned() {
      const compatibilityRequests: ValidatePriceGroupCompatibilityRequest[] = [];
      const service = makePriceGroupInterpretationService({
        commerce: { resolve: () => Effect.succeed(ownerResponse(assignedResolution)) },
        compatibility: {
          validate: (request) => {
            compatibilityRequests.push(request);
            return Effect.succeed(usableDecision);
          },
        },
      });

      const assigned = requireAssigned(yield* service.interpret(profileInput));
      expect(assigned.basis).toEqual(basis);
      expect(assigned.priceSelector).toEqual({ kind: 'PRICE_GROUP', priceGroupRef });
      expect(assigned.discountAudience).toEqual({ kind: 'PRICE_GROUP', priceGroupRef });
      expect(assigned.compatibilityEvidence).toEqual(compatibilityEvidence);
      expect(compatibilityRequests).toHaveLength(1);
      const [compatibilityRequest] = compatibilityRequests;
      if (compatibilityRequest === undefined) {
        throw new Error('compatibility validation request must be captured');
      }
      expect(compatibilityRequest).toEqual({
        expectedCurrent: {
          catalogRevision: 7,
          definitionRevisionId: compatibilityEvidence.definitionRevisionId,
          definitionRevisionNumber: 4,
          meaningFingerprint: compatibilityEvidence.meaningFingerprint,
          priceGroupRef,
        },
        priceGroupRef,
        requiredContract: compatibilityEvidence.requiredContract,
        trustedOperationAt: effectiveAt,
      });
      expect('amount' in compatibilityRequest).toBe(false);
    }),
  );

  it.effect('uses legitimate NONE and Guest/no-profile without inventing or validating a Group', () =>
    Effect.gen(function* interpretNoGroup() {
      let commerceCalls = 0;
      let compatibilityCalls = 0;
      const service = makePriceGroupInterpretationService({
        commerce: {
          resolve: () => {
            commerceCalls += 1;
            return Effect.succeed(ownerResponse({ _tag: 'NONE' }));
          },
        },
        compatibility: {
          validate: () => {
            compatibilityCalls += 1;
            return Effect.succeed(usableDecision);
          },
        },
      });

      const none = requireNone(yield* service.interpret(profileInput));
      expect(none.priceSelector).toEqual({ kind: 'NO_GROUP' });
      expect(none.discountAudience).toEqual({ kind: 'NONE' });
      expect(commerceCalls).toBe(1);
      expect(compatibilityCalls).toBe(0);

      const guest = requireNone(yield* service.interpret({ assignmentRequest: { kind: 'GUEST' }, basis }));
      expect(guest.priceSelector).toEqual({ kind: 'NO_GROUP' });
      expect(commerceCalls).toBe(1);
      expect(compatibilityCalls).toBe(0);
    }),
  );

  it.effect('keeps BROKEN and INCONSISTENT owner outcomes selector-free', () =>
    Effect.gen(function* interpretBrokenOwnerState() {
      for (const resolution of [
        {
          _tag: 'BROKEN' as const,
          assignmentRef: assignedResolution.assignmentRef,
          assignmentRevision: 3,
          catalogRevision: 7,
          priceGroupRef,
          reason: 'INCOMPATIBLE' as const,
        },
        { _tag: 'INCONSISTENT' as const, currentAssignmentCount: 2 },
      ]) {
        const service = makePriceGroupInterpretationService({
          commerce: { resolve: () => Effect.succeed(ownerResponse(resolution)) },
          compatibility: { validate: () => Effect.die('compatibility must not run') },
        });
        const result = yield* service.interpret(profileInput);
        expect('priceSelector' in result).toBe(false);
        expect('discountAudience' in result).toBe(false);
      }
    }),
  );

  it.effect('preserves unavailable and unverifiable dependency states without fallback', () =>
    Effect.gen(function* interpretDependencyFailures() {
      for (const kind of ['UNAVAILABLE', 'UNVERIFIABLE'] as const) {
        const service = makePriceGroupInterpretationService({
          commerce: {
            resolve: () =>
              Effect.fail(
                new PriceGroupInterpretationDependencyFailure({
                  kind,
                  owner: 'COMMERCE_ASSIGNMENT',
                  reason: 'owner evidence unavailable',
                }),
              ),
          },
          compatibility: { validate: () => Effect.die('compatibility must not run') },
        });
        const result = yield* service.interpret(profileInput);
        expect('priceSelector' in result).toBe(false);
        expect('discountAudience' in result).toBe(false);
      }
    }),
  );

  it.effect('fails exact Tenant, profile, time, and compatibility evidence mismatches closed', () =>
    Effect.gen(function* rejectUnboundEvidence() {
      const mismatchedProfile = { ...profile, resourceId: '99999999-9999-4999-8999-999999999998' };
      const cases: readonly {
        readonly decision?: PriceGroupCompatibilityDecision;
        readonly response: PriceGroupAssignmentResolutionResponse;
      }[] = [
        { response: ownerResponse(assignedResolution, { profile: mismatchedProfile }) },
        {
          response: ownerResponse(assignedResolution, {
            profile: { ...profile, tenantId: foreignTenantId },
          }),
        },
        { response: ownerResponse(assignedResolution, { effectiveAt: '2026-04-01T00:00:00.000Z' }) },
        {
          decision: {
            evidence: { ...compatibilityEvidence, definitionRevisionNumber: 5 },
            kind: 'USABLE',
          },
          response: ownerResponse(assignedResolution),
        },
      ];

      for (const testCase of cases) {
        const service = makePriceGroupInterpretationService({
          commerce: { resolve: () => Effect.succeed(testCase.response) },
          compatibility: { validate: () => Effect.succeed(testCase.decision ?? usableDecision) },
        });
        const result = requireUnverifiable(yield* service.interpret(profileInput));
        expect('priceSelector' in result).toBe(false);
        expect('discountAudience' in result).toBe(false);
      }
    }),
  );
});
