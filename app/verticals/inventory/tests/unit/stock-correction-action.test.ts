import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';

import {
  StockCorrectionConflict,
  StockCorrectionIdSchema,
  StockCorrectionPayloadSchema,
  StockCorrectionRejected,
  StockCorrectionResultSchema,
  StockCorrectionUnavailable,
} from '../../shared/domain/stock-correction.ts';
import type { StockCorrectionService } from '../../src/services/stock-correction.service.ts';
import {
  correctStockPositionAction,
  handleCorrectStockPosition,
} from '../../src/actions/correct-stock-position.action.ts';
import { mapCorrectStockPositionActionProblem } from '../../api/correct-stock-position-action-problems.ts';

const correctionId = StockCorrectionIdSchema.make('33333333-3333-4333-8333-333333333333');
const tenantId = '11111111-1111-4111-8111-111111111111';
const positionId = '55555555-5555-4555-8555-555555555555';
const assertionId = '44444444-4444-4444-8444-444444444444';
const configurationId = '99999999-9999-4999-8999-999999999999';
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const positionRef = {
  moduleId: 'commerce.inventory',
  resourceId: positionId,
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
} as const;
const authorityConfigurationRef = {
  moduleId: 'commerce.inventory',
  resourceId: configurationId,
  resourceType: 'commerce.inventory.inventory-backend-configuration',
  tenantId,
} as const;
const payload = Schema.decodeUnknownSync(StockCorrectionPayloadSchema)({
  correctionId,
  customerConfigurationId: 'customer-configuration:primary',
  evidence: { _tag: 'EXTERNAL_SOURCE_ASSERTION', sourceAssertionId: assertionId },
  expectedPositionRevision: 3,
  positionRef,
  reason: { code: 'AUTHORITATIVE_COUNT', reference: 'count:42' },
});

const explanatoryDeltaFieldsFor = (state: 'APPLIED' | 'INDETERMINATE', materialChange: 'DECREASE' | 'UNCHANGED') =>
  Match.value(state).pipe(
    Match.when('INDETERMINATE', () => ({})),
    Match.when('APPLIED', () => ({ explanatoryDelta: materialChange === 'UNCHANGED' ? '0' : '-3' })),
    Match.exhaustive,
  );

const resultFor = (
  state: 'APPLIED' | 'INDETERMINATE',
  outcome: 'APPLIED' | 'EXACT_REPLAY' | 'RECONCILIATION_REQUIRED',
  materialChange: 'DECREASE' | 'UNCHANGED' = 'DECREASE',
) =>
  Schema.decodeUnknownSync(StockCorrectionResultSchema)({
    correction: {
      _tag: state,
      actionInvocationId: '13131313-1313-4131-8131-131313131313',
      appliedAt: '2026-09-24T12:00:00.000Z',
      authorityConfigurationRef,
      businessObservedAt: '2026-09-24T10:00:00.000Z',
      correctedQuantity: state === 'APPLIED' ? { amount: '7', unitRef } : undefined,
      correctionId,
      coverageEvidence: [],
      customerConfigurationId: 'customer-configuration:primary',
      evaluatedMaterialEffectIds: [],
      evidenceKind: 'EXTERNAL_SOURCE_ASSERTION',
      expectedPositionRevision: 3,
      ...explanatoryDeltaFieldsFor(state, materialChange),
      issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
      materialChange: state === 'APPLIED' ? materialChange : undefined,
      materialEffectIds: state === 'INDETERMINATE' ? [] : undefined,
      ownerEvidenceRef: 'erp-a:snapshot:42',
      positionRef,
      positionRevisionAfter: 4,
      previousOnHand: {
        _tag: 'CURRENT',
        evidenceRef: 'erp-a:snapshot:previous',
        meaning: 'ON_HAND',
        observedAt: '2026-09-23T10:00:00.000Z',
        ownerConfigurationRef: authorityConfigurationRef,
        quantity: { amount: '10', unitRef },
      },
      principalId: '12121212-1212-4121-8121-121212121212',
      reason: payload.reason,
      reasonCode: state === 'INDETERMINATE' ? 'MATERIAL_EFFECT_COVERAGE_MISSING' : undefined,
      reconcilesCorrectionId: null,
      sourceAssertionId: assertionId,
      sourceEvidenceId: null,
      sourceOrderingEvidence: { _tag: 'SOURCE_REVISION', revision: '42' },
      sourceReference: 'erp-a:warehouse:prague:snapshot:42',
    },
    outcome,
    position: {
      createdAt: '2026-09-01T00:00:00.000Z',
      endedAt: null,
      lifecycle: 'CURRENT',
      onHand:
        state === 'APPLIED'
          ? {
              _tag: 'CURRENT',
              evidenceRef: 'erp-a:snapshot:42',
              meaning: 'ON_HAND',
              observedAt: '2026-09-24T10:00:00.000Z',
              ownerConfigurationRef: authorityConfigurationRef,
              quantity: { amount: '7', unitRef },
            }
          : {
              _tag: 'INDETERMINATE',
              meaning: 'ON_HAND',
              ownerConfigurationRef: authorityConfigurationRef,
              unitRef,
            },
      ref: positionRef,
      revision: 4,
      scope: {
        customerConfigurationId: 'customer-configuration:primary',
        stockItemRef: {
          moduleId: 'commerce.inventory',
          resourceId: '66666666-6666-4666-8666-666666666666',
          resourceType: 'commerce.inventory.stock-item',
          tenantId,
        },
        stockLocationRef: {
          moduleId: 'commerce.inventory',
          resourceId: '77777777-7777-4777-8777-777777777777',
          resourceType: 'commerce.inventory.stock-location',
          tenantId,
        },
        unitRef,
      },
    },
  });

const runHandler = (result: ReturnType<typeof resultFor>) => {
  const collector = createActionCollector(
    correctStockPositionAction.descriptor.domainEvents,
    'commerce.inventory',
    correctStockPositionAction.descriptor.accessEvidencePolicy,
    correctStockPositionAction.descriptor.auditEvidenceSchema,
  );
  const services: StockCorrectionService = { correct: () => Effect.succeed(result) };
  return handleCorrectStockPosition(payload, {
    actionInvocationId: '13131313-1313-4131-8131-131313131313',
    addDomainEvent: collector.addDomainEvent,
    addOutboxMessage: collector.addOutboxMessage,
    recordAuditEvidence: collector.recordAuditEvidence,
    recordDataAccess: collector.recordDataAccess,
    scope: trustVerifiedGatewayPrincipalContext({
      authBindingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      authContextRef: 'test:stock-correction',
      authMethod: 'api_key',
      correlationId: 'stock-correction-test',
      principalId: '12121212-1212-4121-8121-121212121212',
      tenantId,
    }),
    services,
  }).pipe(Effect.map(() => collector.snapshot()));
};

describe('Correct Stock Position Action', () => {
  it('keeps correction tenant scoped, high-risk, idempotent, and exact-Position authorized', () => {
    expect(correctStockPositionAction.descriptor).toMatchObject({
      actionKey: 'commerce.inventory.correct-stock-position',
      idempotency: 'required',
      legalEntityScope: 'forbidden',
      owningModuleKey: 'commerce.inventory',
    });
    expect(correctStockPositionAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect(Object.keys(correctStockPositionAction.descriptor.domainEvents)).toEqual([
      'commerce.inventory.stock-position-corrected.v1',
      'commerce.inventory.stock-position-correction-indeterminate.v1',
      'commerce.inventory.stock-position-evidence-changed.v1',
    ]);
    expect(correctStockPositionAction.descriptor.auditEvidenceSchema).toBeDefined();
    expect(correctStockPositionAction.descriptor.auditProfile).toBe('sensitive');
  });

  for (const [state, outcome, materialChange, expectedEvents, expectedPublishedState] of [
    [
      'APPLIED',
      'APPLIED',
      'DECREASE',
      ['commerce.inventory.stock-position-corrected.v1', 'commerce.inventory.stock-position-evidence-changed.v1'],
      'CORRECTED',
    ],
    [
      'INDETERMINATE',
      'RECONCILIATION_REQUIRED',
      'DECREASE',
      [
        'commerce.inventory.stock-position-correction-indeterminate.v1',
        'commerce.inventory.stock-position-evidence-changed.v1',
      ],
      'INDETERMINATE',
    ],
    ['APPLIED', 'APPLIED', 'UNCHANGED', ['commerce.inventory.stock-position-corrected.v1'], null],
    ['APPLIED', 'EXACT_REPLAY', 'DECREASE', [], null],
  ] as const) {
    it.effect(`records bounded audit and Data Access evidence for ${outcome} without duplicate replay events`, () =>
      Effect.gen(function* actionEvidenceContract() {
        const material = yield* runHandler(resultFor(state, outcome, materialChange));
        expect(material.dataAccessEvents).toHaveLength(1);
        expect(material.dataAccessEvents[0]?.resultCount).toBe(outcome === 'EXACT_REPLAY' ? 1 : 0);
        expect(material.domainEvents.map(({ eventType }) => eventType)).toEqual(expectedEvents);
        expect(material.outboxMessages).toHaveLength(expectedPublishedState === null ? 0 : 1);
        if (expectedPublishedState !== null) {
          expect(material.outboxMessages[0]?.message).toMatchObject({
            payloadJson: {
              ordering: { _tag: 'OWNER_AGGREGATE_REVISION', revision: 4 },
              state: expectedPublishedState,
              subjectRef: positionRef,
            },
            topic: 'commerce.inventory.stock-position-evidence-changed.v1',
          });
        }
        expect(material.auditEvidence).toMatchObject({
          businessReasonCode: 'AUTHORITATIVE_COUNT',
          businessReasonReference: 'count:42',
          correctionId,
          evidenceIdentity: assertionId,
          evidenceKind: 'EXTERNAL_SOURCE_ASSERTION',
          outcome,
          ownerEvidenceRef: 'erp-a:snapshot:42',
          positionId,
        });
      }),
    );
  }

  it('maps identity/revision conflicts, semantic rejections, and unavailable authority without leaking causes', () => {
    expect(
      mapCorrectStockPositionActionProblem(
        new StockCorrectionConflict({
          code: 'stock_correction_conflict',
          correctionId,
          reason: 'CORRECTION_ID_CONFLICT',
        }),
      ).status,
    ).toBe(409);
    expect(
      mapCorrectStockPositionActionProblem(
        new StockCorrectionRejected({
          code: 'stock_correction_rejected',
          correctionId,
          reason: 'CORRECTION_NOT_PERMITTED',
        }),
      ).status,
    ).toBe(422);
    expect(
      mapCorrectStockPositionActionProblem(
        new StockCorrectionUnavailable({
          code: 'stock_correction_unavailable',
          correctionId,
          reason: 'private owner diagnostics',
          retryable: true,
        }),
      ),
    ).toMatchObject({ retryable: true, status: 503 });
  });
});
