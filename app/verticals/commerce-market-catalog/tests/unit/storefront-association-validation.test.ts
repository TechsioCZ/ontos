import {
  CurrentStorefrontApplicationRequestSchema,
  CurrentStorefrontApplicationResponseSchema,
} from '@app/storefront-registry-contracts';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Predicate, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import {
  AssociateStorefrontPayloadSchema,
  associateStorefrontAction,
} from '../../src/actions/associate-storefront.action.ts';
import { reviseStorefrontAssociationAction } from '../../src/actions/revise-storefront-association.action.ts';
import {
  StorefrontApplicationEvidenceStale,
  StorefrontApplicationNotCurrent,
  StorefrontApplicationValidationUnavailable,
  makeCurrentStorefrontApplicationAuthority,
} from '../../src/integrations/current-storefront-application.ts';
import { ReviseStorefrontAssociationPayloadSchema } from '../../shared/action-contracts.ts';
import type { MarketAdministrationService } from '../../src/services/market-administration.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const marketId = '22222222-2222-4222-8222-222222222222';
const sellerId = '33333333-3333-4333-8333-333333333333';
const definitionRevisionId = '44444444-4444-4444-8444-444444444444';
const principalId = '55555555-5555-4555-8555-555555555555';
const actionInvocationId = '66666666-6666-4666-8666-666666666666';
const associationId = '77777777-7777-4777-8777-777777777777';
const effectiveAt = '2026-10-01T00:00:00.000Z';
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
const storefrontRef = { appId: 'shop-cz', tenantId } as const;
const associationRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: associationId,
  resourceType: 'commerce.market-catalog.storefront-association',
  tenantId,
} as const;
const scope = {
  authMethod: 'system' as const,
  correlationId: 'storefront-association-validation',
  legalEntityId: sellerId,
  principalId,
  tenantId,
};
const associatePayload = Schema.decodeUnknownSync(AssociateStorefrontPayloadSchema)({
  associationId,
  channel: 'B2C',
  effectivePeriod: { startsAt: effectiveAt },
  expectedMarketDefinitionRevisionRef: definitionRevisionRef,
  marketRef,
  provenance: { kind: 'CONFIGURATION_ACTION', reference: 'approved-storefront-link' },
  reason: 'Associate the approved Storefront.',
  sellingLegalEntityRef: sellerRef,
  storefrontRef,
});
const revisePayload = Schema.decodeUnknownSync(ReviseStorefrontAssociationPayloadSchema)({
  associationRef,
  channel: 'B2C',
  effectivePeriod: { startsAt: effectiveAt },
  expectedRevision: 1,
  marketRef,
  provenance: { kind: 'CONFIGURATION_ACTION', reference: 'approved-storefront-link-v2' },
  reason: 'Revise the approved Storefront association.',
  storefrontRef,
});
const currentRequest = Schema.decodeUnknownSync(CurrentStorefrontApplicationRequestSchema)({
  effectiveAt,
  requestedChannel: 'B2C',
  storefrontAppId: 'shop-cz',
  tenantId,
});
const currentResponse = Schema.decodeUnknownSync(CurrentStorefrontApplicationResponseSchema)({
  ...currentRequest,
  allowedChannels: ['B2C'],
  effectiveInterval: { effectiveFrom: '2026-09-01T00:00:00.000Z' },
  lifecycle: 'ACTIVE',
  nextApplicabilityBoundary: '2026-11-01T00:00:00.000Z',
  observedAt: '2026-09-30T23:59:59.000Z',
  outcome: 'CURRENT',
  ownerRevision: 'storefront-application:shop-cz:r3:g7',
});

const unexpected = () => Effect.die('unexpected Market administration service call');
const unavailableServices: MarketAdministrationService = {
  associateStorefront: unexpected,
  createMarket: unexpected,
  removeStorefrontAssociation: unexpected,
  reviseMarketDefinition: unexpected,
  reviseStorefrontAssociation: unexpected,
  transitionLifecycle: unexpected,
};
const evidence = {
  nextApplicabilityBoundary: '2026-11-01T00:00:00.000Z',
  observedAt: '2026-09-30T23:59:59.000Z',
  ownerRevision: 'storefront-application:shop-cz:r3:g7',
} as const;

describe('Storefront association Current application validation', () => {
  it.effect('accepts exact CURRENT owner evidence and rejects an identity mismatch as stale', () =>
    Effect.gen(function* adapterEvidence() {
      const authority = makeCurrentStorefrontApplicationAuthority(() => Effect.succeed(currentResponse));
      expect(yield* authority.validateCurrent(currentRequest, 'association-current')).toEqual(evidence);

      const mismatched = Schema.decodeUnknownSync(CurrentStorefrontApplicationResponseSchema)({
        ...currentResponse,
        storefrontAppId: 'other-shop',
      });
      const failure = yield* makeCurrentStorefrontApplicationAuthority(() => Effect.succeed(mismatched))
        .validateCurrent(currentRequest, 'association-mismatch')
        .pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'StorefrontApplicationEvidenceStale')).toBe(true);

      const crossTenant = Schema.decodeUnknownSync(CurrentStorefrontApplicationResponseSchema)({
        ...currentResponse,
        tenantId: '99999999-9999-4999-8999-999999999999',
      });
      const crossTenantFailure = yield* makeCurrentStorefrontApplicationAuthority(() => Effect.succeed(crossTenant))
        .validateCurrent(currentRequest, 'association-cross-tenant')
        .pipe(Effect.flip);
      expect(Predicate.isTagged(crossTenantFailure, 'StorefrontApplicationEvidenceStale')).toBe(true);
    }),
  );

  it.effect('maps every non-current, unavailable, and stale owner outcome to typed fail-closed errors', () =>
    Effect.gen(function* failClosedOutcomes() {
      const cases = [
        {
          expectedTag: 'StorefrontApplicationNotCurrent',
          response: { ...currentRequest, outcome: 'NOT_FOUND', reason: 'Not registered' },
        },
        {
          expectedTag: 'StorefrontApplicationNotCurrent',
          response: {
            ...currentRequest,
            lifecycle: 'SUSPENDED',
            outcome: 'NOT_CURRENT',
            ownerRevision: 'storefront-application:shop-cz:r4:g8',
            reason: 'Suspended',
          },
        },
        {
          expectedTag: 'StorefrontApplicationNotCurrent',
          response: {
            ...currentRequest,
            allowedChannels: ['B2B'],
            outcome: 'CHANNEL_NOT_ALLOWED',
            ownerRevision: 'storefront-application:shop-cz:r4:g8',
            reason: 'B2C is not allowed',
          },
        },
        {
          expectedTag: 'StorefrontApplicationValidationUnavailable',
          response: { ...currentRequest, outcome: 'UNAVAILABLE', reason: 'Owner unavailable', retryable: true },
        },
        {
          expectedTag: 'StorefrontApplicationValidationUnavailable',
          response: { ...currentRequest, outcome: 'UNVERIFIABLE', reason: 'Evidence unavailable' },
        },
        {
          expectedTag: 'StorefrontApplicationEvidenceStale',
          response: {
            ...currentRequest,
            observedAt: '2026-09-30T23:00:00.000Z',
            outcome: 'STALE',
            ownerRevision: 'storefront-application:shop-cz:r2:g6',
            reason: 'Owner evidence is stale',
          },
        },
      ] as const;

      for (const testCase of cases) {
        const response = Schema.decodeUnknownSync(CurrentStorefrontApplicationResponseSchema)(testCase.response);
        const failure = yield* makeCurrentStorefrontApplicationAuthority(() => Effect.succeed(response))
          .validateCurrent(currentRequest, 'association-failure')
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, testCase.expectedTag)).toBe(true);
      }

      const transportFailure = yield* makeCurrentStorefrontApplicationAuthority(() =>
        Schema.decodeUnknownEffect(CurrentStorefrontApplicationRequestSchema)({}).pipe(Effect.as(currentResponse)),
      )
        .validateCurrent(currentRequest, 'association-offline')
        .pipe(Effect.flip);
      expect(Predicate.isTagged(transportFailure, 'StorefrontApplicationValidationUnavailable')).toBe(true);
    }),
  );

  it.effect('preflights associate with the exact tenant, app, channel, and effective instant before persistence', () =>
    Effect.gen(function* associatePreflight() {
      const calls: string[] = [];
      const collector = createActionCollector(
        associateStorefrontAction.descriptor.domainEvents,
        'commerce.market-catalog',
        associateStorefrontAction.descriptor.accessEvidencePolicy,
        associateStorefrontAction.descriptor.auditEvidenceSchema,
      );
      const result = yield* getActionHandler(associateStorefrontAction)(associatePayload, {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: {
          ...unavailableServices,
          associateStorefront: () => {
            calls.push('persist');
            return Effect.succeed({ _tag: 'associated', changed: false, generation: 4, revision: 1 } as const);
          },
          validateCurrent: (input, correlation) => {
            calls.push('validate');
            expect(input).toEqual(currentRequest);
            expect(correlation).toBe(scope.correlationId);
            return Effect.succeed(evidence);
          },
        },
      });
      expect(calls).toEqual(['validate', 'persist']);
      expect(result).toMatchObject({ changed: false, revision: 1 });
      expect(collector.snapshot().dataAccessEvents).toContainEqual(
        expect.objectContaining({
          queryHash: expect.stringContaining(evidence.ownerRevision),
          servingModuleKey: 'commerce.storefront-registry',
        }),
      );
    }),
  );

  it.effect('preflights revise and never calls persistence for any typed validation failure', () =>
    Effect.gen(function* revisePreflight() {
      const failures = [
        new StorefrontApplicationNotCurrent({
          code: 'storefront_application_not_current',
          reason: 'Storefront is suspended',
        }),
        new StorefrontApplicationValidationUnavailable({
          code: 'storefront_application_validation_unavailable',
          reason: 'Storefront authority is unavailable',
        }),
        new StorefrontApplicationEvidenceStale({
          code: 'storefront_application_evidence_stale',
          reason: 'Storefront evidence is stale',
        }),
      ] as const;
      for (const expectedFailure of failures) {
        const persistenceCalls: string[] = [];
        const collector = createActionCollector(
          reviseStorefrontAssociationAction.descriptor.domainEvents,
          'commerce.market-catalog',
          reviseStorefrontAssociationAction.descriptor.accessEvidencePolicy,
          reviseStorefrontAssociationAction.descriptor.auditEvidenceSchema,
        );
        const failure = yield* getActionHandler(reviseStorefrontAssociationAction)(revisePayload, {
          actionInvocationId,
          addDomainEvent: collector.addDomainEvent,
          addOutboxMessage: collector.addOutboxMessage,
          recordAuditEvidence: collector.recordAuditEvidence,
          recordDataAccess: collector.recordDataAccess,
          scope,
          services: {
            ...unavailableServices,
            reviseStorefrontAssociation: () => {
              persistenceCalls.push('persist');
              return unexpected();
            },
            validateCurrent: (input, correlation) => {
              expect(input).toEqual(currentRequest);
              expect(correlation).toBe(scope.correlationId);
              return Effect.fail(expectedFailure);
            },
          },
        }).pipe(Effect.flip);
        expect(failure).toBe(expectedFailure);
        expect(persistenceCalls).toHaveLength(0);
        expect(collector.snapshot().dataAccessEvents).toHaveLength(0);
      }
    }),
  );
});
