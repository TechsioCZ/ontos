import { describe, expect, it } from 'effect-rstest';
import { Result, Schema } from 'effect';

import { getActionBusinessPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { PriceGroupActionCommittedRetryReceiptSchema } from '../../shared/domain/action-committed-retry-receipt.ts';
import { CreatePriceGroupDefinitionRevisionPayloadSchema } from '../../shared/actions/create-price-group-definition-revision.ts';
import {
  CreatePriceGroupPayloadSchema,
  CreatePriceGroupResultSchema,
} from '../../shared/actions/create-price-group.ts';
import {
  RetirePriceGroupPayloadSchema,
  RetirePriceGroupResultSchema,
} from '../../shared/actions/retire-price-group.ts';
import { OutboxPayloadSchema as DefinitionRevisionCreatedOutboxPayloadSchema } from '../../shared/outbox/pricing-price-group-definition-revision-created.ts';
import {
  OutboxPayloadSchema as PriceGroupCreatedOutboxPayloadSchema,
  outboxTopic as priceGroupCreatedOutboxTopic,
} from '../../shared/outbox/pricing-price-group-created.ts';
import { OutboxPayloadSchema as PriceGroupContainmentProjectionRequestedOutboxPayloadSchema } from '../../shared/outbox/pricing-price-group-containment-projection-requested.ts';
import { OutboxPayloadSchema as PriceGroupRetirementAcceptedOutboxPayloadSchema } from '../../shared/outbox/pricing-price-group-retirement-accepted.ts';
import { pricingPriceGroupCreatePermission } from '../../shared/permissions/pricing-price-group-create.ts';
import { pricingPriceGroupRetirePermission } from '../../shared/permissions/pricing-price-group-retire.ts';
import { pricingPriceGroupRevisionCreatePermission } from '../../shared/permissions/pricing-price-group-revision-create.ts';
import { createPriceGroupDefinitionRevisionAction } from '../../src/actions/create-price-group-definition-revision.action.ts';
import { createPriceGroupAction } from '../../src/actions/create-price-group.action.ts';
import { retirePriceGroupAction } from '../../src/actions/retire-price-group.action.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};
const definitionRevisionId = '44444444-4444-4444-8444-444444444444';
const compatibilityContracts = [{ contractId: 'commerce.customer-price-group-assignment', version: 1 }];
const meaningFingerprint = 'a'.repeat(64);
const trustedOperationAt = '2026-09-23T12:00:00.000Z';
const expectedCurrent = {
  catalogRevision: 7,
  definitionRevisionId,
  definitionRevisionNumber: 1,
  meaningFingerprint,
  priceGroupRef,
};
const createPayload = {
  businessCode: 'DEALER',
  classificationPurpose: 'Classifies approved resellers for the dealer pricing path.',
  compatibilityContracts,
  description: 'Dealer classification for approved resellers.',
  displayName: 'Dealer',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  expectedCatalogRevision: 0,
  reason: 'Create the approved dealer classification.',
};
const revisionPayload = {
  classificationPurpose: createPayload.classificationPurpose,
  compatibilityContracts,
  description: 'Clarified dealer classification for approved resellers.',
  displayName: createPayload.displayName,
  effectiveFrom: '2026-11-01T00:00:00.000Z',
  effectiveTo: null,
  expectedCurrent,
  reason: 'Clarify the existing classification without changing its meaning.',
  semanticDecision: {
    comparedDefinitionRevisionId: expectedCurrent.definitionRevisionId,
    decision: 'SAME_MEANING' as const,
  },
};
const retirementPayload = {
  effectiveAt: '2026-12-01T00:00:00.000Z',
  expectedCurrent,
  reason: 'Retire the classification from future use.',
};
const scope = {
  authMethod: 'system' as const,
  correlationId: 'price-group-management-contracts',
  principalId,
  tenantId,
};

describe('Price Group management Action contracts', () => {
  it('defines a transport-only successful receipt for an exact committed retry', () => {
    expect(
      Schema.decodeUnknownSync(PriceGroupActionCommittedRetryReceiptSchema)({
        invocationId: '55555555-5555-4555-8555-555555555555',
        replay: 'already_committed',
      }),
    ).toEqual({
      invocationId: '55555555-5555-4555-8555-555555555555',
      replay: 'already_committed',
    });
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(PriceGroupActionCommittedRetryReceiptSchema)({
          invocationId: 'not-an-action-invocation-id',
          replay: 'already_committed',
        }),
      ),
    ).toBe(true);
  });

  it('requires explicit creation, same-meaning revision, and expected-current retirement intent', () => {
    expect(Schema.is(CreatePriceGroupPayloadSchema)(createPayload)).toBe(true);
    expect(Schema.is(CreatePriceGroupPayloadSchema)({ ...createPayload, compatibilityContracts: [] })).toBe(false);
    expect(
      Schema.is(CreatePriceGroupPayloadSchema)({
        ...createPayload,
        compatibilityContracts: [...compatibilityContracts, ...compatibilityContracts],
      }),
    ).toBe(false);
    expect(
      Schema.is(CreatePriceGroupPayloadSchema)({ ...createPayload, effectiveTo: createPayload.effectiveFrom }),
    ).toBe(false);
    expect(
      Schema.is(CreatePriceGroupPayloadSchema)({ ...createPayload, effectiveTo: '2026-09-30T23:59:59.999Z' }),
    ).toBe(false);
    expect(Schema.is(CreatePriceGroupDefinitionRevisionPayloadSchema)(revisionPayload)).toBe(true);
    expect(
      Schema.is(CreatePriceGroupDefinitionRevisionPayloadSchema)({
        ...revisionPayload,
        compatibilityContracts: [...compatibilityContracts, ...compatibilityContracts],
      }),
    ).toBe(false);
    expect(
      Schema.is(CreatePriceGroupDefinitionRevisionPayloadSchema)({
        ...revisionPayload,
        effectiveTo: revisionPayload.effectiveFrom,
      }),
    ).toBe(false);
    expect(
      Schema.is(CreatePriceGroupDefinitionRevisionPayloadSchema)({
        ...revisionPayload,
        effectiveTo: '2026-10-31T23:59:59.999Z',
      }),
    ).toBe(false);
    expect(
      Schema.is(CreatePriceGroupDefinitionRevisionPayloadSchema)({
        ...revisionPayload,
        semanticDecision: {
          ...revisionPayload.semanticDecision,
          comparedDefinitionRevisionId: '77777777-7777-4777-8777-777777777777',
        },
      }),
    ).toBe(false);
    expect(Schema.is(RetirePriceGroupPayloadSchema)(retirementPayload)).toBe(true);
  });

  it('declares tenant-only Action execution with required idempotency', () => {
    for (const action of [createPriceGroupAction, createPriceGroupDefinitionRevisionAction, retirePriceGroupAction]) {
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.legalEntityScope).toBe('forbidden');
      expect(action.descriptor.entrypoint.scope).toBe('tenant');
    }
  });

  it('resolves the exact catalog or stable Price Group business permission target', () => {
    expect(getActionBusinessPermissionTargetResolver(createPriceGroupAction)?.(createPayload, scope)).toEqual({
      permission: 'pricing.price_group.create',
      target: { kind: 'pricing_catalog', pricingCatalogId: tenantId, tenantId },
    });
    expect(
      getActionBusinessPermissionTargetResolver(createPriceGroupDefinitionRevisionAction)?.(revisionPayload, scope),
    ).toEqual({
      permission: 'pricing.price_group.revision.create',
      target: {
        kind: 'price_group',
        priceGroupId: priceGroupRef.resourceId,
        pricingCatalogId: tenantId,
        tenantId,
      },
    });
    expect(getActionBusinessPermissionTargetResolver(retirePriceGroupAction)?.(retirementPayload, scope)).toEqual({
      permission: 'pricing.price_group.retire',
      target: {
        kind: 'price_group',
        priceGroupId: priceGroupRef.resourceId,
        pricingCatalogId: tenantId,
        tenantId,
      },
    });

    const foreignTenantId = '77777777-7777-4777-8777-777777777777';
    const foreignExpectedCurrent = {
      ...expectedCurrent,
      priceGroupRef: { ...priceGroupRef, tenantId: foreignTenantId },
    };
    expect(
      getActionBusinessPermissionTargetResolver(createPriceGroupDefinitionRevisionAction)?.(
        { ...revisionPayload, expectedCurrent: foreignExpectedCurrent },
        scope,
      ),
    ).toMatchObject({
      target: { pricingCatalogId: foreignTenantId, tenantId: foreignTenantId },
    });
  });

  it('registers every permission against its exact protected Action entrypoint', () => {
    expect(pricingPriceGroupCreatePermission.protectedEntrypoints).toEqual([
      'pricing.price-group-catalog.create-price-group',
    ]);
    expect(pricingPriceGroupRevisionCreatePermission.protectedEntrypoints).toEqual([
      'pricing.price-group-catalog.create-price-group-definition-revision',
    ]);
    expect(pricingPriceGroupRevisionCreatePermission.allowedScopeKinds).toEqual(['pricing_catalog', 'price_group']);
    expect(pricingPriceGroupRetirePermission.protectedEntrypoints).toEqual([
      'pricing.price-group-catalog.retire-price-group',
    ]);
    expect(pricingPriceGroupRetirePermission.allowedScopeKinds).toEqual(['pricing_catalog', 'price_group']);
  });

  it('publishes exact owner facts instead of generic JSON envelopes', () => {
    const definition = {
      acceptedCatalogRevision: 1,
      classificationPurpose: createPayload.classificationPurpose,
      compatibilityContracts,
      created: {
        actionInvocationId: '55555555-5555-4555-8555-555555555555',
        actorPrincipalId: principalId,
        reason: createPayload.reason,
        trustedAt: trustedOperationAt,
      },
      definitionRevisionId,
      description: createPayload.description,
      displayName: createPayload.displayName,
      effectivePeriod: { effectiveFrom: createPayload.effectiveFrom, effectiveTo: null },
      meaningFingerprint,
      previousDefinitionRevisionId: null,
      priceGroupRef,
      revisionNumber: 1,
      semanticContinuity: null,
    };
    const retirementAcceptance = {
      acceptedCatalogRevision: 8,
      currentDefinitionRevisionId: definitionRevisionId,
      currentDefinitionRevisionNumber: 1,
      priceGroupRef,
      retirementEffectiveAt: retirementPayload.effectiveAt,
      retirementProvenance: {
        actionInvocationId: '66666666-6666-4666-8666-666666666666',
        actorPrincipalId: principalId,
        reason: retirementPayload.reason,
        trustedAt: trustedOperationAt,
      },
      trustedOperationAt,
      verifiedAt: trustedOperationAt,
    };
    const containmentProjectionRequest = {
      catalogVersion: '1',
      mutationId: '77777777-7777-4777-8777-777777777777',
      operation: 'touch_containment',
      priceGroupRef,
      pricingCatalogRef: {
        moduleId: 'pricing.price-group-catalog',
        resourceId: tenantId,
        resourceType: 'pricing.price-group-catalog.price-group-catalog-root',
        tenantId,
      },
      schemaVersion: '1',
    };
    const creationAcceptance = {
      acceptance: {
        acceptedCatalogRevision: definition.acceptedCatalogRevision,
        definitionEffectivePeriod: definition.effectivePeriod,
        definitionRevisionId: definition.definitionRevisionId,
        definitionRevisionNumber: definition.revisionNumber,
        meaningFingerprint,
        priceGroupRef,
        provenance: definition.created,
      },
      identity: {
        businessCode: createPayload.businessCode,
        created: definition.created,
        createdAtCatalogRevision: definition.acceptedCatalogRevision,
        lifecycle: {
          activeFrom: definition.effectivePeriod.effectiveFrom,
          retiredAt: null,
          state: 'ACTIVE',
        },
        meaningFingerprint,
        priceGroupRef,
      },
      initialDefinition: definition,
    };

    expect(Schema.is(CreatePriceGroupResultSchema)(creationAcceptance)).toBe(true);
    expect(Schema.is(PriceGroupContainmentProjectionRequestedOutboxPayloadSchema)(containmentProjectionRequest)).toBe(
      true,
    );
    expect(Schema.is(PriceGroupCreatedOutboxPayloadSchema)(definition)).toBe(true);
    expect(Schema.is(PriceGroupCreatedOutboxPayloadSchema)(creationAcceptance)).toBe(false);
    expect(priceGroupCreatedOutboxTopic).toBe('pricing.price-group.created');
    expect(Schema.is(DefinitionRevisionCreatedOutboxPayloadSchema)(definition)).toBe(true);
    expect(Schema.is(RetirePriceGroupResultSchema)(retirementAcceptance)).toBe(true);
    expect(Schema.is(PriceGroupRetirementAcceptedOutboxPayloadSchema)(retirementAcceptance)).toBe(true);
    const backdatedRetirementAcceptance = {
      ...retirementAcceptance,
      retirementEffectiveAt: '2026-09-22T23:59:59.999Z',
    };
    expect(Schema.is(RetirePriceGroupResultSchema)(backdatedRetirementAcceptance)).toBe(false);
    expect(Schema.is(PriceGroupRetirementAcceptedOutboxPayloadSchema)(backdatedRetirementAcceptance)).toBe(false);
    expect(Schema.is(PriceGroupCreatedOutboxPayloadSchema)({ data: definition })).toBe(false);
  });
});
