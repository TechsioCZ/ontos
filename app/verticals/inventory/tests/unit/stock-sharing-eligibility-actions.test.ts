import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  getActionBusinessPermissionTargetResolver,
  getActionResourcePermissionTargetResolver,
} from '../../../../packages/core-runtime/src/actions/definition.ts';
import { ChangeStockSharingEligibilityPayloadSchema } from '../../shared/actions/change-stock-sharing-eligibility.ts';
import { EndStockSharingEligibilityPayloadSchema } from '../../shared/actions/end-stock-sharing-eligibility.ts';
import { EstablishStockSharingEligibilityPayloadSchema } from '../../shared/actions/establish-stock-sharing-eligibility.ts';
import type {
  StockSharingEligibility,
  StockSharingEligibilityPersistence,
} from '../../shared/domain/stock-sharing-eligibility.ts';
import { StockSharingEligibilitySchema } from '../../shared/domain/stock-sharing-eligibility.ts';
import { StockSharingEligibilityUnavailable } from '../../shared/domain/stock-sharing-eligibility-unavailable.ts';
import { changeStockSharingEligibilityAction } from '../../src/actions/change-stock-sharing-eligibility.action.ts';
import { endStockSharingEligibilityAction } from '../../src/actions/end-stock-sharing-eligibility.action.ts';
import {
  establishStockSharingEligibilityAction,
  handleEstablishStockSharingEligibility,
} from '../../src/actions/establish-stock-sharing-eligibility.action.ts';
import {
  makeStockSharingEligibilityActionService,
  unavailableStockSharingCommerceScopeValidator,
} from '../../src/services/stock-sharing-eligibility-action.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const relationId = '33333333-3333-4333-8333-333333333333';
const positionRef = {
  moduleId: 'commerce.inventory',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
} as const;
const ownerConfigurationRef = {
  moduleId: 'commerce.inventory',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.inventory.inventory-backend-configuration',
  tenantId,
} as const;
const sellingLegalEntityRef = {
  moduleId: 'core.identity',
  resourceId: legalEntityId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const effectiveFrom = '2026-09-25T08:00:00.000Z';
const establishPayload = Schema.decodeUnknownSync(EstablishStockSharingEligibilityPayloadSchema)({
  effectiveFrom,
  scope: {
    customerConfigurationId: 'customer-configuration:primary',
    ownerConfigurationRef,
    positionRef,
  },
  subject: {
    channel: 'B2C',
    commerceMarketRef: {
      moduleId: 'commerce.market-catalog',
      resourceId: 'market-cz',
      resourceType: 'commerce.market-catalog.market',
      tenantId,
    },
    sellingLegalEntityRef,
    storefrontRef: { appId: 'shop-cz', tenantId },
  },
});
const relation = Schema.decodeUnknownSync(StockSharingEligibilitySchema)({
  commerceValidation: {
    evidenceRef: 'commerce-scope:verified:1',
    observedAt: effectiveFrom,
    verification: 'OWNER_VERIFIED_CURRENT',
  },
  effectivePeriod: { from: effectiveFrom, to: null },
  lifecycle: 'CURRENT',
  ref: {
    moduleId: 'commerce.inventory',
    resourceId: relationId,
    resourceType: 'commerce.inventory.stock-sharing-eligibility',
    tenantId,
  },
  revision: 1,
  scope: establishPayload.scope,
  subject: establishPayload.subject,
});
const changePayload = Schema.decodeUnknownSync(ChangeStockSharingEligibilityPayloadSchema)({
  changedAt: '2026-09-25T09:00:00.000Z',
  positionRef,
  relationRef: relation.ref,
  subject: { channel: 'B2B', sellingLegalEntityRef },
});
const endPayload = Schema.decodeUnknownSync(EndStockSharingEligibilityPayloadSchema)({
  endedAt: '2026-09-25T10:00:00.000Z',
  positionRef,
  relationRef: relation.ref,
});
const scope = trustVerifiedGatewayPrincipalContext({
  authBindingId: '66666666-6666-4666-8666-666666666666',
  authContextRef: 'test:stock-sharing-eligibility-actions',
  authMethod: 'api_key',
  correlationId: 'stock-sharing-eligibility-actions',
  legalEntityId,
  principalId: '77777777-7777-4777-8777-777777777777',
  tenantId,
});

const validator = {
  validateCurrent: () =>
    Effect.succeed({
      evidenceRef: 'commerce-scope:verified:1',
      observedAt: effectiveFrom,
      verification: 'OWNER_VERIFIED_CURRENT' as const,
    }),
};

const memoryPersistence = (initial?: StockSharingEligibility) => {
  let current = initial;
  let insertCalls = 0;
  let saveCalls = 0;
  const persistence: StockSharingEligibilityPersistence = {
    findByRef: () => Effect.sync(() => Option.fromNullishOr(current)),
    insertCurrent: (next) =>
      Effect.sync(() => {
        insertCalls += 1;
        current = next;
        return next;
      }),
    listCurrent: () => Effect.sync(() => (current === undefined ? [] : [current])),
    readHistory: () => Effect.sync(() => (current === undefined ? [] : [current])),
    saveRevision: ({ next }) =>
      Effect.sync(() => {
        saveCalls += 1;
        current = next;
        return next;
      }),
  };
  return {
    get insertCalls() {
      return insertCalls;
    },
    persistence,
    get saveCalls() {
      return saveCalls;
    },
  };
};

describe('Stock Sharing Eligibility lifecycle Actions', () => {
  it('declares required legal-entity, exact Position business, and conjunctive Resource permission gates', () => {
    const expectedTarget = {
      kind: 'inventory_resource',
      resource: {
        moduleId: positionRef.moduleId,
        resourceId: positionRef.resourceId,
        resourceType: positionRef.resourceType,
      },
      tenantId,
    } as const;
    for (const action of [
      establishStockSharingEligibilityAction,
      changeStockSharingEligibilityAction,
      endStockSharingEligibilityAction,
    ]) {
      expect(action.descriptor.legalEntityScope).toBe('required');
      expect(action.descriptor.auditProfile).toBe('sensitive');
    }
    expect(
      getActionBusinessPermissionTargetResolver(establishStockSharingEligibilityAction)?.(establishPayload, scope),
    ).toEqual({ permission: 'inventory.stock_sharing_eligibility.manage', target: expectedTarget });
    expect(
      getActionBusinessPermissionTargetResolver(changeStockSharingEligibilityAction)?.(changePayload, scope),
    ).toEqual({ permission: 'inventory.stock_sharing_eligibility.manage', target: expectedTarget });
    expect(getActionBusinessPermissionTargetResolver(endStockSharingEligibilityAction)?.(endPayload, scope)).toEqual({
      permission: 'inventory.stock_sharing_eligibility.manage',
      target: expectedTarget,
    });
    expect(
      getActionResourcePermissionTargetResolver(establishStockSharingEligibilityAction)?.(establishPayload, scope),
    ).toEqual({ permission: 'write', resource: positionRef });
    expect(
      getActionResourcePermissionTargetResolver(changeStockSharingEligibilityAction)?.(changePayload, scope),
    ).toEqual({ permission: 'write', resource: positionRef });
    expect(getActionResourcePermissionTargetResolver(endStockSharingEligibilityAction)?.(endPayload, scope)).toEqual({
      permission: 'write',
      resource: positionRef,
    });
  });

  it.effect('fails closed without owner Commerce validation and before persistence', () =>
    Effect.gen(function* unavailableOwnerValidation() {
      const memory = memoryPersistence();
      const services = makeStockSharingEligibilityActionService({
        commerceValidator: unavailableStockSharingCommerceScopeValidator,
        makeEligibilityId: () => relationId,
        persistence: memory.persistence,
      });

      const failure = yield* Effect.flip(services.establish(establishPayload, legalEntityId));

      expect(failure).toBeInstanceOf(StockSharingEligibilityUnavailable);
      expect(memory.insertCalls).toBe(0);
    }),
  );

  it.effect('rejects seller or Position retargeting before validation and revision writes', () =>
    Effect.gen(function* rejectRetargeting() {
      let validationCalls = 0;
      const memory = memoryPersistence(relation);
      const services = makeStockSharingEligibilityActionService({
        commerceValidator: {
          validateCurrent: () =>
            Effect.sync(() => {
              validationCalls += 1;
              return {
                evidenceRef: 'commerce-scope:verified:1',
                observedAt: effectiveFrom,
                verification: 'OWNER_VERIFIED_CURRENT' as const,
              };
            }),
        },
        makeEligibilityId: () => relationId,
        persistence: memory.persistence,
      });
      const sellerFailure = yield* Effect.flip(
        services.establish(establishPayload, '88888888-8888-4888-8888-888888888888'),
      );
      const positionFailure = yield* Effect.flip(
        services.change(
          {
            ...changePayload,
            positionRef: { ...positionRef, resourceId: '99999999-9999-4999-8999-999999999999' },
          },
          legalEntityId,
        ),
      );

      expect(sellerFailure).toMatchObject({ reason: 'TRUSTED_LEGAL_ENTITY_MISMATCH' });
      expect(positionFailure).toMatchObject({ reason: 'POSITION_SCOPE_MISMATCH' });
      expect(validationCalls).toBe(0);
      expect(memory.saveCalls).toBe(0);
    }),
  );

  it.effect('records the exact Position and full commercial relation scope as governed evidence', () =>
    Effect.gen(function* governedEvidence() {
      const memory = memoryPersistence();
      const services = makeStockSharingEligibilityActionService({
        commerceValidator: validator,
        makeEligibilityId: () => relationId,
        persistence: memory.persistence,
      });
      const collector = createActionCollector(
        establishStockSharingEligibilityAction.descriptor.domainEvents,
        'commerce.inventory',
        establishStockSharingEligibilityAction.descriptor.accessEvidencePolicy,
        establishStockSharingEligibilityAction.descriptor.auditEvidenceSchema,
      );
      const result = yield* handleEstablishStockSharingEligibility(establishPayload, {
        actionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services,
      });
      const evidence = collector.snapshot();

      expect(result).toEqual(relation);
      expect(evidence.dataAccessEvents).toHaveLength(1);
      expect(evidence.dataAccessEvents[0]).toMatchObject({
        targetResourceId: positionRef.resourceId,
        targetResourceType: positionRef.resourceType,
      });
      expect(evidence.domainEvents).toHaveLength(1);
      expect(evidence.auditEvidence).toEqual({
        channel: 'B2C',
        commerceMarketId: 'market-cz',
        customerConfigurationId: 'customer-configuration:primary',
        operation: 'ESTABLISH',
        ownerConfigurationId: ownerConfigurationRef.resourceId,
        positionId: positionRef.resourceId,
        relationId,
        sellingLegalEntityId: legalEntityId,
        storefrontAppId: 'shop-cz',
      });
    }),
  );

  it.effect('changes and ends only the Current relation behind the authorized exact Position', () =>
    Effect.gen(function* lifecycle() {
      const memory = memoryPersistence(relation);
      const services = makeStockSharingEligibilityActionService({
        commerceValidator: validator,
        makeEligibilityId: () => relationId,
        persistence: memory.persistence,
      });
      const changed = yield* services.change(changePayload, legalEntityId);
      const ended = yield* services.end(endPayload, legalEntityId);

      expect(changed).toMatchObject({ lifecycle: 'CURRENT', revision: 2, subject: { channel: 'B2B' } });
      expect(ended).toMatchObject({ lifecycle: 'ENDED', revision: 3 });
      expect(memory.saveCalls).toBe(2);
    }),
  );
});
