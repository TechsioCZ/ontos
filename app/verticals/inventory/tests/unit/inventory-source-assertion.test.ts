import { Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  DeterminateInventorySourceAssertionEvaluationSchema,
  HistoricalInventorySourceAssertionEvaluationSchema,
  IndeterminateInventorySourceAssertionEvaluationSchema,
  InventorySourceAssertionRejected,
  InventorySourceAssertionProposalSchema,
  InventorySourceAssertionSchema,
  SourceRevisionOrderingEvidenceSchema,
} from '../../shared/domain/inventory-source-assertion.ts';
import type {
  InventorySourceAssertion,
  InventorySourceAssertionPersistence,
} from '../../shared/domain/inventory-source-assertion.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { ExternalStockCorrelationResolutionSchema } from '../../shared/domain/external-stock-correlation.ts';
import type { ExternalStockCorrelationResolution } from '../../shared/domain/external-stock-correlation.ts';
import { PhysicalStockEffectRecordSchema } from '../../shared/domain/physical-stock-effect.ts';
import { StockPositionSchema } from '../../shared/domain/stock-position.ts';
import { makeInventorySourceAssertionEvaluator } from '../../src/domain/inventory-source-assertion-evaluator.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const assertionId = '22222222-2222-4222-8222-222222222222';
const positionId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const locationId = '55555555-5555-4555-8555-555555555555';
const unitId = '66666666-6666-4666-8666-666666666666';
const configurationId = '77777777-7777-4777-8777-777777777777';
const issueId = '88888888-8888-4888-8888-888888888888';
const receiptId = '99999999-9999-4999-8999-999999999999';
const itemCorrelationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const locationCorrelationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const observedAt = '2026-09-24T10:00:00.000Z';
const receivedAt = '2026-09-24T12:00:00.000Z';
const customerConfigurationId = 'customer-configuration:primary';

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
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
const positionRef = {
  moduleId: 'commerce.inventory',
  resourceId: positionId,
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
} as const;

const configuration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId,
  customerConfigurationId,
  revision: 1,
  selectedAt: observedAt,
  selection: {
    backend: 'external_business_system',
    backendId: 'erp-a',
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'UNSUPPORTED',
  },
  tenantId,
});

const position = Schema.decodeUnknownSync(StockPositionSchema)({
  createdAt: observedAt,
  endedAt: null,
  lifecycle: 'CURRENT',
  onHand: {
    _tag: 'CURRENT',
    evidenceRef: 'erp-a:on-hand:previous',
    meaning: 'ON_HAND',
    observedAt,
    ownerConfigurationRef: {
      moduleId: 'commerce.inventory',
      resourceId: configurationId,
      resourceType: 'commerce.inventory.inventory-backend-configuration',
      tenantId,
    },
    quantity: { amount: '10', unitRef },
  },
  ref: positionRef,
  revision: 1,
  scope: { customerConfigurationId, stockItemRef: itemRef, stockLocationRef: locationRef, unitRef },
});

const externalKey = (identifierKind: 'ITEM' | 'LOCATION') => ({
  customerConfigurationId,
  externalScope: 'warehouse:prague',
  externalValue: identifierKind === 'ITEM' ? 'ITEM-123' : 'LOC-123',
  identifierKind,
  issuer: { backendId: 'erp-a', backendKind: 'external_business_system' as const },
  namespace: 'inventory',
  tenantId,
});

const decodeProposal = Schema.decodeUnknownSync(InventorySourceAssertionProposalSchema, {
  onExcessProperty: 'error',
});
const proposal = (coverage: readonly unknown[] = []) =>
  decodeProposal({
    assertionId,
    businessObservedAt: observedAt,
    coverage,
    customerConfigurationId,
    factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
    issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
    itemExternalKey: externalKey('ITEM'),
    locationExternalKey: externalKey('LOCATION'),
    orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '000042' },
    ownerEvidenceRef: 'erp-a:snapshot:42',
    positionRef,
    quantity: { amount: '10', unitRef },
    receivedAt,
    sourceReference: 'erp-a:warehouse:prague:snapshot:42',
  });

const effect = (effectId: string, kind: 'ISSUE' | 'RECEIPT') =>
  Schema.decodeUnknownSync(PhysicalStockEffectRecordSchema)({
    _tag: 'APPLIED',
    evidence: {
      appliedAt: '2026-09-24T11:00:00.000Z',
      backend: 'external_business_system',
      backendConfigurationRef: {
        moduleId: 'commerce.inventory',
        resourceId: configurationId,
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId,
      },
      backendEvidenceRef: `erp-a:${kind.toLowerCase()}:42`,
      backendId: 'erp-a',
      effectId,
      issuer: 'erp-a',
      kind,
      positionRef,
      quantity: { amount: kind === 'ISSUE' ? '2' : '5', unitRef },
    },
    request: {
      actionInvocationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      backend: 'external_business_system',
      backendConfigurationRef: {
        moduleId: 'commerce.inventory',
        resourceId: configurationId,
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId,
      },
      backendId: 'erp-a',
      customerConfigurationId,
      effectId,
      kind,
      legalEntityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      positionRef,
      quantity: { amount: kind === 'ISSUE' ? '2' : '5', unitRef },
      reason: { code: 'ORDER_FULFILLMENT', reference: 'order:42/line:1' },
      requestedAt: '2026-09-24T10:30:00.000Z',
      stockItemRef: itemRef,
      stockLocationRef: locationRef,
    },
  });

const resolved = (kind: 'ITEM' | 'LOCATION', selected = true): ExternalStockCorrelationResolution =>
  Schema.decodeUnknownSync(ExternalStockCorrelationResolutionSchema)({
    _tag: 'RESOLVED',
    correlationRef: {
      moduleId: 'commerce.inventory',
      resourceId: kind === 'ITEM' ? itemCorrelationId : locationCorrelationId,
      resourceType: 'commerce.inventory.external-stock-correlation',
      tenantId,
    },
    effectivePeriod: { from: '2026-01-01T00:00:00.000Z', to: null },
    externalKey: externalKey(kind),
    selectedBackendOriginMatch: selected ? 'MATCHES_SELECTED_BACKEND' : 'OUTSIDE_SELECTED_BACKEND',
    target: kind === 'ITEM' ? { _tag: 'STOCK_ITEM', ref: itemRef } : { _tag: 'STOCK_LOCATION', ref: locationRef },
  });

/* oxlint-disable sonarjs/no-nested-functions -- In-memory owner ports keep the public evaluation seam explicit; expires: 2027-03-31. */
const makePersistence = () =>
  Effect.gen(function* makeMemoryPersistence() {
    const stored = yield* Ref.make<readonly InventorySourceAssertion[]>([]);
    const persistence: InventorySourceAssertionPersistence = {
      append: (assertion) => Ref.update(stored, (all) => [...all, assertion]).pipe(Effect.as(assertion)),
      findById: (id) =>
        Ref.get(stored).pipe(Effect.map((all) => Option.fromNullishOr(all.find((entry) => entry.assertionId === id)))),
    };
    return { persistence, stored };
  });

const makeEvaluator = (
  persistence: InventorySourceAssertionPersistence,
  effects: readonly ReturnType<typeof effect>[] = [],
  selected = true,
) =>
  makeInventorySourceAssertionEvaluator({
    correlations: {
      resolve: ({ externalKey: key }) => Effect.succeed(resolved(key.identifierKind, selected)),
    },
    effects: { listAppliedForPosition: () => Effect.succeed(effects) },
    persistence,
    positions: { read: () => Effect.succeed(Option.some(position)) },
  });
/* oxlint-enable sonarjs/no-nested-functions */

describe('Inventory Source Assertion quantity and Source Coverage Evidence', () => {
  it('accepts only absolute physical ON_HAND with exact Quantity, Unit, business time, ordering, and provenance', () => {
    const assertion = proposal();
    expect(assertion.factMeaning).toBe('ABSOLUTE_PHYSICAL_ON_HAND');
    expect(assertion.quantity).toEqual({ amount: '10', unitRef });
    expect(assertion.businessObservedAt).toBe(observedAt);
    expect(assertion.receivedAt).toBe(receivedAt);
    expect(Schema.is(SourceRevisionOrderingEvidenceSchema)(assertion.orderingEvidence)).toBe(true);
    if (Schema.is(SourceRevisionOrderingEvidenceSchema)(assertion.orderingEvidence)) {
      expect(assertion.orderingEvidence.revision).toBe('000042');
    }
    expect(() => decodeProposal({ ...assertion, factMeaning: 'DELTA' })).toThrow();
    expect(() =>
      decodeProposal({
        ...assertion,
        quantity: {
          amount: '10',
          unitRef: { ...unitRef, tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
        },
      }),
    ).toThrow();
  });

  it.effect('resolves issuer-qualified Item and Location at business time, never arrival time', () =>
    Effect.gen(function* resolveAtBusinessTime() {
      const seenTimes: string[] = [];
      const { persistence } = yield* makePersistence();
      const evaluator = makeInventorySourceAssertionEvaluator({
        correlations: {
          resolve: (input) => {
            seenTimes.push(input.asOf);
            return Effect.succeed(resolved(input.externalKey.identifierKind));
          },
        },
        effects: { listAppliedForPosition: () => Effect.succeed([]) },
        persistence,
        positions: { read: () => Effect.succeed(Option.some(position)) },
      });

      const result = yield* evaluator.evaluate({ proposal: proposal(), selectedConfiguration: configuration });

      expect(seenTimes).toEqual([observedAt, observedAt]);
      expect(Schema.is(DeterminateInventorySourceAssertionEvaluationSchema)(result)).toBe(true);
      expect(result.assertion.authorityConfiguration).toEqual(configuration);
      expect(result.assertion.itemCorrelationRef.resourceId).toBe(itemCorrelationId);
      expect(result.assertion.locationCorrelationRef.resourceId).toBe(locationCorrelationId);
      expect(result.postEffectOnHand).toEqual({ amount: '10', unitRef });
    }),
  );

  it.effect('keeps late pre-cutover issuer evidence historical and never re-qualifies it as Current', () =>
    Effect.gen(function* retainActualIssuer() {
      const { persistence } = yield* makePersistence();
      const replacementConfiguration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
        ...configuration,
        configurationId: 'abababab-abab-4bab-8bab-abababababab',
        selection: { ...configuration.selection, backendId: 'erp-b' },
      });
      const result = yield* makeEvaluator(persistence, [effect(issueId, 'ISSUE')], false).evaluate({
        proposal: proposal(),
        selectedConfiguration: replacementConfiguration,
      });

      expect(Schema.is(HistoricalInventorySourceAssertionEvaluationSchema)(result)).toBe(true);
      expect(result.assertion.issuer).toEqual({ backendId: 'erp-a', backendKind: 'external_business_system' });
      expect(result.assertion.authorityConfiguration).toEqual(replacementConfiguration);
      expect(result.postEffectOnHand).toBeNull();
      expect(result.reconciliationRequired).toBe(false);
    }),
  );

  it.effect('keeps same-issuer evidence before backend selection historical by business time', () =>
    Effect.gen(function* preSelectionEvidence() {
      const { persistence } = yield* makePersistence();
      const laterSelection = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
        ...configuration,
        selectedAt: '2026-09-24T11:00:00.000Z',
      });

      const result = yield* makeEvaluator(persistence).evaluate({
        proposal: proposal(),
        selectedConfiguration: laterSelection,
      });

      expect(Schema.is(HistoricalInventorySourceAssertionEvaluationSchema)(result)).toBe(true);
      expect(result.assertion.issuerAuthority).toBe('HISTORICAL_PRE_CUTOVER_ISSUER');
      expect(result.postEffectOnHand).toBeNull();
    }),
  );

  it.effect('compares offset business time chronologically instead of lexicographically', () =>
    Effect.gen(function* offsetBusinessTime() {
      const { persistence } = yield* makePersistence();
      const result = yield* makeEvaluator(persistence).evaluate({
        proposal: decodeProposal({
          ...proposal(),
          businessObservedAt: '2026-09-24T11:00:00.000+02:00',
        }),
        selectedConfiguration: configuration,
      });

      expect(Schema.is(HistoricalInventorySourceAssertionEvaluationSchema)(result)).toBe(true);
      expect(result.assertion.issuerAuthority).toBe('HISTORICAL_PRE_CUTOVER_ISSUER');
      expect(result.postEffectOnHand).toBeNull();
    }),
  );

  it.effect('does not subtract an Issue already included by owner-valid coverage evidence', () =>
    Effect.gen(function* includedIssue() {
      const { persistence } = yield* makePersistence();
      const result = yield* makeEvaluator(persistence, [effect(issueId, 'ISSUE')]).evaluate({
        proposal: proposal([
          {
            assertionId,
            effectId: issueId,
            ownerEvidenceRef: 'erp-a:coverage:issue-42',
            relation: 'INCLUDES',
          },
        ]),
        selectedConfiguration: configuration,
      });

      expect(Schema.is(DeterminateInventorySourceAssertionEvaluationSchema)(result)).toBe(true);
      expect(result.postEffectOnHand).toEqual({ amount: '10', unitRef });
      expect(result).not.toHaveProperty('arithmeticAdjustment');
    }),
  );

  it.effect('keeps a snapshot that predates a known Receipt historical without adding it twice', () =>
    Effect.gen(function* predatingReceipt() {
      const { persistence } = yield* makePersistence();
      const result = yield* makeEvaluator(persistence, [effect(receiptId, 'RECEIPT')]).evaluate({
        proposal: proposal([
          {
            assertionId,
            effectId: receiptId,
            ownerEvidenceRef: 'erp-a:coverage:receipt-42',
            relation: 'PREDATES',
          },
        ]),
        selectedConfiguration: configuration,
      });

      expect(Schema.is(HistoricalInventorySourceAssertionEvaluationSchema)(result)).toBe(true);
      expect(result.postEffectOnHand).toBeNull();
      expect(result.assertion.quantity.amount).toBe('10');
    }),
  );

  it.effect('returns explicit INDETERMINATE when material coverage is unknown or missing', () =>
    Effect.gen(function* unknownCoverage() {
      const { persistence } = yield* makePersistence();
      const evaluator = makeEvaluator(persistence, [effect(issueId, 'ISSUE')]);
      const unknown = yield* evaluator.evaluate({
        proposal: proposal([
          { assertionId, effectId: issueId, ownerEvidenceRef: 'erp-a:coverage:unknown', relation: 'UNKNOWN' },
        ]),
        selectedConfiguration: configuration,
      });
      const missing = yield* evaluator.evaluate({
        proposal: decodeProposal({ ...proposal(), assertionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }),
        selectedConfiguration: configuration,
      });

      expect(Schema.is(IndeterminateInventorySourceAssertionEvaluationSchema)(unknown)).toBe(true);
      expect(Schema.is(IndeterminateInventorySourceAssertionEvaluationSchema)(missing)).toBe(true);
      if (
        Schema.is(IndeterminateInventorySourceAssertionEvaluationSchema)(unknown) &&
        Schema.is(IndeterminateInventorySourceAssertionEvaluationSchema)(missing)
      ) {
        expect(unknown).toMatchObject({ postEffectOnHand: null, reconciliationRequired: true });
        expect(missing).toMatchObject({ postEffectOnHand: null, reconciliationRequired: true });
        expect(unknown.reason).toBe('MATERIAL_EFFECT_COVERAGE_UNKNOWN');
        expect(missing.reason).toBe('MATERIAL_EFFECT_COVERAGE_MISSING');
      }
    }),
  );

  it.effect('fails typed when correlation or exact Position scope disagrees', () =>
    Effect.gen(function* rejectWrongScope() {
      const { persistence } = yield* makePersistence();
      const evaluator = makeInventorySourceAssertionEvaluator({
        correlations: {
          resolve: ({ externalKey: key }) =>
            Effect.succeed(
              key.identifierKind === 'ITEM'
                ? resolved('ITEM')
                : {
                    ...resolved('LOCATION'),
                    target: { _tag: 'STOCK_LOCATION', ref: { ...locationRef, resourceId: itemId } },
                  },
            ),
        },
        effects: { listAppliedForPosition: () => Effect.succeed([]) },
        persistence,
        positions: { read: () => Effect.succeed(Option.some(position)) },
      });

      const failure = yield* Effect.flip(
        evaluator.evaluate({ proposal: proposal(), selectedConfiguration: configuration }),
      );
      expect(Schema.is(InventorySourceAssertionRejected)(failure)).toBe(true);
      expect(failure.reason).toBe('POSITION_SCOPE_MISMATCH');
    }),
  );

  it.effect('does not persist coverage that references a nonexistent material effect', () =>
    Effect.gen(function* rejectBeforeAppend() {
      const { persistence, stored } = yield* makePersistence();
      const failure = yield* makeEvaluator(persistence, [effect(issueId, 'ISSUE')])
        .evaluate({
          proposal: proposal([
            {
              assertionId,
              effectId: receiptId,
              ownerEvidenceRef: 'erp-a:coverage:not-known',
              relation: 'INCLUDES',
            },
          ]),
          selectedConfiguration: configuration,
        })
        .pipe(Effect.flip);

      expect(Schema.is(InventorySourceAssertionRejected)(failure)).toBe(true);
      expect(failure.reason).toBe('COVERAGE_EFFECT_NOT_FOUND');
      expect(yield* Ref.get(stored)).toEqual([]);
    }),
  );

  it.effect('persists every accepted assertion once as immutable historical evidence', () =>
    Effect.gen(function* appendOnlyEvidence() {
      const { persistence, stored } = yield* makePersistence();
      const result = yield* makeEvaluator(persistence).evaluate({
        proposal: proposal(),
        selectedConfiguration: configuration,
      });
      const assertions = yield* Ref.get(stored);

      expect(assertions).toHaveLength(1);
      expect(assertions[0]).toEqual(result.assertion);
      expect(Schema.is(InventorySourceAssertionSchema)(assertions[0])).toBe(true);
    }),
  );
});
