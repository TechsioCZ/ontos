import { Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { InventorySourceAssertionSchema } from '../../shared/domain/inventory-source-assertion.ts';
import { InventorySourceImportLedgerEntrySchema } from '../../shared/domain/inventory-source-import-outcome.ts';
import { PhysicalStockEffectRecordSchema } from '../../shared/domain/physical-stock-effect.ts';
import {
  AppliedStockCorrectionSchema,
  IndeterminateStockCorrectionSchema,
  OntosWmsStockCorrectionSourceEvidenceSchema,
  StockCorrectionConflict,
  StockCorrectionIdSchema,
  StockCorrectionPayloadSchema,
} from '../../shared/domain/stock-correction.ts';
import type { StockCorrectionRecord } from '../../shared/domain/stock-correction.ts';
import {
  CurrentOnHandEvidenceSchema,
  IndeterminateOnHandEvidenceSchema,
  StockPositionSchema,
} from '../../shared/domain/stock-position.ts';
import type { StockCorrectionPersistence } from '../../src/services/stock-correction.service.ts';
import { makeStockCorrectionService } from '../../src/services/stock-correction.service.ts';
import type { ReservationShortageImpactService } from '../../src/services/reservation-shortage-impact.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principalId = '12121212-1212-4121-8121-121212121212';
const actionInvocationId = '13131313-1313-4131-8131-131313131313';
const correctionId = '33333333-3333-4333-8333-333333333333';
const assertionId = '44444444-4444-4444-8444-444444444444';
const positionId = '55555555-5555-4555-8555-555555555555';
const itemId = '66666666-6666-4666-8666-666666666666';
const locationId = '77777777-7777-4777-8777-777777777777';
const unitId = '88888888-8888-4888-8888-888888888888';
const configurationId = '99999999-9999-4999-8999-999999999999';
const effectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const observedAt = '2026-09-24T10:00:00.000Z';
const appliedAt = '2026-09-24T11:00:00.000Z';
const customerConfigurationId = 'customer-configuration:primary';

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const positionRef = {
  moduleId: 'commerce.inventory',
  resourceId: positionId,
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
} as const;
const itemRef = {
  moduleId: 'commerce.inventory',
  resourceId: itemId,
  resourceType: 'commerce.inventory.stock-item',
  tenantId,
} as const;
const locationRef = {
  moduleId: 'commerce.inventory',
  resourceId: locationId,
  resourceType: 'commerce.inventory.stock-location',
  tenantId,
} as const;
const configurationRef = {
  moduleId: 'commerce.inventory',
  resourceId: configurationId,
  resourceType: 'commerce.inventory.inventory-backend-configuration',
  tenantId,
} as const;

const configuration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId,
  customerConfigurationId,
  revision: 1,
  selectedAt: '2026-09-01T00:00:00.000Z',
  selection: {
    backend: 'external_business_system',
    backendId: 'erp-a',
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'SUPPORTED',
  },
  tenantId,
});

const initialPosition = Schema.decodeUnknownSync(StockPositionSchema)({
  createdAt: '2026-09-01T00:00:00.000Z',
  endedAt: null,
  lifecycle: 'CURRENT',
  onHand: {
    _tag: 'CURRENT',
    evidenceRef: 'erp-a:snapshot:previous',
    meaning: 'ON_HAND',
    observedAt: '2026-09-23T10:00:00.000Z',
    ownerConfigurationRef: configurationRef,
    quantity: { amount: '10', unitRef },
  },
  ref: positionRef,
  revision: 3,
  scope: { customerConfigurationId, stockItemRef: itemRef, stockLocationRef: locationRef, unitRef },
});

const assertion = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
  assertionId,
  authorityConfiguration: configuration,
  businessObservedAt: observedAt,
  coverage: [{ assertionId, effectId, ownerEvidenceRef: 'erp-a:coverage:issue-1', relation: 'INCLUDES' }],
  customerConfigurationId,
  factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
  issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
  issuerAuthority: 'SELECTED_BACKEND',
  itemCorrelationRef: {
    moduleId: 'commerce.inventory',
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    resourceType: 'commerce.inventory.external-stock-correlation',
    tenantId,
  },
  itemExternalKey: {
    customerConfigurationId,
    externalScope: 'warehouse:prague',
    externalValue: 'ITEM-1',
    identifierKind: 'ITEM',
    issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
    namespace: 'inventory',
    tenantId,
  },
  locationCorrelationRef: {
    moduleId: 'commerce.inventory',
    resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    resourceType: 'commerce.inventory.external-stock-correlation',
    tenantId,
  },
  locationExternalKey: {
    customerConfigurationId,
    externalScope: 'warehouse:prague',
    externalValue: 'LOCATION-1',
    identifierKind: 'LOCATION',
    issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
    namespace: 'inventory',
    tenantId,
  },
  orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '42' },
  ownerEvidenceRef: 'erp-a:snapshot:42',
  positionRef,
  quantity: { amount: '7', unitRef },
  receivedAt: '2026-09-24T12:00:00.000Z',
  sourceReference: 'erp-a:warehouse:prague:snapshot:42',
  stockItemRef: itemRef,
  stockLocationRef: locationRef,
});

const effect = Schema.decodeUnknownSync(PhysicalStockEffectRecordSchema)({
  _tag: 'APPLIED',
  evidence: {
    appliedAt,
    backend: 'external_business_system',
    backendConfigurationRef: configurationRef,
    backendEvidenceRef: 'erp-a:issue:1',
    backendId: 'erp-a',
    effectId,
    issuer: 'erp-a',
    kind: 'ISSUE',
    positionRef,
    quantity: { amount: '3', unitRef },
  },
  request: {
    actionInvocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    backend: 'external_business_system',
    backendConfigurationRef: configurationRef,
    backendId: 'erp-a',
    customerConfigurationId,
    effectId,
    kind: 'ISSUE',
    legalEntityId,
    positionRef,
    quantity: { amount: '3', unitRef },
    reason: { code: 'ORDER_FULFILLMENT', reference: 'order:42' },
    requestedAt: '2026-09-24T10:30:00.000Z',
    stockItemRef: itemRef,
    stockLocationRef: locationRef,
  },
});

const payload = Schema.decodeUnknownSync(StockCorrectionPayloadSchema)({
  correctionId,
  customerConfigurationId,
  evidence: { _tag: 'EXTERNAL_SOURCE_ASSERTION', sourceAssertionId: assertionId },
  expectedPositionRevision: 3,
  positionRef,
  reason: { code: 'AUTHORITATIVE_COUNT', reference: 'count:42' },
});

const acceptedAssertion = Schema.decodeUnknownSync(InventorySourceImportLedgerEntrySchema)({
  actionInvocationId: '20202020-2020-4020-8020-202020202020',
  itemIndex: 0,
  outcome: { assertionId, postEffectOnHand: assertion.quantity, status: 'ACCEPTED' },
  proposal: assertion,
});
const noReservationImpacts: ReservationShortageImpactService = { evaluate: () => Effect.void };

/* oxlint-disable sonarjs/no-nested-functions -- In-memory owner ports keep the public Stock Correction service seam explicit; expires: 2027-03-31. */
const makeHarness = (
  sourceAssertion = assertion,
  effects = [effect],
  selectedConfiguration = configuration,
  acceptedHistory = [acceptedAssertion],
  wmsEvidence?: typeof OntosWmsStockCorrectionSourceEvidenceSchema.Type,
  impacts: ReservationShortageImpactService = noReservationImpacts,
) =>
  Effect.gen(function* memoryHarness() {
    const position = yield* Ref.make(initialPosition);
    const records = yield* Ref.make<readonly StockCorrectionRecord[]>([]);
    const applyCount = yield* Ref.make(0);
    const corrections: StockCorrectionPersistence = {
      apply: (record, nextPosition) =>
        Effect.gen(function* applyInMemory() {
          const all = yield* Ref.get(records);
          const existing = all.find((entry) => entry.correctionId === record.correctionId);
          if (existing !== undefined) {
            return { correction: existing, outcome: 'EXISTING' as const, position: yield* Ref.get(position) };
          }
          yield* Ref.set(records, [...all, record]);
          yield* Ref.update(applyCount, (count) => count + 1);
          yield* Ref.set(position, nextPosition);
          return { correction: record, outcome: 'INSERTED' as const, position: nextPosition };
        }),
      findOpenIndeterminate: (ref) =>
        Ref.get(records).pipe(
          Effect.map((all) =>
            Option.fromNullishOr(
              all.find(
                (entry) =>
                  entry.positionRef.resourceId === ref.resourceId &&
                  Schema.is(IndeterminateStockCorrectionSchema)(entry),
              ),
            ),
          ),
        ),
      listAppliedEffectsForPosition: () => Effect.succeed(effects),
      read: (id) =>
        Ref.get(records).pipe(
          Effect.map((all) => Option.fromNullishOr(all.find((entry) => entry.correctionId === id))),
        ),
    };
    const service = makeStockCorrectionService({
      assertions: { findById: () => Effect.succeed(Option.some(sourceAssertion)) },
      backendConfigurations: { findCurrent: () => Effect.succeed(Option.some(selectedConfiguration)) },
      corrections,
      impacts,
      positions: { read: () => Ref.get(position).pipe(Effect.map(Option.some)) },
      sourceEvidence: { findCurrentById: () => Effect.succeed(Option.fromNullishOr(wmsEvidence)) },
      sourceImports: { lockAndReadAcceptedHistory: () => Effect.succeed(acceptedHistory) },
    });
    return { applyCount, records, service };
  });

describe('Stock Correction', () => {
  it.effect('evaluates Reservation shortage impact after an applied Correction and on exact replay', () =>
    Effect.gen(function* evaluateReservationImpact() {
      const evaluatedChanges: string[] = [];
      const { service } = yield* makeHarness(assertion, [effect], configuration, [acceptedAssertion], undefined, {
        evaluate: (trigger) => {
          evaluatedChanges.push(trigger.changeId);
          return Effect.void;
        },
      });

      yield* service.correct(payload, { actionInvocationId, principalId, tenantId });
      yield* service.correct(payload, {
        actionInvocationId: '14141414-1414-4141-8141-141414141414',
        principalId,
        tenantId,
      });

      expect(evaluatedChanges).toEqual([correctionId, correctionId]);
    }),
  );

  it.effect('does not evaluate shortage impact for an unchanged authoritative Correction', () =>
    Effect.gen(function* skipUnchangedCorrection() {
      const unchangedAssertion = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
        ...assertion,
        quantity: { amount: '10', unitRef },
      });
      const unchangedAccepted = Schema.decodeUnknownSync(InventorySourceImportLedgerEntrySchema)({
        ...acceptedAssertion,
        outcome: { assertionId, postEffectOnHand: unchangedAssertion.quantity, status: 'ACCEPTED' },
        proposal: unchangedAssertion,
      });
      const evaluatedChanges: string[] = [];
      const { service } = yield* makeHarness(
        unchangedAssertion,
        [effect],
        configuration,
        [unchangedAccepted],
        undefined,
        {
          evaluate: (trigger) => {
            evaluatedChanges.push(trigger.changeId);
            return Effect.void;
          },
        },
      );

      const applied = yield* service.correct(payload, { actionInvocationId, principalId, tenantId });
      yield* service.correct(payload, {
        actionInvocationId: '14141414-1414-4141-8141-141414141414',
        principalId,
        tenantId,
      });

      expect(Schema.is(AppliedStockCorrectionSchema)(applied.correction)).toBe(true);
      if (Schema.is(AppliedStockCorrectionSchema)(applied.correction)) {
        expect(applied.correction.materialChange).toBe('UNCHANGED');
      }
      expect(evaluatedChanges).toEqual([]);
    }),
  );

  it.effect('establishes absolute Current ON_HAND and stores the signed delta only as explanation', () =>
    Effect.gen(function* correctAbsoluteQuantity() {
      const { service } = yield* makeHarness();
      const result = yield* service.correct(payload, { actionInvocationId, principalId, tenantId });

      expect(result.outcome).toBe('APPLIED');
      expect(Schema.is(CurrentOnHandEvidenceSchema)(result.position.onHand)).toBe(true);
      expect(Schema.is(AppliedStockCorrectionSchema)(result.correction)).toBe(true);
      if (Schema.is(CurrentOnHandEvidenceSchema)(result.position.onHand)) {
        expect(result.position.onHand.quantity).toEqual({ amount: '7', unitRef });
      }
      if (Schema.is(AppliedStockCorrectionSchema)(result.correction)) {
        expect(result.correction.correctedQuantity).toEqual({ amount: '7', unitRef });
        expect(result.correction.explanatoryDelta).toBe('-3');
        expect(result.correction.materialChange).toBe('DECREASE');
        expect(result.correction.sourceAssertionId).toBe(assertionId);
        expect(result.correction.sourceOrderingEvidence).toEqual(assertion.orderingEvidence);
      }
      expect(result.position.revision).toBe(4);
    }),
  );

  it.effect('marks Current ON_HAND indeterminate when intervening material coverage is missing', () =>
    Effect.gen(function* requireReconciliation() {
      const withoutCoverage = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({ ...assertion, coverage: [] });
      const { service } = yield* makeHarness(withoutCoverage);
      const result = yield* service.correct(payload, { actionInvocationId, principalId, tenantId });

      expect(result.outcome).toBe('RECONCILIATION_REQUIRED');
      expect(Schema.is(IndeterminateOnHandEvidenceSchema)(result.position.onHand)).toBe(true);
      expect(Schema.is(IndeterminateStockCorrectionSchema)(result.correction)).toBe(true);
      if (Schema.is(IndeterminateStockCorrectionSchema)(result.correction)) {
        expect(result.correction.materialEffectIds).toEqual([effectId]);
        expect(result.correction.reasonCode).toBe('MATERIAL_EFFECT_COVERAGE_MISSING');
      }
      expect('correctedQuantity' in result.correction).toBe(false);
    }),
  );

  it.effect('does not establish a stale absolute value when evidence excludes an intervening Issue', () =>
    Effect.gen(function* rejectStaleAbsoluteValue() {
      const excluded = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
        ...assertion,
        coverage: [{ ...assertion.coverage[0], relation: 'EXCLUDES' }],
      });
      const { service } = yield* makeHarness(excluded);
      const result = yield* service.correct(payload, { actionInvocationId, principalId, tenantId });

      expect(result.outcome).toBe('RECONCILIATION_REQUIRED');
      expect(Schema.is(IndeterminateOnHandEvidenceSchema)(result.position.onHand)).toBe(true);
      expect(Schema.is(IndeterminateStockCorrectionSchema)(result.correction)).toBe(true);
      if (Schema.is(IndeterminateStockCorrectionSchema)(result.correction)) {
        expect(result.correction.reasonCode).toBe('MATERIAL_EFFECT_EXCLUDED_OR_PREDATED');
      }
    }),
  );

  it.effect('replays the exact Correction identity and conflicts on changed intent', () =>
    Effect.gen(function* exactRetry() {
      const { applyCount, service } = yield* makeHarness();
      yield* service.correct(payload, { actionInvocationId, principalId, tenantId });
      const replay = yield* service.correct(payload, {
        actionInvocationId: '14141414-1414-4141-8141-141414141414',
        principalId,
        tenantId,
      });
      expect(replay.outcome).toBe('EXACT_REPLAY');
      expect(replay.correction.actionInvocationId).toBe(actionInvocationId);
      expect(yield* Ref.get(applyCount)).toBe(1);

      const failure = yield* service
        .correct(
          { ...payload, reason: { ...payload.reason, reference: 'count:changed' } },
          { actionInvocationId, principalId, tenantId },
        )
        .pipe(Effect.flip);
      expect(Schema.is(StockCorrectionConflict)(failure)).toBe(true);
      expect(failure.reason).toBe('CORRECTION_ID_CONFLICT');
    }),
  );

  it.effect('rejects an accepted external assertion after a newer owner revision is accepted', () =>
    Effect.gen(function* rejectStaleAcceptedAssertion() {
      const newerAssertionId = '21212121-2121-4121-8121-212121212121';
      const newer = Schema.decodeUnknownSync(InventorySourceImportLedgerEntrySchema)({
        actionInvocationId: '22222222-2222-4222-8222-222222222223',
        itemIndex: 0,
        outcome: { assertionId: newerAssertionId, postEffectOnHand: assertion.quantity, status: 'ACCEPTED' },
        proposal: {
          ...assertion,
          assertionId: newerAssertionId,
          coverage: assertion.coverage.map((entry) => ({ ...entry, assertionId: newerAssertionId })),
          orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '43' },
          sourceReference: 'erp-a:warehouse:prague:snapshot:43',
        },
      });
      const { service } = yield* makeHarness(assertion, [], configuration, [acceptedAssertion, newer]);
      const failure = yield* service.correct(payload, { actionInvocationId, principalId, tenantId }).pipe(Effect.flip);

      expect(failure.reason).toBe('SOURCE_ASSERTION_NOT_CURRENT');
    }),
  );

  it.effect('uses only opaque current OntOS WMS owner evidence for an absolute correction', () =>
    Effect.gen(function* correctFromWmsOwnerEvidence() {
      const evidenceId = '23232323-2323-4323-8323-232323232323';
      const wmsConfiguration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
        ...configuration,
        selection: {
          backend: 'ontos_wms',
          backendId: 'ontos-wms-primary',
          exactReservationCapability: 'SUPPORTED',
          stockCorrectionCapability: 'SUPPORTED',
        },
      });
      const wmsEvidence = Schema.decodeUnknownSync(OntosWmsStockCorrectionSourceEvidenceSchema)({
        authorityConfiguration: wmsConfiguration,
        businessObservedAt: observedAt,
        coverage: [],
        customerConfigurationId,
        evidenceId,
        factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
        issuer: { backendId: 'ontos-wms-primary', backendKind: 'ontos_wms' },
        orderingEvidence: { _tag: 'OWNER_ORDER_KEY', key: 'count-sequence:42' },
        ownerEvidenceRef: 'ontos-wms:count:42',
        positionRef,
        quantity: { amount: '7', unitRef },
        receivedAt: '2026-09-24T12:00:00.000Z',
        sourceReference: 'ontos-wms:warehouse:prague:count:42',
        stockItemRef: itemRef,
        stockLocationRef: locationRef,
      });
      const wmsPayload = Schema.decodeUnknownSync(StockCorrectionPayloadSchema)({
        ...payload,
        evidence: { _tag: 'ONTOS_WMS_OWNER_EVIDENCE', evidenceId },
      });
      const { service } = yield* makeHarness(assertion, [], wmsConfiguration, [], wmsEvidence);
      const result = yield* service.correct(wmsPayload, { actionInvocationId, principalId, tenantId });

      expect(result.outcome).toBe('APPLIED');
      expect(result.correction.evidenceKind).toBe('ONTOS_WMS_OWNER_EVIDENCE');
      expect(result.correction.sourceAssertionId).toBeNull();
      expect(result.correction.sourceEvidenceId).toBe(evidenceId);
      expect(result.correction.sourceOrderingEvidence).toEqual(wmsEvidence.orderingEvidence);
      if (Schema.is(CurrentOnHandEvidenceSchema)(result.position.onHand)) {
        expect(result.position.onHand.quantity.amount).toBe('7');
        expect(result.position.onHand.evidenceRef).toBe('ontos-wms:count:42');
      }
    }),
  );

  it.effect('fails closed on foreign Tenant, stale revision, wrong Unit, and unselected authority', () =>
    Effect.gen(function* failClosedScopeAndAuthority() {
      const { service } = yield* makeHarness();
      const foreignTenant = yield* service
        .correct(
          { ...payload, positionRef: { ...payload.positionRef, tenantId: '15151515-1515-4151-8151-151515151515' } },
          { actionInvocationId, principalId, tenantId },
        )
        .pipe(Effect.flip);
      expect(foreignTenant.reason).toBe('TENANT_SCOPE_MISMATCH');

      const staleRevision = yield* service
        .correct({ ...payload, expectedPositionRevision: 2 }, { actionInvocationId, principalId, tenantId })
        .pipe(Effect.flip);
      expect(staleRevision.reason).toBe('POSITION_REVISION_CONFLICT');

      const wrongUnitAssertion = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
        ...assertion,
        quantity: {
          amount: '7',
          unitRef: { ...unitRef, resourceId: '16161616-1616-4161-8161-161616161616' },
        },
      });
      const wrongUnit = yield* (yield* makeHarness(wrongUnitAssertion, [])).service
        .correct(payload, { actionInvocationId, principalId, tenantId })
        .pipe(Effect.flip);
      expect(wrongUnit.reason).toBe('UNIT_MISMATCH');

      const unselectedAuthority = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
        ...assertion,
        authorityConfiguration: {
          ...configuration,
          configurationId: '17171717-1717-4171-8171-171717171717',
        },
      });
      const unsupported = yield* (yield* makeHarness(unselectedAuthority, [])).service
        .correct(payload, { actionInvocationId, principalId, tenantId })
        .pipe(Effect.flip);
      expect(unsupported.reason).toBe('CORRECTION_NOT_PERMITTED');

      const disabledConfiguration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
        ...configuration,
        selection: { ...configuration.selection, stockCorrectionCapability: 'UNSUPPORTED' },
      });
      const disabled = yield* (yield* makeHarness(assertion, [], disabledConfiguration)).service
        .correct(payload, { actionInvocationId, principalId, tenantId })
        .pipe(Effect.flip);
      expect(disabled.reason).toBe('CORRECTION_NOT_PERMITTED');
    }),
  );

  it.effect('requires explicit reconciliation before a fresh Correction identity', () =>
    Effect.gen(function* blockFreshMutation() {
      const withoutCoverage = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({ ...assertion, coverage: [] });
      const { service } = yield* makeHarness(withoutCoverage);
      const first = yield* service.correct(payload, { actionInvocationId, principalId, tenantId });
      expect(first.outcome).toBe('RECONCILIATION_REQUIRED');

      const fresh = yield* service
        .correct(
          {
            ...payload,
            correctionId: StockCorrectionIdSchema.make('18181818-1818-4181-8181-181818181818'),
            expectedPositionRevision: 4,
          },
          { actionInvocationId: '19191919-1919-4191-8191-191919191919', principalId, tenantId },
        )
        .pipe(Effect.flip);
      expect(fresh.reason).toBe('OPEN_RECONCILIATION_MISMATCH');
    }),
  );

  it('does not accept caller-supplied authority, coverage, or WMS quantity', () => {
    const decodeStrict = Schema.decodeUnknownSync(StockCorrectionPayloadSchema, { onExcessProperty: 'error' });
    expect(() => decodeStrict({ ...payload, quantity: { amount: '-1', unitRef } })).toThrow();
    expect(() =>
      decodeStrict({
        ...payload,
        evidence: {
          _tag: 'ONTOS_WMS_OWNER_EVIDENCE',
          correctedQuantity: { amount: '7', unitRef },
          evidenceId: '23232323-2323-4323-8323-232323232323',
        },
      }),
    ).toThrow();
  });
});
/* oxlint-enable sonarjs/no-nested-functions */
