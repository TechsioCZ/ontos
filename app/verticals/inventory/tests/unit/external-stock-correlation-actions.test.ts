import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { Effect, Option, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  getActionBusinessPermissionTargetResolver,
  getActionResourcePermissionTargetResolver,
} from '../../../../packages/core-runtime/src/actions/definition.ts';
import type {
  ExternalStockCorrelation,
  ExternalStockCorrelationPersistence,
  ExternalStockKey,
} from '../../shared/domain/external-stock-correlation.ts';
import {
  ExternalStockCorrelationSchema,
  ExternalStockKeySchema,
} from '../../shared/domain/external-stock-correlation.ts';
import { CorrectExternalStockCorrelationPayloadSchema as CorrectPayloadSchema } from '../../shared/actions/correct-external-stock-correlation.ts';
import { EstablishExternalStockCorrelationPayloadSchema as EstablishPayloadSchema } from '../../shared/actions/establish-external-stock-correlation.ts';
import { EndExternalStockCorrelationPayloadSchema as EndPayloadSchema } from '../../shared/actions/end-external-stock-correlation.ts';
import {
  correctExternalStockCorrelationAction,
  handleCorrectExternalStockCorrelation,
} from '../../src/actions/correct-external-stock-correlation.action.ts';
import {
  establishExternalStockCorrelationAction,
  handleEstablishExternalStockCorrelation,
} from '../../src/actions/establish-external-stock-correlation.action.ts';
import {
  endExternalStockCorrelationAction,
  handleEndExternalStockCorrelation,
} from '../../src/actions/end-external-stock-correlation.action.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const firstCorrelationId = '33333333-3333-4333-8333-333333333333';
const replacementCorrelationId = '44444444-4444-4444-8444-444444444444';
const firstItemId = '55555555-5555-4555-8555-555555555555';
const replacementItemId = '66666666-6666-4666-8666-666666666666';

const correlationRef = (resourceId: string) => ({
  moduleId: 'commerce.inventory' as const,
  resourceId,
  resourceType: 'commerce.inventory.external-stock-correlation' as const,
  tenantId,
});
const itemTarget = (resourceId: string) => ({
  _tag: 'STOCK_ITEM' as const,
  ref: {
    moduleId: 'commerce.inventory' as const,
    resourceId,
    resourceType: 'commerce.inventory.stock-item' as const,
    tenantId,
  },
});
const externalKey = Schema.decodeUnknownSync(ExternalStockKeySchema)({
  customerConfigurationId: 'customer-configuration:primary',
  externalScope: 'warehouse:prague',
  externalValue: 'ITEM-42',
  identifierKind: 'ITEM',
  issuer: { backendId: 'erp-primary', backendKind: 'external_business_system' },
  namespace: 'stock-items',
  tenantId,
});

const establishPayload = Schema.decodeUnknownSync(EstablishPayloadSchema)({
  correlationRef: correlationRef(firstCorrelationId),
  effectiveFrom: '2026-09-25T08:00:00.000Z',
  externalKey,
  ownerEvidenceRef: 'erp-primary:item:42:v1',
  target: itemTarget(firstItemId),
});
const correctPayload = Schema.decodeUnknownSync(CorrectPayloadSchema)({
  correctedAt: '2026-09-25T09:00:00.000Z',
  externalKey,
  ownerEvidenceRef: 'erp-primary:item:42:v2',
  replacementCorrelationRef: correlationRef(replacementCorrelationId),
  target: itemTarget(replacementItemId),
});
const endPayload = Schema.decodeUnknownSync(EndPayloadSchema)({
  correlationRef: correlationRef(replacementCorrelationId),
  endedAt: '2026-09-25T10:00:00.000Z',
  externalKey,
});

const sameKey = (left: ExternalStockKey, right: ExternalStockKey) =>
  left.tenantId === right.tenantId &&
  left.customerConfigurationId === right.customerConfigurationId &&
  left.issuer.backendKind === right.issuer.backendKind &&
  left.issuer.backendId === right.issuer.backendId &&
  left.namespace === right.namespace &&
  left.externalScope === right.externalScope &&
  left.identifierKind === right.identifierKind &&
  left.externalValue === right.externalValue;

const makePersistence = () => {
  const rows: ExternalStockCorrelation[] = [];
  const persistence: ExternalStockCorrelationPersistence = {
    endCurrent: ({ current, endedAt }) =>
      Effect.sync(() => {
        const ended = {
          ...current,
          effectivePeriod: { ...current.effectivePeriod, to: endedAt },
          lifecycle: 'ENDED' as const,
          revision: current.revision + 1,
        };
        rows.splice(rows.indexOf(current), 1, ended);
        return ended;
      }),
    findByRef: (ref) =>
      Effect.succeed(
        Option.fromNullishOr(
          rows.find(
            (row) => row.correlationRef.tenantId === ref.tenantId && row.correlationRef.resourceId === ref.resourceId,
          ),
        ),
      ),
    findEffective: (key, asOf) =>
      Effect.succeed(
        rows.filter(
          (row) =>
            sameKey(row.externalKey, key) &&
            row.effectivePeriod.from <= asOf &&
            (row.effectivePeriod.to === null || row.effectivePeriod.to > asOf),
        ),
      ),
    insertCurrent: (correlation) =>
      Effect.sync(() => {
        rows.push(correlation);
        return correlation;
      }),
    replaceCurrent: ({ current, endedAt, replacement }) =>
      Effect.sync(() => {
        rows.splice(rows.indexOf(current), 1, {
          ...current,
          effectivePeriod: { ...current.effectivePeriod, to: endedAt },
          lifecycle: 'ENDED',
          revision: current.revision + 1,
        });
        rows.push(replacement);
        return replacement;
      }),
    saveConfirmation: ({ expectedRevision, next }) =>
      Effect.sync(() => {
        const index = rows.findIndex(
          (row) =>
            row.correlationRef.resourceId === next.correlationRef.resourceId && row.revision === expectedRevision,
        );
        if (index !== -1) {
          rows.splice(index, 1, next);
        }
        return next;
      }),
  };
  return { persistence, rows };
};

const scope = trustVerifiedGatewayPrincipalContext({
  authBindingId: '77777777-7777-4777-8777-777777777777',
  authContextRef: 'test:external-stock-correlation-actions',
  authMethod: 'api_key',
  correlationId: 'external-stock-correlation-actions-test',
  principalId,
  tenantId,
});

describe('External Stock Correlation lifecycle Actions', () => {
  it('declares three independently idempotent, exact-resource authorized Actions', () => {
    const actions = [
      establishExternalStockCorrelationAction,
      correctExternalStockCorrelationAction,
      endExternalStockCorrelationAction,
    ] as const;
    expect(new Set(actions.map((action) => action.descriptor.actionKey)).size).toBe(3);
    for (const action of actions) {
      expect(action.descriptor).toMatchObject({
        auditProfile: 'sensitive',
        idempotency: 'required',
        legalEntityScope: 'forbidden',
        owningModuleKey: 'commerce.inventory',
      });
    }

    for (const [businessTarget, resourceTarget, resourceId] of [
      [
        getActionBusinessPermissionTargetResolver(establishExternalStockCorrelationAction)?.(establishPayload, scope),
        getActionResourcePermissionTargetResolver(establishExternalStockCorrelationAction)?.(establishPayload, scope),
        firstCorrelationId,
      ],
      [
        getActionBusinessPermissionTargetResolver(correctExternalStockCorrelationAction)?.(correctPayload, scope),
        getActionResourcePermissionTargetResolver(correctExternalStockCorrelationAction)?.(correctPayload, scope),
        replacementCorrelationId,
      ],
      [
        getActionBusinessPermissionTargetResolver(endExternalStockCorrelationAction)?.(endPayload, scope),
        getActionResourcePermissionTargetResolver(endExternalStockCorrelationAction)?.(endPayload, scope),
        replacementCorrelationId,
      ],
    ] as const) {
      expect(businessTarget).toEqual({
        permission: 'inventory.external_stock_correlation.manage',
        target: {
          kind: 'inventory_resource',
          resource: {
            moduleId: 'commerce.inventory',
            resourceId,
            resourceType: 'commerce.inventory.external-stock-correlation',
          },
          tenantId,
        },
      });
      expect(resourceTarget).toEqual({
        permission: 'write',
        resource: correlationRef(resourceId),
      });
    }
  });

  it.effect('establishes, corrects, and ends exact issuer-qualified identities with bounded evidence', () =>
    Effect.gen(function* lifecycleActions() {
      const { persistence, rows } = makePersistence();
      const establishCollector = createActionCollector(
        establishExternalStockCorrelationAction.descriptor.domainEvents,
        'commerce.inventory',
        establishExternalStockCorrelationAction.descriptor.accessEvidencePolicy,
        establishExternalStockCorrelationAction.descriptor.auditEvidenceSchema,
      );
      const established = yield* handleEstablishExternalStockCorrelation(establishPayload, {
        actionInvocationId: '88888888-8888-4888-8888-888888888888',
        addDomainEvent: establishCollector.addDomainEvent,
        addOutboxMessage: establishCollector.addOutboxMessage,
        recordAuditEvidence: establishCollector.recordAuditEvidence,
        recordDataAccess: establishCollector.recordDataAccess,
        scope,
        services: persistence,
      });
      expect(established.correlation.correlationRef.resourceId).toBe(firstCorrelationId);
      expect(establishCollector.snapshot()).toMatchObject({
        auditEvidence: { operation: 'ESTABLISHED', ownerEvidenceRef: 'erp-primary:item:42:v1' },
        dataAccessEvents: [{ resultCount: 0, targetResourceId: firstCorrelationId }],
      });

      const correctCollector = createActionCollector(
        correctExternalStockCorrelationAction.descriptor.domainEvents,
        'commerce.inventory',
        correctExternalStockCorrelationAction.descriptor.accessEvidencePolicy,
        correctExternalStockCorrelationAction.descriptor.auditEvidenceSchema,
      );
      const corrected = yield* handleCorrectExternalStockCorrelation(correctPayload, {
        actionInvocationId: '99999999-9999-4999-8999-999999999999',
        addDomainEvent: correctCollector.addDomainEvent,
        addOutboxMessage: correctCollector.addOutboxMessage,
        recordAuditEvidence: correctCollector.recordAuditEvidence,
        recordDataAccess: correctCollector.recordDataAccess,
        scope,
        services: persistence,
      });
      expect(corrected.correlation.correlationRef.resourceId).toBe(replacementCorrelationId);
      expect(rows).toMatchObject([
        { correlationRef: { resourceId: firstCorrelationId }, lifecycle: 'ENDED' },
        { correlationRef: { resourceId: replacementCorrelationId }, lifecycle: 'CURRENT' },
      ]);

      const endCollector = createActionCollector(
        endExternalStockCorrelationAction.descriptor.domainEvents,
        'commerce.inventory',
        endExternalStockCorrelationAction.descriptor.accessEvidencePolicy,
        endExternalStockCorrelationAction.descriptor.auditEvidenceSchema,
      );
      const ended = yield* handleEndExternalStockCorrelation(endPayload, {
        actionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        addDomainEvent: endCollector.addDomainEvent,
        addOutboxMessage: endCollector.addOutboxMessage,
        recordAuditEvidence: endCollector.recordAuditEvidence,
        recordDataAccess: endCollector.recordDataAccess,
        scope,
        services: persistence,
      });
      expect(ended.correlation).toMatchObject({
        correlationRef: { resourceId: replacementCorrelationId },
        effectivePeriod: { to: endPayload.endedAt },
        lifecycle: 'ENDED',
      });
      expect(endCollector.snapshot()).toMatchObject({
        auditEvidence: { operation: 'ENDED', ownerEvidenceRef: 'erp-primary:item:42:v2' },
        dataAccessEvents: [{ resultCount: 1, targetResourceId: replacementCorrelationId }],
      });
    }),
  );

  it.effect('rejects an End whose qualified key does not identify the supplied current correlation', () =>
    Effect.gen(function* exactEndIdentity() {
      const { persistence } = makePersistence();
      const collector = createActionCollector(
        establishExternalStockCorrelationAction.descriptor.domainEvents,
        'commerce.inventory',
        establishExternalStockCorrelationAction.descriptor.accessEvidencePolicy,
        establishExternalStockCorrelationAction.descriptor.auditEvidenceSchema,
      );
      yield* handleEstablishExternalStockCorrelation(establishPayload, {
        actionInvocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: persistence,
      });
      const failure = yield* Effect.flip(
        handleEndExternalStockCorrelation(
          Schema.decodeUnknownSync(EndPayloadSchema)({
            ...endPayload,
            correlationRef: establishPayload.correlationRef,
            externalKey: { ...externalKey, namespace: 'different-owner-namespace' },
          }),
          {
            actionInvocationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            addDomainEvent: collector.addDomainEvent,
            addOutboxMessage: collector.addOutboxMessage,
            recordAuditEvidence: collector.recordAuditEvidence,
            recordDataAccess: collector.recordDataAccess,
            scope,
            services: persistence,
          },
        ),
      );
      expect(Predicate.isTagged(failure, 'ExternalStockCorrelationRejected')).toBe(true);
      expect(failure.reason).toBe('CORRELATION_NOT_FOUND');
    }),
  );

  it.effect('rejects a persistence response that does not preserve the caller-proposed identity', () =>
    Effect.gen(function* exactPersistedIdentity() {
      const { persistence } = makePersistence();
      const collector = createActionCollector(
        establishExternalStockCorrelationAction.descriptor.domainEvents,
        'commerce.inventory',
        establishExternalStockCorrelationAction.descriptor.accessEvidencePolicy,
        establishExternalStockCorrelationAction.descriptor.auditEvidenceSchema,
      );
      const failure = yield* Effect.flip(
        handleEstablishExternalStockCorrelation(establishPayload, {
          actionInvocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          addDomainEvent: collector.addDomainEvent,
          addOutboxMessage: collector.addOutboxMessage,
          recordAuditEvidence: collector.recordAuditEvidence,
          recordDataAccess: collector.recordDataAccess,
          scope,
          services: {
            ...persistence,
            insertCurrent: (candidate) =>
              Schema.decodeUnknownEffect(ExternalStockCorrelationSchema)({
                ...candidate,
                correlationRef: correlationRef(replacementCorrelationId),
              }).pipe(Effect.orDie),
          },
        }),
      );
      expect(Predicate.isTagged(failure, 'ExternalStockCorrelationRejected')).toBe(true);
      expect(failure.reason).toBe('CORRELATION_IDENTITY_CONFLICT');
      const material = collector.snapshot();
      expect(material.auditEvidence).toEqual({});
      expect(material.dataAccessEvents).toEqual([]);
    }),
  );
});
