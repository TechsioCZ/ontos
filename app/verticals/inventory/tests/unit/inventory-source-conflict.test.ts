import { Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { getActionBusinessPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';

import type { ImportSourceAssertionResult } from '../../shared/actions/import-source-assertion.ts';
import {
  AssertionIntegrityConflictCandidateSchema,
  BackendConfigurationConflictCandidateSchema,
  CorrelationConflictCandidateSchema,
  CurrentAssertionConflictResolutionSchema,
  ExternalCorrelationConflictScopeSchema,
  FactValueConflictCandidateSchema,
  InventorySourceConflictResolutionInputSchema,
  OpenAssertionIntegrityInventorySourceConflictSchema,
  OpenBackendConfigurationInventorySourceConflictSchema,
  OpenCorrelationInventorySourceConflictSchema,
  OpenFactValueInventorySourceConflictSchema,
  classifyInventorySourceConflict,
} from '../../shared/domain/inventory-source-conflict.ts';
import type {
  InventorySourceConflict,
  InventorySourceConflictError,
  InventorySourceConflictOpen,
} from '../../shared/domain/inventory-source-conflict.ts';
import { InventorySourceConflictRejected } from '../../shared/domain/inventory-source-conflict-rejected.ts';
import {
  ConflictIndeterminateInventorySourceImportOutcomeSchema,
  InventorySourceImportActionInvocationIdSchema,
  InventorySourceImportOutcomeSchema,
} from '../../shared/domain/inventory-source-import-outcome.ts';
import type { InventorySourceImportLedgerEntry } from '../../shared/domain/inventory-source-import-outcome.ts';
import {
  InventorySourceAssertionRejected,
  InventorySourceAssertionProposalSchema,
  InventorySourceAssertionSchema,
} from '../../shared/domain/inventory-source-assertion.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { ExternalStockCorrelationResolutionSchema } from '../../shared/domain/external-stock-correlation.ts';
import {
  CurrentOnHandEvidenceSchema,
  IndeterminateOnHandEvidenceSchema,
  StockPositionSchema,
} from '../../shared/domain/stock-position.ts';
import { makeInventorySourceConflictOutcomeFinalizer } from '../../src/services/inventory-source-conflict-import.service.ts';
import { makeInventorySourceImportService } from '../../src/services/inventory-source-import.service.ts';
import { makeInventorySourceConflictService } from '../../src/services/inventory-source-conflict.service.ts';
import type { InventorySourceConflictPersistence } from '../../src/services/inventory-source-conflict.service.ts';
import { resolveInventorySourceConflictAction } from '../../src/actions/resolve-inventory-source-conflict.action.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const configurationId = '00000000-0000-4000-8000-000000000002';
const positionOneId = '00000000-0000-4000-8000-000000000003';
const positionTwoId = '00000000-0000-4000-8000-000000000004';
const itemId = '00000000-0000-4000-8000-000000000005';
const locationId = '00000000-0000-4000-8000-000000000006';
const unitId = '00000000-0000-4000-8000-000000000007';
const assertionOneId = '00000000-0000-4000-8000-000000000008';
const assertionTwoId = '00000000-0000-4000-8000-000000000009';
const assertionThreeId = '00000000-0000-4000-8000-000000000017';
const conflictId = '00000000-0000-4000-8000-000000000010';
const itemCorrelationId = '00000000-0000-4000-8000-000000000011';
const locationCorrelationId = '00000000-0000-4000-8000-000000000012';
const switchedConfigurationId = '00000000-0000-4000-8000-000000000014';
const importInvocationId = Schema.decodeSync(InventorySourceImportActionInvocationIdSchema)(
  '00000000-0000-4000-8000-000000000015',
);
const acceptedInvocationId = Schema.decodeSync(InventorySourceImportActionInvocationIdSchema)(
  '00000000-0000-4000-8000-000000000016',
);
const selectedAt = '2026-09-24T08:00:00.000Z';
const observedAt = '2026-09-24T09:00:00.000Z';

const expectRejectedReason = (
  failure: InventorySourceConflictError,
  reason: InventorySourceConflictRejected['reason'],
) => {
  expect(Schema.is(InventorySourceConflictRejected)(failure)).toBe(true);
  if (Schema.is(InventorySourceConflictRejected)(failure)) {
    expect(failure.reason).toBe(reason);
  }
};

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
};

const positionRef = (resourceId: string) => ({
  moduleId: 'commerce.inventory',
  resourceId,
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
});

const stockItemRef = {
  moduleId: 'commerce.inventory',
  resourceId: itemId,
  resourceType: 'commerce.inventory.stock-item',
  tenantId,
};

const stockLocationRef = {
  moduleId: 'commerce.inventory',
  resourceId: locationId,
  resourceType: 'commerce.inventory.stock-location',
  tenantId,
};

const externalKey = (identifierKind: 'ITEM' | 'LOCATION', externalValue: string) => ({
  customerConfigurationId: 'customer-configuration-a',
  externalScope: 'warehouse-a',
  externalValue,
  identifierKind,
  issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
  namespace: 'inventory',
  tenantId,
});

const proposal = (assertionId: string, amount: string, receivedAt: string) =>
  Schema.decodeUnknownSync(InventorySourceAssertionProposalSchema)({
    assertionId,
    businessObservedAt: observedAt,
    coverage: [],
    customerConfigurationId: 'customer-configuration-a',
    factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
    issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
    itemExternalKey: externalKey('ITEM', 'sku-1'),
    locationExternalKey: externalKey('LOCATION', 'warehouse-1'),
    orderingEvidence: { _tag: 'SOURCE_REVISION', revision: amount === '8' ? 'revision-a' : 'revision-b' },
    ownerEvidenceRef: `owner-evidence-${amount}`,
    positionRef: positionRef(positionOneId),
    quantity: { amount, unitRef },
    receivedAt,
    sourceReference: `snapshot-${amount}`,
  });

const factValueCandidate = () =>
  Schema.decodeUnknownSync(FactValueConflictCandidateSchema)({
    _tag: 'FACT_VALUE',
    conflictRef: {
      moduleId: 'commerce.inventory',
      resourceId: conflictId,
      resourceType: 'commerce.inventory.inventory-source-conflict',
      tenantId,
    },
    detectedAt: '2026-09-24T10:00:00.000Z',
    evidence: [
      proposal(assertionOneId, '8', '2026-09-24T10:01:00.000Z'),
      proposal(assertionTwoId, '12', '2026-09-24T10:02:00.000Z'),
    ],
    selectedConfiguration: {
      configurationId,
      customerConfigurationId: 'customer-configuration-a',
      revision: 1,
      selectedAt,
      selection: {
        backend: 'external_business_system',
        backendId: 'erp-a',
        exactReservationCapability: 'SUPPORTED',
        stockCorrectionCapability: 'SUPPORTED',
      },
      tenantId,
    },
  });

const openFactValueConflict = () => {
  const candidate = factValueCandidate();
  return Schema.decodeUnknownSync(OpenFactValueInventorySourceConflictSchema)({
    authorityConfiguration: candidate.selectedConfiguration,
    conflictRef: candidate.conflictRef,
    conflictType: 'FACT_VALUE',
    currentTruth: 'INDETERMINATE',
    detectedAt: candidate.detectedAt,
    evidence: candidate.evidence,
    revision: 1,
    scope: {
      _tag: 'STOCK_POSITION_FACT',
      customerConfigurationId: candidate.evidence[0]?.customerConfigurationId,
      factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
      positionRef: candidate.evidence[0]?.positionRef,
      unitRef: candidate.evidence[0]?.quantity.unitRef,
    },
    status: 'OPEN',
  });
};

const position = (resourceId: string) =>
  Schema.decodeUnknownSync(StockPositionSchema)({
    createdAt: selectedAt,
    endedAt: null,
    lifecycle: 'CURRENT',
    onHand: {
      _tag: 'CURRENT',
      evidenceRef: 'prior-owner-evidence',
      meaning: 'ON_HAND',
      observedAt: selectedAt,
      ownerConfigurationRef: {
        moduleId: 'commerce.inventory',
        resourceId: configurationId,
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId,
      },
      quantity: { amount: '20', unitRef },
    },
    ref: positionRef(resourceId),
    revision: 1,
    scope: {
      customerConfigurationId: 'customer-configuration-a',
      stockItemRef,
      stockLocationRef,
      unitRef,
    },
  });

const acceptedImport = (acceptedProposal: ReturnType<typeof proposal>): InventorySourceImportLedgerEntry => ({
  actionInvocationId: acceptedInvocationId,
  itemIndex: 0,
  outcome: {
    assertionId: acceptedProposal.assertionId,
    postEffectOnHand: acceptedProposal.quantity,
    status: 'ACCEPTED',
  },
  proposal: acceptedProposal,
});

const indeterminateImportResult = (incoming: ReturnType<typeof proposal>) => ({
  items: [
    {
      assertionId: incoming.assertionId,
      reason: 'Owner evidence cannot establish an order relative to accepted source evidence',
      reconciliationRequired: true as const,
      status: 'INDETERMINATE' as const,
    },
  ],
  summary: {
    accepted: 0,
    allItemsDeterminate: false,
    duplicates: 0,
    indeterminate: 1,
    rejected: 0,
    stale: 0,
  },
});

/* oxlint-disable sonarjs/no-nested-functions -- In-memory transaction harness proves the import-to-conflict production seam atomically; expires: 2027-03-31. */
const makeConflictAwareImportHarness = (
  incoming: ReturnType<typeof proposal>,
  result: ImportSourceAssertionResult,
  history: readonly InventorySourceImportLedgerEntry[],
  ambiguousLocations = false,
) =>
  Effect.gen(function* makeHarness() {
    const positions = new Map([
      [positionOneId, position(positionOneId)],
      [positionTwoId, position(positionTwoId)],
    ]);
    let latest = Option.none<InventorySourceConflictOpen>();
    const conflictsById = new Map<string, InventorySourceConflictOpen>();
    let appendCount = 0;
    const conflicts = makeInventorySourceConflictService({
      assertions: { findById: () => Effect.succeedNone },
      backendConfigurations: { findCurrent: () => Effect.succeedSome(factValueCandidate().selectedConfiguration) },
      conflicts: {
        appendOpen: (conflict) =>
          Effect.sync(() => {
            appendCount += 1;
            latest = Option.some(conflict);
            conflictsById.set(conflict.conflictRef.resourceId, conflict);
            return conflict;
          }),
        appendResolution: () => Effect.die('not used'),
        findLatest: (ref) => Effect.succeed(Option.fromNullishOr(conflictsById.get(ref.resourceId))),
      },
      positions: {
        read: (ref) => Effect.succeed(Option.fromNullishOr(positions.get(ref.resourceId))),
        save: ({ next }) =>
          Effect.sync(() => {
            positions.set(next.ref.resourceId, next);
            return next;
          }),
      },
    });
    const finalizeOutcome = makeInventorySourceConflictOutcomeFinalizer({
      configurations: { findCurrent: () => Effect.succeedSome(factValueCandidate().selectedConfiguration) },
      conflicts,
      correlations: {
        resolve: ({ asOf, externalKey: sourceKey }) =>
          Effect.succeed(
            Schema.decodeUnknownSync(ExternalStockCorrelationResolutionSchema)(
              sourceKey.identifierKind === 'ITEM' || ambiguousLocations
                ? {
                    _tag: 'AMBIGUOUS' as const,
                    asOf,
                    candidateCorrelationRefs: [
                      {
                        moduleId: 'commerce.inventory' as const,
                        resourceId: itemCorrelationId,
                        resourceType: 'commerce.inventory.external-stock-correlation' as const,
                        tenantId,
                      },
                      {
                        moduleId: 'commerce.inventory' as const,
                        resourceId: '00000000-0000-4000-8000-000000000013',
                        resourceType: 'commerce.inventory.external-stock-correlation' as const,
                        tenantId,
                      },
                    ],
                    externalKey: sourceKey,
                  }
                : { _tag: 'UNRESOLVED' as const, asOf, externalKey: sourceKey },
            ),
          ),
      },
    });
    const entries = yield* Ref.make(history);
    const imports = makeInventorySourceImportService({
      configurations: { findCurrent: () => Effect.succeedSome(factValueCandidate().selectedConfiguration) },
      evaluator: {
        evaluate: () =>
          result.items[0]?.status === 'REJECTED'
            ? Effect.fail(
                new InventorySourceAssertionRejected({
                  assertionId: incoming.assertionId,
                  code: 'inventory_source_assertion_rejected',
                  reason: 'CORRELATION_AMBIGUOUS',
                }),
              )
            : Effect.die('preflight conflict must not evaluate'),
      },
      finalizeOutcome,
      ledger: {
        append: (entry) => Ref.update(entries, (current) => [...current, entry]).pipe(Effect.as(entry)),
        findByInvocationItem: (actionInvocationId, itemIndex) =>
          Ref.get(entries).pipe(
            Effect.map((current) =>
              Option.fromNullishOr(
                current.find(
                  (entry) => entry.actionInvocationId === actionInvocationId && entry.itemIndex === itemIndex,
                ),
              ),
            ),
          ),
        lockAndReadAcceptedHistory: () =>
          Ref.get(entries).pipe(
            Effect.map((current) => current.filter((entry) => entry.outcome.status === 'ACCEPTED')),
          ),
      },
    });
    return {
      appendCount: () => appendCount,
      entries,
      imports,
      latest: () => latest,
      positions,
      run: () =>
        imports.importBatch({
          actionInvocationId: importInvocationId,
          payload: { authorizationTargetRef: incoming.positionRef, items: [incoming] },
        }),
    };
  });
/* oxlint-enable sonarjs/no-nested-functions */

describe('Inventory external source conflicts', () => {
  it('requires Inventory Recovery permission for the exact conflict target', () => {
    const { conflictRef } = factValueCandidate();
    const input = Schema.decodeUnknownSync(InventorySourceConflictResolutionInputSchema)({
      conflictRef,
      expectedRevision: 1,
      ownerEvidenceRef: 'owner-resolution-evidence',
      resolution: {
        _tag: 'BACKEND_CONFIGURATION',
        configurationId,
      },
      resolvedAt: '2026-09-24T11:00:00.000Z',
    });
    const scope = trustVerifiedGatewayPrincipalContext({
      authBindingId: '00000000-0000-4000-8000-000000000018',
      authContextRef: 'test:inventory-source-conflict',
      authMethod: 'api_key',
      correlationId: 'inventory-source-conflict',
      principalId: '00000000-0000-4000-8000-000000000019',
      tenantId,
    });

    expect(getActionBusinessPermissionTargetResolver(resolveInventorySourceConflictAction)?.(input, scope)).toEqual({
      permission: 'inventory.recovery.execute',
      target: {
        kind: 'inventory_resource',
        resource: {
          moduleId: conflictRef.moduleId,
          resourceId: conflictRef.resourceId,
          resourceType: conflictRef.resourceType,
        },
        tenantId,
      },
    });
  });

  it('requires non-empty exact conflict refs for typed import conflict outcomes', () => {
    const { conflictRef } = factValueCandidate();
    const withoutRefs = {
      assertionId: assertionOneId,
      reason: 'INVENTORY_SOURCE_CONFLICT',
      reconciliationRequired: true,
      status: 'INDETERMINATE',
    };

    expect(Schema.is(InventorySourceImportOutcomeSchema)(withoutRefs)).toBe(false);
    expect(
      Schema.is(ConflictIndeterminateInventorySourceImportOutcomeSchema)({
        ...withoutRefs,
        conflictRefs: [conflictRef, { ...conflictRef, resourceId: '00000000-0000-4000-8000-000000000017' }],
      }),
    ).toBe(true);
  });

  it.effect(
    'classifies conflicting selected-backend fact values without choosing lower, newest arrival, last-known, or zero',
    () =>
      Effect.gen(function* test() {
        const conflict = yield* classifyInventorySourceConflict(factValueCandidate());
        const factConflict = yield* Schema.decodeUnknownEffect(OpenFactValueInventorySourceConflictSchema)(conflict);

        expect(factConflict.conflictType).toBe('FACT_VALUE');
        expect(factConflict.currentTruth).toBe('INDETERMINATE');
        expect(factConflict.evidence.map(({ quantity }) => quantity.amount)).toEqual(['8', '12']);
        expect(factConflict.evidence.map(({ receivedAt }) => receivedAt)).toEqual([
          '2026-09-24T10:01:00.000Z',
          '2026-09-24T10:02:00.000Z',
        ]);
      }),
  );

  it.effect('classifies ambiguous exact correlation scope and preserves every candidate without picking one', () =>
    Effect.gen(function* test() {
      const candidate = Schema.decodeUnknownSync(CorrelationConflictCandidateSchema)({
        _tag: 'CORRELATION',
        ambiguousExternalKey: externalKey('ITEM', 'sku-1'),
        candidateCorrelationRefs: [
          {
            moduleId: 'commerce.inventory',
            resourceId: itemCorrelationId,
            resourceType: 'commerce.inventory.external-stock-correlation',
            tenantId,
          },
          {
            moduleId: 'commerce.inventory',
            resourceId: '00000000-0000-4000-8000-000000000013',
            resourceType: 'commerce.inventory.external-stock-correlation',
            tenantId,
          },
        ],
        conflictRef: factValueCandidate().conflictRef,
        detectedAt: '2026-09-24T10:00:00.000Z',
        proposal: proposal(assertionOneId, '8', '2026-09-24T10:01:00.000Z'),
        selectedConfiguration: factValueCandidate().selectedConfiguration,
      });
      const conflict = yield* classifyInventorySourceConflict(candidate);
      const correlationConflict = yield* Schema.decodeUnknownEffect(OpenCorrelationInventorySourceConflictSchema)(
        conflict,
      );

      expect(correlationConflict.conflictType).toBe('CORRELATION');
      expect(correlationConflict.currentTruth).toBe('INDETERMINATE');
      expect(correlationConflict.evidence.candidateCorrelationRefs).toHaveLength(2);
    }),
  );

  it.effect('rejects correlation ambiguity whose key or candidates escape the exact Tenant scope', () =>
    Effect.gen(function* test() {
      const otherTenantId = '00000000-0000-4000-8000-000000000099';
      const candidate = Schema.decodeUnknownSync(CorrelationConflictCandidateSchema)({
        _tag: 'CORRELATION',
        ambiguousExternalKey: {
          ...externalKey('ITEM', 'sku-1'),
          customerConfigurationId: 'customer-configuration-other',
          tenantId: otherTenantId,
        },
        candidateCorrelationRefs: [
          {
            moduleId: 'commerce.inventory',
            resourceId: itemCorrelationId,
            resourceType: 'commerce.inventory.external-stock-correlation',
            tenantId,
          },
          {
            moduleId: 'commerce.inventory',
            resourceId: '00000000-0000-4000-8000-000000000013',
            resourceType: 'commerce.inventory.external-stock-correlation',
            tenantId: otherTenantId,
          },
        ],
        conflictRef: factValueCandidate().conflictRef,
        detectedAt: '2026-09-24T10:00:00.000Z',
        proposal: proposal(assertionOneId, '8', '2026-09-24T10:01:00.000Z'),
        selectedConfiguration: factValueCandidate().selectedConfiguration,
      });
      const failure = yield* Effect.flip(classifyInventorySourceConflict(candidate));

      expect(failure).toBeInstanceOf(InventorySourceConflictRejected);
      expect(failure.reason).toBe('INVALID_CORRELATION_CONFLICT');
    }),
  );

  it.effect('rejects duplicate correlation candidates because they do not establish ambiguity', () =>
    Effect.gen(function* test() {
      const candidateRef = {
        moduleId: 'commerce.inventory' as const,
        resourceId: itemCorrelationId,
        resourceType: 'commerce.inventory.external-stock-correlation' as const,
        tenantId,
      };
      const candidate = Schema.decodeUnknownSync(CorrelationConflictCandidateSchema)({
        _tag: 'CORRELATION',
        ambiguousExternalKey: externalKey('ITEM', 'sku-1'),
        candidateCorrelationRefs: [candidateRef, candidateRef],
        conflictRef: factValueCandidate().conflictRef,
        detectedAt: '2026-09-24T10:00:00.000Z',
        proposal: proposal(assertionOneId, '8', '2026-09-24T10:01:00.000Z'),
        selectedConfiguration: factValueCandidate().selectedConfiguration,
      });
      const failure = yield* Effect.flip(classifyInventorySourceConflict(candidate));

      expect(failure).toBeInstanceOf(InventorySourceConflictRejected);
      expect(failure.reason).toBe('INVALID_CORRELATION_CONFLICT');
    }),
  );

  it.effect('classifies materially different content under one assertion identity as an integrity conflict', () =>
    Effect.gen(function* test() {
      const candidate = Schema.decodeUnknownSync(AssertionIntegrityConflictCandidateSchema)({
        _tag: 'ASSERTION_INTEGRITY',
        accepted: proposal(assertionOneId, '8', '2026-09-24T10:01:00.000Z'),
        conflictRef: factValueCandidate().conflictRef,
        detectedAt: '2026-09-24T10:00:00.000Z',
        incoming: proposal(assertionOneId, '12', '2026-09-24T10:02:00.000Z'),
        selectedConfiguration: factValueCandidate().selectedConfiguration,
      });
      const conflict = yield* classifyInventorySourceConflict(candidate);
      const integrityConflict = yield* Schema.decodeUnknownEffect(OpenAssertionIntegrityInventorySourceConflictSchema)(
        conflict,
      );

      expect(integrityConflict.conflictType).toBe('ASSERTION_INTEGRITY');
      expect(integrityConflict.evidence.map(({ quantity }) => quantity.amount)).toEqual(['8', '12']);
    }),
  );

  it.effect(
    'treats simultaneous External Business System and OntOS WMS selection as one Customer Configuration conflict',
    () =>
      Effect.gen(function* test() {
        const candidate = Schema.decodeUnknownSync(BackendConfigurationConflictCandidateSchema)({
          _tag: 'BACKEND_CONFIGURATION',
          attemptedSelection: {
            backend: 'ontos_wms',
            backendId: 'ontos-wms-primary',
            exactReservationCapability: 'SUPPORTED',
            stockCorrectionCapability: 'SUPPORTED',
          },
          conflictRef: factValueCandidate().conflictRef,
          detectedAt: '2026-09-24T10:00:00.000Z',
          ownerEvidenceRef: 'configuration-attempt-2',
          selectedConfiguration: factValueCandidate().selectedConfiguration,
        });
        const conflict = yield* classifyInventorySourceConflict(candidate);
        const configurationConflict = yield* Schema.decodeUnknownEffect(
          OpenBackendConfigurationInventorySourceConflictSchema,
        )(conflict);

        expect(configurationConflict.conflictType).toBe('BACKEND_CONFIGURATION');
        expect(configurationConflict.scope.customerConfigurationId).toBe('customer-configuration-a');
        expect(configurationConflict.scope.tenantId).toBe(tenantId);
        expect(configurationConflict.evidence.selectedConfiguration.selection.backend).toBe('external_business_system');
        expect(configurationConflict.evidence.attemptedSelection.backend).toBe('ontos_wms');
      }),
  );

  it.effect('rejects fact conflicts from an unselected backend instead of inventing another authority', () =>
    Effect.gen(function* test() {
      const candidate = factValueCandidate();
      const exit = yield* Effect.flip(
        classifyInventorySourceConflict(
          Schema.decodeUnknownSync(FactValueConflictCandidateSchema)({
            ...candidate,
            selectedConfiguration: {
              ...candidate.selectedConfiguration,
              selection: {
                backend: 'ontos_wms',
                backendId: 'ontos-wms-primary',
                exactReservationCapability: 'SUPPORTED',
                stockCorrectionCapability: 'SUPPORTED',
              },
            },
          }),
        ),
      );

      expect(exit).toBeInstanceOf(InventorySourceConflictRejected);
      expect(exit.reason).toBe('INVALID_FACT_VALUE_CONFLICT');
    }),
  );

  it.effect('marks only the affected Position INDETERMINATE when registering a conflict', () =>
    Effect.gen(function* test() {
      const positions = new Map([
        [positionOneId, position(positionOneId)],
        [positionTwoId, position(positionTwoId)],
      ]);
      let stored = Option.none<InventorySourceConflictOpen>();
      const persistence: InventorySourceConflictPersistence = {
        appendOpen: (conflict) => {
          stored = Option.some(conflict);
          return Effect.succeed(conflict);
        },
        appendResolution: () => Effect.die('not used'),
        findLatest: () => Effect.succeed(stored),
      };
      const service = makeInventorySourceConflictService({
        assertions: { findById: () => Effect.succeedNone },
        backendConfigurations: { findCurrent: () => Effect.succeedNone },
        conflicts: persistence,
        positions: {
          read: (ref) => {
            const found = positions.get(ref.resourceId);
            return Effect.succeed(found === undefined ? Option.none() : Option.some(found));
          },
          save: ({ next }) => {
            positions.set(next.ref.resourceId, next);
            return Effect.succeed(next);
          },
        },
      });

      const result = yield* service.register(factValueCandidate());

      expect(result.conflict.currentTruth).toBe('INDETERMINATE');
      expect(
        result.position === null ? false : Schema.is(IndeterminateOnHandEvidenceSchema)(result.position.onHand),
      ).toBe(true);
      expect(Schema.is(IndeterminateOnHandEvidenceSchema)(positions.get(positionOneId)?.onHand)).toBe(true);
      expect(Schema.is(CurrentOnHandEvidenceSchema)(positions.get(positionTwoId)?.onHand)).toBe(true);
    }),
  );

  it.effect('resolves append-only only after owner-governed evidence has established a new exact Current result', () =>
    Effect.gen(function* test() {
      const open = openFactValueConflict();
      const currentAssertion = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
        ...proposal(assertionTwoId, '12', '2026-09-24T10:02:00.000Z'),
        authorityConfiguration: {
          configurationId,
          customerConfigurationId: 'customer-configuration-a',
          revision: 1,
          selectedAt,
          selection: {
            backend: 'external_business_system',
            backendId: 'erp-a',
            exactReservationCapability: 'SUPPORTED',
            stockCorrectionCapability: 'SUPPORTED',
          },
          tenantId,
        },
        businessObservedAt: '2026-09-24T10:00:00+01:00',
        issuerAuthority: 'SELECTED_BACKEND',
        itemCorrelationRef: {
          moduleId: 'commerce.inventory',
          resourceId: itemCorrelationId,
          resourceType: 'commerce.inventory.external-stock-correlation',
          tenantId,
        },
        locationCorrelationRef: {
          moduleId: 'commerce.inventory',
          resourceId: locationCorrelationId,
          resourceType: 'commerce.inventory.external-stock-correlation',
          tenantId,
        },
        stockItemRef,
        stockLocationRef,
      });
      const currentPosition = Schema.decodeUnknownSync(StockPositionSchema)({
        ...position(positionOneId),
        onHand: {
          _tag: 'CURRENT',
          evidenceRef: currentAssertion.ownerEvidenceRef,
          meaning: 'ON_HAND',
          observedAt: '2026-09-24T09:00:00.000Z',
          ownerConfigurationRef: {
            moduleId: 'commerce.inventory',
            resourceId: configurationId,
            resourceType: 'commerce.inventory.inventory-backend-configuration',
            tenantId,
          },
          quantity: currentAssertion.quantity,
        },
        revision: 3,
      });
      let latest: InventorySourceConflict = open;
      const service = makeInventorySourceConflictService({
        assertions: { findById: () => Effect.succeedSome(currentAssertion) },
        backendConfigurations: {
          findCurrent: () => Effect.succeedSome(factValueCandidate().selectedConfiguration),
        },
        conflicts: {
          appendOpen: () => Effect.die('not used'),
          appendResolution: (_expected, resolved) => {
            latest = resolved;
            return Effect.succeed(resolved);
          },
          findLatest: () => Effect.succeedSome(latest),
        },
        positions: {
          read: () => Effect.succeedSome(currentPosition),
          save: () => Effect.die('resolution must not rewrite Current truth'),
        },
      });
      const input = Schema.decodeUnknownSync(InventorySourceConflictResolutionInputSchema)({
        conflictRef: open.conflictRef,
        expectedRevision: 1,
        ownerEvidenceRef: 'owner-resolution-43',
        resolution: { _tag: 'CURRENT_ASSERTION', assertionId: assertionTwoId },
        resolvedAt: '2026-09-24T11:00:00.000Z',
      });

      const resolved = yield* service.resolve(input, { principalId: 'principal-a', tenantId });
      const replay = yield* service.register(factValueCandidate());

      expect(resolved.status).toBe('RESOLVED');
      expect(resolved.revision).toBe(2);
      expect(Schema.is(CurrentAssertionConflictResolutionSchema)(resolved.resolution)).toBe(true);
      expect(resolved.originalEvidence).toEqual(open.evidence);
      expect(resolved.currentTruth).toBe('CURRENT');
      expect(replay).toMatchObject({ conflict: open, outcome: 'EXACT_REPLAY', position: null });
      expect(latest).toEqual(resolved);
    }),
  );

  it.effect(
    'does not resolve to last-known or a supplied quantity while the affected Position remains INDETERMINATE',
    () =>
      Effect.gen(function* test() {
        const open = openFactValueConflict();
        const indeterminate = Schema.decodeUnknownSync(StockPositionSchema)({
          ...position(positionOneId),
          onHand: {
            _tag: 'INDETERMINATE',
            meaning: 'ON_HAND',
            ownerConfigurationRef: position(positionOneId).onHand.ownerConfigurationRef,
            unitRef,
          },
          revision: 2,
        });
        const currentAssertion = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
          ...proposal(assertionTwoId, '12', '2026-09-24T10:02:00.000Z'),
          authorityConfiguration: factValueCandidate().selectedConfiguration,
          issuerAuthority: 'SELECTED_BACKEND',
          itemCorrelationRef: {
            moduleId: 'commerce.inventory',
            resourceId: itemCorrelationId,
            resourceType: 'commerce.inventory.external-stock-correlation',
            tenantId,
          },
          locationCorrelationRef: {
            moduleId: 'commerce.inventory',
            resourceId: locationCorrelationId,
            resourceType: 'commerce.inventory.external-stock-correlation',
            tenantId,
          },
          stockItemRef,
          stockLocationRef,
        });
        const service = makeInventorySourceConflictService({
          assertions: { findById: () => Effect.succeedSome(currentAssertion) },
          backendConfigurations: { findCurrent: () => Effect.succeedSome(factValueCandidate().selectedConfiguration) },
          conflicts: {
            appendOpen: () => Effect.die('not used'),
            appendResolution: () => Effect.die('must not append an unsafe resolution'),
            findLatest: () => Effect.succeedSome(open),
          },
          positions: {
            read: () => Effect.succeedSome(indeterminate),
            save: () => Effect.die('resolution must not rewrite Current truth'),
          },
        });
        const failure = yield* Effect.flip(
          service.resolve(
            Schema.decodeUnknownSync(InventorySourceConflictResolutionInputSchema)({
              conflictRef: open.conflictRef,
              expectedRevision: 1,
              ownerEvidenceRef: 'owner-resolution-unsafe',
              resolution: { _tag: 'CURRENT_ASSERTION', assertionId: assertionTwoId },
              resolvedAt: '2026-09-24T11:00:00.000Z',
            }),
            { principalId: 'principal-a', tenantId },
          ),
        );

        expectRejectedReason(failure, 'CURRENT_RESULT_NOT_ESTABLISHED');
      }),
  );

  it.effect('does not resolve a fact conflict by switching its Inventory Backend configuration', () =>
    Effect.gen(function* test() {
      const open = openFactValueConflict();
      const switchedAssertion = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
        ...proposal(assertionTwoId, '12', '2026-09-24T10:02:00.000Z'),
        authorityConfiguration: {
          ...factValueCandidate().selectedConfiguration,
          configurationId: switchedConfigurationId,
          selection: {
            backend: 'external_business_system',
            backendId: 'erp-b',
            exactReservationCapability: 'SUPPORTED',
            stockCorrectionCapability: 'SUPPORTED',
          },
        },
        issuer: { backendId: 'erp-b', backendKind: 'external_business_system' },
        issuerAuthority: 'SELECTED_BACKEND',
        itemCorrelationRef: {
          moduleId: 'commerce.inventory',
          resourceId: itemCorrelationId,
          resourceType: 'commerce.inventory.external-stock-correlation',
          tenantId,
        },
        itemExternalKey: {
          ...externalKey('ITEM', 'sku-1'),
          issuer: { backendId: 'erp-b', backendKind: 'external_business_system' },
        },
        locationCorrelationRef: {
          moduleId: 'commerce.inventory',
          resourceId: locationCorrelationId,
          resourceType: 'commerce.inventory.external-stock-correlation',
          tenantId,
        },
        locationExternalKey: {
          ...externalKey('LOCATION', 'warehouse-1'),
          issuer: { backendId: 'erp-b', backendKind: 'external_business_system' },
        },
        stockItemRef,
        stockLocationRef,
      });
      const switchedPosition = Schema.decodeUnknownSync(StockPositionSchema)({
        ...position(positionOneId),
        onHand: {
          _tag: 'CURRENT',
          evidenceRef: switchedAssertion.ownerEvidenceRef,
          meaning: 'ON_HAND',
          observedAt: switchedAssertion.businessObservedAt,
          ownerConfigurationRef: {
            moduleId: 'commerce.inventory',
            resourceId: switchedConfigurationId,
            resourceType: 'commerce.inventory.inventory-backend-configuration',
            tenantId,
          },
          quantity: switchedAssertion.quantity,
        },
        revision: 3,
      });
      const service = makeInventorySourceConflictService({
        assertions: { findById: () => Effect.succeedSome(switchedAssertion) },
        backendConfigurations: { findCurrent: () => Effect.die('must not switch backend') },
        conflicts: {
          appendOpen: () => Effect.die('not used'),
          appendResolution: () => Effect.die('must not append a backend-switching resolution'),
          findLatest: () => Effect.succeedSome(open),
        },
        positions: {
          read: () => Effect.succeedSome(switchedPosition),
          save: () => Effect.die('resolution must not rewrite Current truth'),
        },
      });
      const failure = yield* Effect.flip(
        service.resolve(
          Schema.decodeUnknownSync(InventorySourceConflictResolutionInputSchema)({
            conflictRef: open.conflictRef,
            expectedRevision: 1,
            ownerEvidenceRef: 'owner-resolution-backend-switch',
            resolution: { _tag: 'CURRENT_ASSERTION', assertionId: assertionTwoId },
            resolvedAt: '2026-09-24T11:00:00.000Z',
          }),
          { principalId: 'principal-a', tenantId },
        ),
      );

      expectRejectedReason(failure, 'ASSERTION_AUTHORITY_MISMATCH');
    }),
  );

  it.effect('rejects a resolution timestamp before conflict detection', () =>
    Effect.gen(function* test() {
      const open = openFactValueConflict();
      const service = makeInventorySourceConflictService({
        assertions: { findById: () => Effect.die('must reject before reading an assertion') },
        backendConfigurations: { findCurrent: () => Effect.die('must reject before reading configuration') },
        conflicts: {
          appendOpen: () => Effect.die('not used'),
          appendResolution: () => Effect.die('must not append temporally invalid resolution'),
          findLatest: () => Effect.succeedSome(open),
        },
        positions: {
          read: () => Effect.die('must reject before reading a Position'),
          save: () => Effect.die('must not mutate a Position'),
        },
      });
      const failure = yield* Effect.flip(
        service.resolve(
          Schema.decodeUnknownSync(InventorySourceConflictResolutionInputSchema)({
            conflictRef: open.conflictRef,
            expectedRevision: 1,
            ownerEvidenceRef: 'owner-resolution-before-detection',
            resolution: { _tag: 'CURRENT_ASSERTION', assertionId: assertionTwoId },
            resolvedAt: '2026-09-24T09:59:59.999Z',
          }),
          { principalId: 'principal-a', tenantId },
        ),
      );

      expectRejectedReason(failure, 'RESOLUTION_TIME_BEFORE_DETECTION');
    }),
  );

  it.effect('does not resolve a backend conflict by selecting a third backend configuration', () =>
    Effect.gen(function* test() {
      const candidate = Schema.decodeUnknownSync(BackendConfigurationConflictCandidateSchema)({
        _tag: 'BACKEND_CONFIGURATION',
        attemptedSelection: {
          backend: 'ontos_wms',
          backendId: 'ontos-wms-primary',
          exactReservationCapability: 'SUPPORTED',
          stockCorrectionCapability: 'SUPPORTED',
        },
        conflictRef: factValueCandidate().conflictRef,
        detectedAt: '2026-09-24T10:00:00.000Z',
        ownerEvidenceRef: 'configuration-attempt-2',
        selectedConfiguration: factValueCandidate().selectedConfiguration,
      });
      const open = yield* classifyInventorySourceConflict(candidate);
      const thirdConfiguration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
        ...candidate.selectedConfiguration,
        configurationId: switchedConfigurationId,
        selection: {
          backend: 'external_business_system',
          backendId: 'erp-c',
          exactReservationCapability: 'SUPPORTED',
          stockCorrectionCapability: 'SUPPORTED',
        },
      });
      const service = makeInventorySourceConflictService({
        assertions: { findById: () => Effect.die('must not read assertion') },
        backendConfigurations: { findCurrent: () => Effect.succeedSome(thirdConfiguration) },
        conflicts: {
          appendOpen: () => Effect.die('not used'),
          appendResolution: () => Effect.die('must not append a backend-switching resolution'),
          findLatest: () => Effect.succeedSome(open),
        },
        positions: { read: () => Effect.die('must not read Position'), save: () => Effect.die('must not save') },
      });
      const failure = yield* Effect.flip(
        service.resolve(
          Schema.decodeUnknownSync(InventorySourceConflictResolutionInputSchema)({
            conflictRef: open.conflictRef,
            expectedRevision: 1,
            ownerEvidenceRef: 'owner-resolution-third-backend',
            resolution: { _tag: 'BACKEND_CONFIGURATION', configurationId: switchedConfigurationId },
            resolvedAt: '2026-09-24T11:00:00.000Z',
          }),
          { principalId: 'principal-a', tenantId },
        ),
      );

      expectRejectedReason(failure, 'BACKEND_CONFIGURATION_NOT_SINGULAR');
    }),
  );

  it.effect('registers an import fact-value conflict once and isolates the affected Position', () =>
    Effect.gen(function* test() {
      const accepted = proposal(assertionOneId, '8', '2026-09-24T10:01:00.000Z');
      const incoming = proposal(assertionTwoId, '12', '2026-09-24T10:02:00.000Z');
      const harness = yield* makeConflictAwareImportHarness(incoming, indeterminateImportResult(incoming), [
        acceptedImport(accepted),
      ]);

      const first = yield* harness.run();
      const replay = yield* harness.run();
      const durable = yield* Ref.get(harness.entries);

      expect(Option.getOrThrow(harness.latest()).conflictType).toBe('FACT_VALUE');
      expect(harness.appendCount()).toBe(1);
      expect(first.items[0]?.status).toBe('INDETERMINATE');
      expect(first.items[0]).toEqual(replay.items[0]);
      expect(durable.find((entry) => entry.actionInvocationId === importInvocationId)?.outcome).toEqual(first.items[0]);
      expect(Schema.is(IndeterminateOnHandEvidenceSchema)(harness.positions.get(positionOneId)?.onHand)).toBe(true);
      expect(Schema.is(CurrentOnHandEvidenceSchema)(harness.positions.get(positionTwoId)?.onHand)).toBe(true);
    }),
  );

  it.effect('derives distinct stable identities for distinct integrity-conflict evidence', () =>
    Effect.gen(function* test() {
      const accepted = proposal(assertionOneId, '8', '2026-09-24T10:01:00.000Z');
      const conflictIds: string[] = [];
      const register = (candidate: Parameters<ReturnType<typeof makeInventorySourceConflictService>['register']>[0]) =>
        classifyInventorySourceConflict(candidate).pipe(
          Effect.tap((conflict) =>
            Effect.sync(() => {
              conflictIds.push(conflict.conflictRef.resourceId);
            }),
          ),
          Effect.map((conflict) => ({ conflict, outcome: 'REGISTERED' as const, position: null })),
        );
      for (const amount of ['12', '15']) {
        const incoming = proposal(assertionOneId, amount, '2026-09-24T10:02:00.000Z');
        const finalize = makeInventorySourceConflictOutcomeFinalizer({
          configurations: { findCurrent: () => Effect.succeedSome(factValueCandidate().selectedConfiguration) },
          conflicts: { register },
          correlations: { resolve: () => Effect.die('not used') },
        });
        const [outcome] = indeterminateImportResult(incoming).items;
        if (outcome === undefined) {
          yield* Effect.die('Expected one indeterminate import outcome');
        }
        yield* finalize({
          acceptedHistory: [acceptedImport(accepted)],
          outcome,
          proposal: incoming,
        });
      }

      expect(conflictIds).toHaveLength(2);
      expect(new Set(conflictIds).size).toBe(2);
    }),
  );

  it.effect('keeps otherwise identical fact conflicts distinct by assertion identity', () =>
    Effect.gen(function* test() {
      const accepted = proposal(assertionOneId, '8', '2026-09-24T10:01:00.000Z');
      const conflictIds: string[] = [];
      const finalize = makeInventorySourceConflictOutcomeFinalizer({
        configurations: { findCurrent: () => Effect.succeedSome(factValueCandidate().selectedConfiguration) },
        conflicts: {
          register: (candidate) =>
            classifyInventorySourceConflict(candidate).pipe(
              Effect.tap((conflict) =>
                Effect.sync(() => {
                  conflictIds.push(conflict.conflictRef.resourceId);
                }),
              ),
              Effect.map((conflict) => ({ conflict, outcome: 'REGISTERED' as const, position: null })),
            ),
        },
        correlations: { resolve: () => Effect.die('not used') },
      });
      for (const assertionId of [assertionTwoId, assertionThreeId]) {
        const incoming = proposal(assertionId, '12', '2026-09-24T10:02:00.000Z');
        const [outcome] = indeterminateImportResult(incoming).items;
        if (outcome === undefined) {
          yield* Effect.die('Expected one indeterminate import outcome');
        }
        yield* finalize({ acceptedHistory: [acceptedImport(accepted)], outcome, proposal: incoming });
      }

      expect(new Set(conflictIds).size).toBe(2);
    }),
  );

  it.effect('keeps the same stable identity across canonical time and coverage encodings', () =>
    Effect.gen(function* test() {
      const accepted = proposal(assertionOneId, '8', '2026-09-24T10:01:00.000Z');
      const coverageA = {
        assertionId: assertionOneId,
        effectId: '00000000-0000-4000-8000-000000000018',
        ownerEvidenceRef: 'coverage-a',
        relation: 'INCLUDES' as const,
      };
      const coverageB = {
        assertionId: assertionOneId,
        effectId: '00000000-0000-4000-8000-000000000019',
        ownerEvidenceRef: 'coverage-b',
        relation: 'PREDATES' as const,
      };
      const coverage = [coverageA, coverageB];
      const incoming = Schema.decodeUnknownSync(InventorySourceAssertionProposalSchema)({
        ...proposal(assertionOneId, '12', '2026-09-24T10:02:00.000Z'),
        businessObservedAt: '2026-09-24T09:00:00.000Z',
        coverage,
      });
      const semanticReplay = Schema.decodeUnknownSync(InventorySourceAssertionProposalSchema)({
        ...incoming,
        businessObservedAt: '2026-09-24T10:00:00+01:00',
        coverage: [coverageB, coverageA],
        receivedAt: '2026-09-24T10:03:00.000Z',
      });
      const conflictIds: string[] = [];
      const finalize = makeInventorySourceConflictOutcomeFinalizer({
        configurations: { findCurrent: () => Effect.succeedSome(factValueCandidate().selectedConfiguration) },
        conflicts: {
          register: (candidate) =>
            classifyInventorySourceConflict(candidate).pipe(
              Effect.tap((conflict) =>
                Effect.sync(() => {
                  conflictIds.push(conflict.conflictRef.resourceId);
                }),
              ),
              Effect.map((conflict) => ({ conflict, outcome: 'REGISTERED' as const, position: null })),
            ),
        },
        correlations: { resolve: () => Effect.die('not used') },
      });
      for (const replay of [incoming, semanticReplay]) {
        const [outcome] = indeterminateImportResult(replay).items;
        if (outcome === undefined) {
          yield* Effect.die('Expected one indeterminate import outcome');
        }
        yield* finalize({ acceptedHistory: [acceptedImport(accepted)], outcome, proposal: replay });
      }

      expect(new Set(conflictIds).size).toBe(1);
    }),
  );

  it.effect('persists correlation ambiguity without trusting or mutating the proposed Position', () =>
    Effect.gen(function* test() {
      const incoming = proposal(assertionOneId, '8', '2026-09-24T10:01:00.000Z');
      const rejectedResult = {
        items: [
          { assertionId: incoming.assertionId, reason: 'CORRELATION_AMBIGUOUS' as const, status: 'REJECTED' as const },
        ],
        summary: {
          accepted: 0 as const,
          allItemsDeterminate: true as const,
          duplicates: 0 as const,
          indeterminate: 0 as const,
          rejected: 1 as const,
          stale: 0 as const,
        },
      };
      const harness = yield* makeConflictAwareImportHarness(incoming, rejectedResult, [], true);

      const result = yield* harness.run();

      const conflict = Option.getOrThrow(harness.latest());
      expect(conflict.conflictType).toBe('CORRELATION');
      expect(Schema.is(ExternalCorrelationConflictScopeSchema)(conflict.scope)).toBe(true);
      expect(result.items[0]?.status).toBe('INDETERMINATE');
      expect(result.items[0]).toMatchObject({ conflictRefs: expect.arrayContaining([conflict.conflictRef]) });
      expect(result.items[0]).toMatchObject({ conflictRefs: [expect.anything(), expect.anything()] });
      expect(harness.appendCount()).toBe(2);
      expect(result.summary).toMatchObject({ allItemsDeterminate: false, indeterminate: 1, rejected: 0 });
      expect(Schema.is(CurrentOnHandEvidenceSchema)(harness.positions.get(positionOneId)?.onHand)).toBe(true);
      expect(Schema.is(CurrentOnHandEvidenceSchema)(harness.positions.get(positionTwoId)?.onHand)).toBe(true);
    }),
  );

  it.effect('resolves correlation conflict only after owner correlation repair establishes exact Current truth', () =>
    Effect.gen(function* test() {
      const sourceProposal = proposal(assertionOneId, '8', '2026-09-24T10:01:00.000Z');
      const open = yield* classifyInventorySourceConflict(
        Schema.decodeUnknownSync(CorrelationConflictCandidateSchema)({
          _tag: 'CORRELATION',
          ambiguousExternalKey: sourceProposal.itemExternalKey,
          candidateCorrelationRefs: [
            {
              moduleId: 'commerce.inventory',
              resourceId: itemCorrelationId,
              resourceType: 'commerce.inventory.external-stock-correlation',
              tenantId,
            },
            {
              moduleId: 'commerce.inventory',
              resourceId: '00000000-0000-4000-8000-000000000013',
              resourceType: 'commerce.inventory.external-stock-correlation',
              tenantId,
            },
          ],
          conflictRef: factValueCandidate().conflictRef,
          detectedAt: '2026-09-24T10:00:00.000Z',
          proposal: sourceProposal,
          selectedConfiguration: factValueCandidate().selectedConfiguration,
        }),
      );
      const assertion = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
        ...sourceProposal,
        authorityConfiguration: factValueCandidate().selectedConfiguration,
        issuerAuthority: 'SELECTED_BACKEND',
        itemCorrelationRef: {
          moduleId: 'commerce.inventory',
          resourceId: itemCorrelationId,
          resourceType: 'commerce.inventory.external-stock-correlation',
          tenantId,
        },
        locationCorrelationRef: {
          moduleId: 'commerce.inventory',
          resourceId: locationCorrelationId,
          resourceType: 'commerce.inventory.external-stock-correlation',
          tenantId,
        },
        stockItemRef,
        stockLocationRef,
      });
      const currentPosition = Schema.decodeUnknownSync(StockPositionSchema)({
        ...position(positionOneId),
        onHand: {
          _tag: 'CURRENT',
          evidenceRef: assertion.ownerEvidenceRef,
          meaning: 'ON_HAND',
          observedAt: assertion.businessObservedAt,
          ownerConfigurationRef: position(positionOneId).onHand.ownerConfigurationRef,
          quantity: assertion.quantity,
        },
        revision: 2,
      });
      let repairedTargetId = positionTwoId;
      const service = makeInventorySourceConflictService({
        assertions: { findById: () => Effect.succeedSome(assertion) },
        backendConfigurations: { findCurrent: () => Effect.succeedSome(factValueCandidate().selectedConfiguration) },
        conflicts: {
          appendOpen: () => Effect.die('not used'),
          appendResolution: (_expected, resolved) => Effect.succeed(resolved),
          findLatest: () => Effect.succeedSome(open),
        },
        correlations: {
          resolve: ({ externalKey: sourceKey }) =>
            Effect.succeed(
              Schema.decodeUnknownSync(ExternalStockCorrelationResolutionSchema)({
                _tag: 'RESOLVED',
                correlationRef: assertion.itemCorrelationRef,
                effectivePeriod: { from: selectedAt, to: null },
                externalKey: sourceKey,
                selectedBackendOriginMatch: 'MATCHES_SELECTED_BACKEND',
                target: { _tag: 'STOCK_ITEM', ref: { ...stockItemRef, resourceId: repairedTargetId } },
              }),
            ),
        },
        positions: { read: () => Effect.succeedSome(currentPosition), save: () => Effect.die('must not save') },
      });
      const resolutionInput = Schema.decodeUnknownSync(InventorySourceConflictResolutionInputSchema)({
        conflictRef: open.conflictRef,
        expectedRevision: 1,
        ownerEvidenceRef: 'owner-correlation-repair',
        resolution: { _tag: 'CURRENT_ASSERTION', assertionId: assertion.assertionId },
        resolvedAt: '2026-09-24T11:00:00.000Z',
      });
      const mismatch = yield* Effect.flip(service.resolve(resolutionInput, { principalId: 'principal-a', tenantId }));
      expectRejectedReason(mismatch, 'CURRENT_RESULT_NOT_ESTABLISHED');

      repairedTargetId = itemId;
      const resolved = yield* service.resolve(resolutionInput, { principalId: 'principal-a', tenantId });

      expect(resolved.status).toBe('RESOLVED');
      expect(resolved.currentTruth).toBe('CURRENT');
      expect(Schema.is(ExternalCorrelationConflictScopeSchema)(resolved.scope)).toBe(true);
    }),
  );
});
