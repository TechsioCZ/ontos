import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { getActionResourcePermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';
import {
  EligibleMarketTuplesRequestSchema as PublishedEligibleMarketTuplesRequestSchema,
  ResolveCommerceMarketResponseSchema as PublishedResolveCommerceMarketResponseSchema,
  commerceMarketCatalogClient as publishedCommerceMarketCatalogClient,
  executeCurrentMarketCatalog,
  executeEligibleMarketTuples,
  executeMarketHistory,
  executeResolveCommerceMarket,
  getCommerceMarketCatalogReadiness,
} from '@app/commerce-market-catalog/api/client';

import {
  EffectivePeriodSchema,
  EligibleMarketTupleSetSchema,
  MarketDefinitionSchema,
  MarketResolutionOutcomeSchema,
  StorefrontAssociationDefinitionSchema,
} from '../../shared/market-contracts.ts';
import {
  EligibleMarketTuplesRequestSchema,
  EligibleMarketTuplesResponseSchema,
} from '../../shared/apis/eligible-market-tuples.ts';
import {
  ResolveCommerceMarketRequestSchema,
  ResolveCommerceMarketResponseSchema,
} from '../../shared/apis/resolve-commerce-market.ts';
import { OutboxPayloadSchema as MarketCreatedOutboxPayloadSchema } from '../../shared/outbox/commerce-market-catalog-market-created-v1.ts';
import { OutboxPayloadSchema as AssociationCreatedOutboxPayloadSchema } from '../../shared/outbox/commerce-market-catalog-storefront-associated-v1.ts';
import { OutboxPayloadSchema as AssociationRemovedOutboxPayloadSchema } from '../../shared/outbox/commerce-market-catalog-storefront-association-removed-v1.ts';
import { OutboxPayloadSchema as AssociationRevisedOutboxPayloadSchema } from '../../shared/outbox/commerce-market-catalog-storefront-association-revised-v1.ts';
import { MarketRefSchema } from '../../shared/resources/market.ts';
import { commerceMarketCatalogManifest } from '../../vertical.manifest.ts';
import { commerceMarketCatalogRegistration } from '../../vertical.registration.ts';
import {
  AssociateStorefrontPayloadSchema,
  associateStorefrontAction,
} from '../../src/actions/associate-storefront.action.ts';
import { activateMarketAction } from '../../src/actions/activate-market.action.ts';
import { CreateMarketPayloadSchema, createMarketAction } from '../../src/actions/create-market.action.ts';
import { StorefrontAssociationResultSchema } from '../../shared/action-contracts.ts';
import {
  RemoveStorefrontAssociationPayloadSchema,
  removeStorefrontAssociationAction,
} from '../../src/actions/remove-storefront-association.action.ts';
import { retireMarketAction } from '../../src/actions/retire-market.action.ts';
import {
  ReviseMarketDefinitionPayloadSchema,
  reviseMarketDefinitionAction,
} from '../../src/actions/revise-market-definition.action.ts';
import { reviseStorefrontAssociationAction } from '../../src/actions/revise-storefront-association.action.ts';
import { suspendMarketAction } from '../../src/actions/suspend-market.action.ts';
import { eligibleMarketTuplesRead } from '../../src/api/eligible-market-tuples.read.ts';
import { resolveCommerceMarketRead } from '../../src/api/resolve-commerce-market.read.ts';
import { commerceMarketCatalogApiContract } from '../../shared/api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '22222222-2222-4222-8222-222222222222';
const marketId = '33333333-3333-4333-8333-333333333333';
const definitionRevisionId = '44444444-4444-4444-8444-444444444444';
const associationId = '55555555-5555-4555-8555-555555555555';
const sellerId = '66666666-6666-4666-8666-666666666666';

const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const definitionRevisionRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: definitionRevisionId,
  resourceType: 'commerce.market-catalog.market-definition-revision',
  tenantId,
} as const;
const sellerRef = {
  moduleId: 'core.identity',
  resourceId: sellerId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const storefrontRef = { appId: 'shop-b2c', tenantId } as const;
const effectivePeriod = {
  endsAt: '2027-01-01T00:00:00.000Z',
  startsAt: '2026-10-01T00:00:00.000Z',
} as const;
const completenessEvidence = {
  observedAt: '2026-09-21T10:00:00.000Z',
  ownerRevision: 'eligible-tuples:17',
  scope: {
    kind: 'EXACT_PREDICATE',
    predicateRef: 'tenant/storefront/channel/subject:v1',
  },
} as const;
const eligibleTuple = {
  associationRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: associationId,
    resourceType: 'commerce.market-catalog.storefront-association',
    tenantId,
  },
  associationRevision: 1,
  channel: 'B2C',
  marketDefinitionRevisionRef: definitionRevisionRef,
  marketRef,
  sellingLegalEntityRef: sellerRef,
} as const;
const scope = {
  authBindingId: '77777777-7777-4777-8777-777777777777',
  authContextRef: 'better-auth-session:market-contract',
  authMethod: 'session' as const,
  correlationId: 'market-contract',
  legalEntityId: sellerId,
  principalId: '88888888-8888-4888-8888-888888888888',
  tenantId,
};

describe('Commerce Market public contracts', () => {
  it('models one Tenant-scoped immutable Market definition revision', () => {
    const definition = Schema.decodeUnknownSync(MarketDefinitionSchema)({
      channels: ['B2C', 'B2B'],
      definitionRevisionRef,
      effectivePeriod,
      jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
      lifecycle: 'ACTIVE',
      marketCode: 'CZ_MAIN',
      marketRef,
      purpose: 'Czech retail and wholesale selling context.',
      revision: 1,
      sellingLegalEntityRef: sellerRef,
      supportedLocales: ['cs-CZ', 'en'],
    });

    expect(definition.lifecycle).toBe('ACTIVE');
    expect(definition.channels).toEqual(['B2C', 'B2B']);
    expect(() =>
      Schema.decodeUnknownSync(MarketDefinitionSchema)({
        ...definition,
        sellingLegalEntityRef: { ...sellerRef, tenantId: foreignTenantId },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MarketDefinitionSchema)({
        ...definition,
        definitionRevisionRef: { ...definitionRevisionRef, tenantId: foreignTenantId },
      }),
    ).toThrow();
  });

  it('enforces inclusive-start/exclusive-end period ordering', () => {
    expect(() => Schema.decodeUnknownSync(EffectivePeriodSchema)(effectivePeriod)).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EffectivePeriodSchema)({
        endsAt: effectivePeriod.startsAt,
        startsAt: effectivePeriod.startsAt,
      }),
    ).toThrow();
  });

  it('rejects cross-Tenant Storefront associations and inconsistent sellers', () => {
    const association = {
      associationRef: {
        moduleId: 'commerce.market-catalog',
        resourceId: associationId,
        resourceType: 'commerce.market-catalog.storefront-association',
        tenantId,
      },
      channel: 'B2C',
      effectivePeriod,
      marketDefinitionRevisionRef: definitionRevisionRef,
      marketRef,
      provenance: { kind: 'CONFIGURATION_ACTION', reference: 'action:associate-storefront' },
      revision: 1,
      sellingLegalEntityRef: sellerRef,
      storefrontRef,
    } as const;

    expect(() => Schema.decodeUnknownSync(StorefrontAssociationDefinitionSchema)(association)).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(StorefrontAssociationDefinitionSchema)({
        ...association,
        storefrontRef: { ...storefrontRef, tenantId: foreignTenantId },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(StorefrontAssociationDefinitionSchema)({
        ...association,
        sellingLegalEntityRef: { ...sellerRef, tenantId: foreignTenantId },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(StorefrontAssociationDefinitionSchema)({
        ...association,
        marketDefinitionRevisionRef: { ...definitionRevisionRef, tenantId: foreignTenantId },
      }),
    ).toThrow();
  });

  it('requires owner-verifiable completeness for positive and empty eligible sets', () => {
    const completeEmpty = {
      completenessEvidence,
      effectiveAt: '2026-09-21T09:00:00.000Z',
      evaluatedAt: '2026-09-21T10:00:00.000Z',
      outcome: 'ELIGIBLE_MARKET_TUPLES',
      tuples: [],
    };

    expect(() => Schema.decodeUnknownSync(EligibleMarketTupleSetSchema)(completeEmpty)).not.toThrow();
    expect(() => Schema.decodeUnknownSync(EligibleMarketTuplesResponseSchema)(completeEmpty)).not.toThrow();
    const { completenessEvidence: _omitted, ...missingCompleteness } = completeEmpty;
    expect(() => Schema.decodeUnknownSync(EligibleMarketTupleSetSchema)(missingCompleteness)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(OwnerVerifiableSetCompletenessEvidenceSchema)(completenessEvidence),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EligibleMarketTupleSetSchema)({
        ...completeEmpty,
        completenessEvidence: {
          ...completenessEvidence,
          scope: { kind: 'EXACT_PREDICATE' },
        },
      }),
    ).toThrow();
  });

  it('discovers sellers without requiring a preselected Legal Entity and accepts an optional exact restriction', () => {
    const baseRequest = {
      channel: 'B2B',
      effectiveAt: '2026-09-21T10:00:00.000Z',
      storefrontRef,
    } as const;

    expect(() => Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema)(baseRequest)).not.toThrow();
    expect(() => Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)(baseRequest)).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema)({
        ...baseRequest,
        sellingLegalEntityRestriction: sellerRef,
      }),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        ...baseRequest,
        sellingLegalEntityRestriction: { ...sellerRef, tenantId: foreignTenantId },
      }),
    ).toThrow();
    expect(eligibleMarketTuplesRead.descriptor.legalEntityScope).toBe('optional');
    expect(resolveCommerceMarketRead.descriptor.legalEntityScope).toBe('optional');
  });

  it('separates requested applicability time from owner observation time', () => {
    const request = {
      channel: 'B2C',
      effectiveAt: '2026-09-21T09:00:00.000Z',
      storefrontRef,
    } as const;
    expect(() => Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema)(request)).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema)({
        at: request.effectiveAt,
        channel: request.channel,
        storefrontRef,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EligibleMarketTupleSetSchema)({
        completenessEvidence,
        effectiveAt: request.effectiveAt,
        evaluatedAt: '2026-09-21T10:00:00.000Z',
        outcome: 'ELIGIBLE_MARKET_TUPLES',
        tuples: [],
      }),
    ).not.toThrow();
  });

  it('publishes only the specified resolution outcomes and no AMBIGUOUS_MARKET path', () => {
    const unavailable = {
      outcome: 'MARKET_ELIGIBILITY_UNAVAILABLE',
      reason: 'Owner completeness could not be verified.',
      retryable: true,
    } as const;
    expect(Schema.is(MarketResolutionOutcomeSchema)(unavailable)).toBe(true);
    expect(Schema.is(ResolveCommerceMarketResponseSchema)(unavailable)).toBe(true);
    expect(Schema.is(MarketResolutionOutcomeSchema)({ outcome: 'AMBIGUOUS_MARKET' })).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(MarketResolutionOutcomeSchema)({
        choices: [eligibleTuple, eligibleTuple],
        completenessEvidence,
        effectiveAt: '2026-09-21T09:00:00.000Z',
        evaluatedAt: '2026-09-21T10:00:00.000Z',
        outcome: 'MARKET_SELECTION_REQUIRED',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MarketResolutionOutcomeSchema)({
        associationRevision: 2,
        completenessEvidence,
        effectiveAt: '2026-09-21T09:00:00.000Z',
        evaluatedAt: '2026-09-21T10:00:00.000Z',
        marketDefinitionRevisionRef: definitionRevisionRef,
        outcome: 'MARKET_RESOLVED',
        selectedTuple: eligibleTuple,
        selectionSource: 'EXPLICIT',
      }),
    ).toThrow();
  });

  it('keeps eligible tuple output browser-safe and closed to raw restriction evidence', () => {
    // The governed read runtime decodes every read result closed (core-runtime `reads/runtime.ts`).
    const decode = Schema.decodeUnknownSync(EligibleMarketTupleSetSchema, { onExcessProperty: 'error' });
    expect(
      decode({
        completenessEvidence,
        effectiveAt: '2026-09-21T09:00:00.000Z',
        evaluatedAt: '2026-09-21T10:00:00.000Z',
        outcome: 'ELIGIBLE_MARKET_TUPLES',
        tuples: [eligibleTuple],
      }).tuples,
    ).toHaveLength(1);
    expect(() =>
      decode({
        completenessEvidence,
        effectiveAt: '2026-09-21T09:00:00.000Z',
        evaluatedAt: '2026-09-21T10:00:00.000Z',
        outcome: 'ELIGIBLE_MARKET_TUPLES',
        rawRestrictionEvidence: { query: 'private owner predicate' },
        tuples: [eligibleTuple],
      }),
    ).toThrow();
  });

  it('publishes exact resources, APIs, Actions, and safe outbox payloads', () => {
    expect(commerceMarketCatalogManifest.module.id).toBe('commerce.market-catalog');
    expect(commerceMarketCatalogManifest.publicSurface.resourceTypes.map(({ key }) => key)).toEqual([
      'commerce.market-catalog.market-catalog-root',
      'commerce.market-catalog.market-definition-revision',
      'commerce.market-catalog.market',
      'commerce.market-catalog.storefront-association',
    ]);
    expect(Object.keys(commerceMarketCatalogManifest.publicSurface.api)).toEqual([
      'current-market-catalog',
      'eligible-market-tuples',
      'market-history',
      'resolve-commerce-market',
    ]);
    expect(commerceMarketCatalogManifest.publicSurface.businessPermissions).toEqual([]);
    expect(
      commerceMarketCatalogManifest.publicSurface.actions.map(({ descriptor }) => ({
        actionKey: descriptor.actionKey,
        provisioning:
          descriptor.entrypoint.authorization.kind === 'action_execution'
            ? descriptor.entrypoint.authorization.provisioning
            : null,
      })),
    ).toEqual([
      { actionKey: 'commerce.market-catalog.activate-market', provisioning: 'explicit' },
      { actionKey: 'commerce.market-catalog.associate-storefront', provisioning: 'explicit' },
      { actionKey: 'commerce.market-catalog.create-market', provisioning: 'explicit' },
      { actionKey: 'commerce.market-catalog.remove-storefront-association', provisioning: 'explicit' },
      { actionKey: 'commerce.market-catalog.retire-market', provisioning: 'explicit' },
      { actionKey: 'commerce.market-catalog.revise-market-definition', provisioning: 'explicit' },
      { actionKey: 'commerce.market-catalog.revise-storefront-association', provisioning: 'explicit' },
      { actionKey: 'commerce.market-catalog.suspend-market', provisioning: 'explicit' },
    ]);

    const created = {
      channels: ['B2C'],
      definitionRevisionRef,
      effectivePeriod,
      lifecycle: 'ACTIVE',
      marketRef,
      revision: 1,
      sellingLegalEntityRef: sellerRef,
    } as const;
    expect(() => Schema.decodeUnknownSync(MarketCreatedOutboxPayloadSchema)(created)).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MarketCreatedOutboxPayloadSchema)({
        ...created,
        definitionRevisionRef: { ...definitionRevisionRef, tenantId: foreignTenantId },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MarketCreatedOutboxPayloadSchema)({
        ...created,
        effectivePeriod: { startsAt: '2027-01-01T00:00:00.000Z' },
      }),
    ).not.toThrow();
    expect(() => Schema.decodeUnknownSync(MarketCreatedOutboxPayloadSchema)({ data: {} })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AssociationCreatedOutboxPayloadSchema)({
        associationRef: {
          moduleId: 'commerce.market-catalog',
          resourceId: associationId,
          resourceType: 'commerce.market-catalog.storefront-association',
          tenantId,
        },
        channel: 'B2C',
        effectivePeriod,
        marketRef,
        revision: 1,
        storefrontRef,
      }),
    ).not.toThrow();
    expect(Schema.is(MarketRefSchema)(marketRef)).toBe(true);
  });

  it('defines guarded administration payloads without permitting seller reinterpretation', () => {
    const create = {
      channels: ['B2C'],
      effectivePeriod,
      jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
      lifecycle: 'ACTIVE',
      marketCode: 'CZ_MAIN',
      marketId,
      purpose: 'Czech direct commerce.',
      reason: 'Initial approved Market definition.',
      sellingLegalEntityRef: sellerRef,
      supportedLocales: ['cs-CZ'],
    } as const;
    expect(() => Schema.decodeUnknownSync(CreateMarketPayloadSchema)(create)).not.toThrow();
    // The platform Action boundary (decodeActionPayload) decodes payloads with these options.
    expect(() =>
      Schema.decodeUnknownSync(ReviseMarketDefinitionPayloadSchema, { onExcessProperty: 'error' })({
        channels: ['B2C'],
        effectivePeriod,
        expectedCurrentDefinitionRevisionRef: definitionRevisionRef,
        expectedRevision: 1,
        jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
        marketRef,
        purpose: 'Revised copy only.',
        reason: 'Approved immutable revision.',
        sellingLegalEntityRef: sellerRef,
        supportedLocales: ['cs-CZ'],
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(AssociateStorefrontPayloadSchema)({
        associationId,
        channel: 'B2C',
        effectivePeriod,
        expectedMarketDefinitionRevisionRef: definitionRevisionRef,
        marketRef,
        provenance: { kind: 'CONFIGURATION_ACTION', reference: 'action:associate-storefront' },
        reason: 'Approved storefront launch.',
        sellingLegalEntityRef: sellerRef,
        storefrontRef: { ...storefrontRef, tenantId: foreignTenantId },
      }),
    ).toThrow();
  });

  it('targets exact Market resources and uses no generic customer-subject administration permission', () => {
    const createPayload = Schema.decodeUnknownSync(CreateMarketPayloadSchema)({
      channels: ['B2C'],
      effectivePeriod,
      jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
      lifecycle: 'ACTIVE',
      marketCode: 'CZ_MAIN',
      marketId,
      purpose: 'Czech direct commerce.',
      reason: 'Initial approved Market definition.',
      sellingLegalEntityRef: sellerRef,
      supportedLocales: ['cs-CZ'],
    });
    const revisePayload = Schema.decodeUnknownSync(ReviseMarketDefinitionPayloadSchema)({
      channels: ['B2C'],
      effectivePeriod,
      expectedCurrentDefinitionRevisionRef: definitionRevisionRef,
      expectedRevision: 1,
      jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
      marketRef,
      purpose: 'Clarified commercial purpose.',
      reason: 'Approved immutable revision.',
      supportedLocales: ['cs-CZ'],
    });
    const associationRef = {
      moduleId: 'commerce.market-catalog',
      resourceId: associationId,
      resourceType: 'commerce.market-catalog.storefront-association',
      tenantId,
    } as const;
    const removePayload = Schema.decodeUnknownSync(RemoveStorefrontAssociationPayloadSchema)({
      associationRef,
      effectiveAt: '2026-12-01T00:00:00.000Z',
      expectedRevision: 2,
      marketRef,
      reason: 'Storefront association retired.',
      storefrontRef,
    });

    expect(getActionResourcePermissionTargetResolver(createMarketAction)?.(createPayload, scope)).toEqual({
      permission: 'write',
      resource: {
        moduleId: 'commerce.market-catalog',
        resourceId: sellerId,
        resourceType: 'commerce.market-catalog.market-catalog-root',
      },
    });
    expect(() =>
      getActionResourcePermissionTargetResolver(createMarketAction)?.(createPayload, {
        ...scope,
        legalEntityId: '99999999-9999-4999-8999-999999999999',
      }),
    ).toThrow();
    expect(getActionResourcePermissionTargetResolver(reviseMarketDefinitionAction)?.(revisePayload, scope)).toEqual({
      permission: 'write',
      resource: marketRef,
    });
    expect(
      getActionResourcePermissionTargetResolver(removeStorefrontAssociationAction)?.(removePayload, scope),
    ).toEqual({
      permission: 'write',
      resource: associationRef,
    });
    expect(associateStorefrontAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect(retireMarketAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect([
      getActionResourcePermissionTargetResolver(activateMarketAction),
      getActionResourcePermissionTargetResolver(associateStorefrontAction),
      getActionResourcePermissionTargetResolver(createMarketAction),
      getActionResourcePermissionTargetResolver(removeStorefrontAssociationAction),
      getActionResourcePermissionTargetResolver(retireMarketAction),
      getActionResourcePermissionTargetResolver(reviseMarketDefinitionAction),
      getActionResourcePermissionTargetResolver(reviseStorefrontAssociationAction),
      getActionResourcePermissionTargetResolver(suspendMarketAction),
    ]).not.toContain(undefined);
  });

  it('rejects cross-Tenant association results and change events', () => {
    const { associationRef } = eligibleTuple;
    const revised = {
      associationRef,
      channel: 'B2C',
      effectivePeriod,
      marketRef,
      previousRevision: 1,
      revision: 2,
      storefrontRef,
    } as const;
    const removed = {
      associationRef,
      marketRef,
      removedAt: '2026-12-01T00:00:00.000Z',
      revision: 2,
      storefrontRef,
    } as const;
    expect(() => Schema.decodeUnknownSync(AssociationRevisedOutboxPayloadSchema)(revised)).not.toThrow();
    expect(() => Schema.decodeUnknownSync(AssociationRemovedOutboxPayloadSchema)(removed)).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AssociationRevisedOutboxPayloadSchema)({
        ...revised,
        storefrontRef: { ...storefrontRef, tenantId: foreignTenantId },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AssociationRemovedOutboxPayloadSchema)({
        ...removed,
        associationRef: { ...associationRef, tenantId: foreignTenantId },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(StorefrontAssociationResultSchema)({
        associationRef: { ...associationRef, tenantId: foreignTenantId },
        changed: true,
        marketRef,
        revision: 2,
      }),
    ).toThrow();
  });

  it('publishes all governed operation clients and schemas from the package client subpath', () => {
    expect(publishedCommerceMarketCatalogClient).toEqual({
      executeCurrentMarketCatalog,
      executeEligibleMarketTuples,
      executeMarketHistory,
      executeResolveCommerceMarket,
      getCommerceMarketCatalogReadiness,
    });
    expect(PublishedEligibleMarketTuplesRequestSchema).toBe(EligibleMarketTuplesRequestSchema);
    expect(PublishedResolveCommerceMarketResponseSchema).toBe(ResolveCommerceMarketResponseSchema);
  });

  it('keeps deployment and module identities consistent without exposing private implementation surfaces', () => {
    expect(ultramodernApiMarker.appId).toBe('commerce-market-catalog');
    expect(commerceMarketCatalogApiContract.ownerId).toBe('commerce-market-catalog');
    expect(commerceMarketCatalogManifest.module.id).toBe('commerce.market-catalog');
    expect(commerceMarketCatalogRegistration.moduleId).toBe(commerceMarketCatalogManifest.module.id);
    expect(Object.keys(commerceMarketCatalogManifest.publicSurface.components)).toEqual([]);
    expect(commerceMarketCatalogManifest.publicSurface.shellContributions.publicComponents).toEqual([]);
    for (const action of commerceMarketCatalogManifest.publicSurface.actions) {
      expect('handler' in action).toBe(false);
      expect('registration' in action).toBe(false);
      expect('repository' in action).toBe(false);
    }
  });
});
