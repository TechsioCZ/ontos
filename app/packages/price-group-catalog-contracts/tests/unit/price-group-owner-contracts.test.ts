import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PriceGroupDefinitionResponseSchema } from '../../src/apis/price-group-definition.ts';
import {
  PriceGroupCreatedResultSchema,
  PriceGroupDefinitionAcceptanceSchema,
  PriceGroupDefinitionRevisionSchema,
  PriceGroupIdentitySchema,
} from '../../src/domain/price-group.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};
const initialRevisionId = '33333333-3333-4333-8333-333333333333';
const secondRevisionId = '44444444-4444-4444-8444-444444444444';
const meaningFingerprint = 'a'.repeat(64);
const provenance = {
  actionInvocationId: '66666666-6666-4666-8666-666666666666',
  actorPrincipalId: '77777777-7777-4777-8777-777777777777',
  reason: 'Approved owner decision.',
  trustedAt: '2026-09-23T12:00:00.000Z',
};
const requiredContract = { contractId: 'commerce.customer-price-group-assignment', version: 1 };
const initialDefinition = {
  acceptedCatalogRevision: 1,
  classificationPurpose: 'Classifies customers eligible for dealer pricing.',
  compatibilityContracts: [requiredContract],
  created: provenance,
  definitionRevisionId: initialRevisionId,
  description: 'Initial dealer classification.',
  displayName: 'Dealer',
  effectivePeriod: {
    effectiveFrom: '2026-10-01T00:00:00.000Z',
    effectiveTo: null,
  },
  meaningFingerprint,
  previousDefinitionRevisionId: null,
  priceGroupRef,
  revisionNumber: 1,
  semanticContinuity: null,
};
const identity = {
  businessCode: 'DEALER',
  created: provenance,
  createdAtCatalogRevision: 1,
  lifecycle: {
    activeFrom: '2026-10-01T00:00:00.000Z',
    retiredAt: null,
    state: 'ACTIVE' as const,
  },
  meaningFingerprint,
  priceGroupRef,
};
const currentEvidence = {
  catalogRevision: 1,
  definitionEffectivePeriod: initialDefinition.effectivePeriod,
  definitionRevisionId: initialRevisionId,
  definitionRevisionNumber: 1,
  meaningFingerprint,
  observedAt: '2026-10-01T00:00:00.000Z',
  priceGroupRef,
};

describe('Price Group owner semantic continuity', () => {
  it('keeps classification purpose off the stable identity contract', () => {
    expect(Schema.decodeSync(PriceGroupIdentitySchema)(identity)).toMatchObject({ meaningFingerprint, priceGroupRef });
    const legacyIdentity = {
      ...identity,
      classificationPurpose: initialDefinition.classificationPurpose,
    };
    expect(() => Schema.decodeSync(PriceGroupIdentitySchema, { onExcessProperty: 'error' })(legacyIdentity)).toThrow();
  });

  it('keeps purpose on immutable revisions and requires a structured SAME_MEANING decision thereafter', () => {
    expect(Schema.decodeSync(PriceGroupDefinitionRevisionSchema)(initialDefinition)).toMatchObject({
      meaningFingerprint,
      semanticContinuity: null,
    });

    const clarification = {
      ...initialDefinition,
      acceptedCatalogRevision: 2,
      classificationPurpose: 'Classifies approved resellers eligible for dealer pricing.',
      definitionRevisionId: secondRevisionId,
      previousDefinitionRevisionId: initialRevisionId,
      revisionNumber: 2,
      semanticContinuity: {
        comparedDefinitionRevisionId: initialRevisionId,
        decision: 'SAME_MEANING' as const,
        provenance,
      },
    };

    expect(Schema.decodeSync(PriceGroupDefinitionRevisionSchema)(clarification)).toMatchObject({
      classificationPurpose: clarification.classificationPurpose,
      meaningFingerprint,
      semanticContinuity: { decision: 'SAME_MEANING' },
    });
    expect(() =>
      Schema.decodeSync(PriceGroupDefinitionRevisionSchema)({
        ...clarification,
        semanticContinuity: {
          ...clarification.semanticContinuity,
          comparedDefinitionRevisionId: secondRevisionId,
        },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(PriceGroupDefinitionRevisionSchema)({ ...clarification, semanticContinuity: null }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(PriceGroupDefinitionRevisionSchema)({
        ...clarification,
        previousDefinitionRevisionId: secondRevisionId,
        semanticContinuity: {
          ...clarification.semanticContinuity,
          comparedDefinitionRevisionId: secondRevisionId,
        },
      }),
    ).toThrow();
  });
});

describe('Price Group owner lifecycle and create results', () => {
  it('rejects definition acceptance recorded after its effective start', () => {
    expect(() =>
      Schema.decodeSync(PriceGroupDefinitionAcceptanceSchema)({
        acceptedCatalogRevision: 1,
        definitionEffectivePeriod: {
          effectiveFrom: '2026-09-23T11:59:59.999Z',
          effectiveTo: null,
        },
        definitionRevisionId: initialRevisionId,
        definitionRevisionNumber: 1,
        meaningFingerprint,
        priceGroupRef,
        provenance,
      }),
    ).toThrow();
  });

  it('exposes accepted scheduled retirement while lifecycle stays ACTIVE before its effective instant', () => {
    const scheduledRetirement = {
      acceptedCatalogRevision: 2,
      currentDefinitionRevisionId: secondRevisionId,
      currentDefinitionRevisionNumber: 2,
      priceGroupRef,
      retirementEffectiveAt: '2027-01-01T00:00:00.000Z',
      retirementProvenance: provenance,
      trustedOperationAt: provenance.trustedAt,
      verifiedAt: '2026-09-23T12:00:01.000Z',
    };
    const response = {
      currentEvidence: {
        ...currentEvidence,
        definitionEffectivePeriod: {
          ...currentEvidence.definitionEffectivePeriod,
          effectiveTo: scheduledRetirement.retirementEffectiveAt,
        },
        observedAt: '2026-12-01T00:00:00.000Z',
      },
      definition: {
        ...initialDefinition,
        effectivePeriod: {
          ...initialDefinition.effectivePeriod,
          effectiveTo: scheduledRetirement.retirementEffectiveAt,
        },
      },
      identity,
      observedAt: '2026-12-01T00:00:01.000Z',
      scheduledRetirement,
      selection: 'CURRENT' as const,
    };

    expect(Schema.decodeSync(PriceGroupDefinitionResponseSchema)(response)).toMatchObject({
      identity: { lifecycle: { state: 'ACTIVE' } },
      scheduledRetirement: { retirementEffectiveAt: '2027-01-01T00:00:00.000Z' },
    });
    expect(
      Schema.decodeSync(PriceGroupDefinitionResponseSchema)({
        ...response,
        scheduledRetirement: {
          ...scheduledRetirement,
          currentDefinitionRevisionId: initialRevisionId,
          currentDefinitionRevisionNumber: 1,
        },
      }),
    ).toMatchObject({ scheduledRetirement: { currentDefinitionRevisionId: initialRevisionId } });
    expect(() =>
      Schema.decodeSync(PriceGroupDefinitionResponseSchema)({
        ...response,
        scheduledRetirement: {
          ...scheduledRetirement,
          priceGroupRef: { ...priceGroupRef, resourceId: '99999999-9999-4999-8999-999999999999' },
        },
      }),
    ).toThrow();
  });

  it('returns only stable identity, initial definition, and accepted owner evidence from create', () => {
    const result = {
      acceptance: {
        acceptedCatalogRevision: 1,
        definitionEffectivePeriod: initialDefinition.effectivePeriod,
        definitionRevisionId: initialRevisionId,
        definitionRevisionNumber: 1,
        meaningFingerprint,
        priceGroupRef,
        provenance,
      },
      identity,
      initialDefinition,
    };

    expect(Schema.decodeSync(PriceGroupCreatedResultSchema)(result)).toMatchObject({
      identity: { meaningFingerprint, priceGroupRef },
      initialDefinition: { definitionRevisionId: initialRevisionId },
    });
    const leakedInfrastructureResult = {
      ...result,
      outcome: 'RECONCILIATION_REQUIRED',
      reconciliation: { mutationId: '88888888-8888-4888-8888-888888888888' },
    };
    expect(() =>
      Schema.decodeSync(PriceGroupCreatedResultSchema, { onExcessProperty: 'error' })(leakedInfrastructureResult),
    ).toThrow();

    const backdatedPeriod = {
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      effectiveTo: null,
    };
    expect(() =>
      Schema.decodeSync(PriceGroupCreatedResultSchema)({
        ...result,
        acceptance: { ...result.acceptance, definitionEffectivePeriod: backdatedPeriod },
        identity: {
          ...result.identity,
          lifecycle: { ...result.identity.lifecycle, activeFrom: backdatedPeriod.effectiveFrom },
        },
        initialDefinition: { ...result.initialDefinition, effectivePeriod: backdatedPeriod },
      }),
    ).toThrow();
  });
});
