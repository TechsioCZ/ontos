import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CatalogStockDemandSchema,
  CatalogToStockBindingCandidateSchema,
  CatalogToStockBindingEndInputSchema,
  CatalogToStockBindingLifecycleEvidenceSchema,
  CatalogToStockBindingRejected,
  CatalogToStockBindingSchema,
  makeCatalogToStockBindingLifecycle,
  makeCatalogToStockBindingResolver,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import type {
  CatalogToStockBinding,
  CatalogToStockBindingHistoryEntry,
  CatalogToStockBindingPersistence,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const bindingId = '22222222-2222-4222-8222-222222222222';
const stockItemId = '33333333-3333-4333-8333-333333333333';
const unitId = '44444444-4444-4444-8444-444444444444';
const timestamp = '2026-09-24T10:00:00.000Z';
const lifecycleEvidence = Schema.decodeUnknownSync(CatalogToStockBindingLifecycleEvidenceSchema)({
  authority: 'INVENTORY_BINDING_OWNER',
  ownerEvidenceRef: 'binding-owner-evidence-1',
});

const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const configuredSelectionAtDefinitionRevision = (revision: number) =>
  Schema.decodeUnknownSync(CatalogSelectionSchema)({
    ...selection,
    configuration: {
      choices: [
        {
          choiceKey: 'engraving',
          unit: {
            resourceRef: {
              moduleId: 'commerce.catalog',
              resourceId: '99999999-9999-4999-8999-999999999999',
              resourceType: 'commerce.catalog.unit',
              tenantId,
            },
            revision: 3,
          },
          value: 'ALPHA',
        },
      ],
      definition: {
        resourceRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          resourceType: 'commerce.catalog.configuration-definition',
          tenantId,
        },
        revision,
      },
      productRef: selection.productRef,
      variantRef: selection.variantRef,
    },
  });
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' } as const;
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: timestamp,
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef: {
    moduleId: 'commerce.inventory',
    resourceId: stockItemId,
    resourceType: 'commerce.inventory.stock-item',
    tenantId,
  },
  unitRef,
});
const binding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
  bindingRef: {
    moduleId: 'commerce.inventory',
    resourceId: bindingId,
    resourceType: 'commerce.inventory.catalog-to-stock-binding',
    tenantId,
  },
  catalogSelection: selection,
  effectiveFrom: timestamp,
  exactSelectionMeaning,
  revision: 1,
  stockItemRef: stockItem.stockItemRef,
  unitRef,
});
const demand = Schema.decodeUnknownSync(CatalogStockDemandSchema)({
  catalogSelection: selection,
  exactSelectionMeaning,
  purchaseDemandOccurrenceId: 'purchase-demand-occurrence-1',
  quantity: '2.50',
  unitRef,
});

describe('Catalog-to-Stock Binding resolution', () => {
  it.effect('resolves one exact Selection before allocation and preserves occurrence, Quantity, and Unit', () =>
    Effect.gen(function* resolveExactSelection() {
      const resolver = makeCatalogToStockBindingResolver(
        {
          findCurrentByExactSelectionMeaning: () => Effect.succeed([binding]),
        },
        {
          findById: () => Effect.succeed(Option.some(stockItem)),
        },
      );

      const resolved = yield* resolver.resolve(demand);

      expect(resolved).toEqual({
        bindingRef: binding.bindingRef,
        catalogSelection: selection,
        exactSelectionMeaning,
        purchaseDemandOccurrenceId: demand.purchaseDemandOccurrenceId,
        quantity: demand.quantity,
        stockItem,
        unitRef,
      });
      expect(resolved).not.toHaveProperty('stockLocation');
      expect(resolved).not.toHaveProperty('availability');
    }),
  );

  it.effect('returns typed non-success for missing and conflicting Current relations without guessing', () =>
    Effect.gen(function* rejectMissingOrMultiple() {
      const stockItems = { findById: () => Effect.succeed(Option.some(stockItem)) };
      const missing = yield* makeCatalogToStockBindingResolver(
        { findCurrentByExactSelectionMeaning: () => Effect.succeed([]) },
        stockItems,
      )
        .resolve(demand)
        .pipe(Effect.flip);
      const multiple = yield* makeCatalogToStockBindingResolver(
        { findCurrentByExactSelectionMeaning: () => Effect.succeed([binding, binding]) },
        stockItems,
      )
        .resolve(demand)
        .pipe(Effect.flip);

      expect(missing).toBeInstanceOf(CatalogToStockBindingRejected);
      expect(missing.reason).toBe('MISSING_BINDING');
      expect(multiple).toBeInstanceOf(CatalogToStockBindingRejected);
      expect(multiple.reason).toBe('MULTIPLE_CURRENT_BINDINGS');
    }),
  );

  it.effect('rejects an erroneous relation whose target carries a different intrinsic meaning', () =>
    Effect.gen(function* rejectMeaningMismatch() {
      const incompatibleItem = Schema.decodeUnknownSync(StockItemSchema)({
        ...stockItem,
        exactSelectionMeaning: { id: 'catalog-owner:different-meaning', kind: 'PRODUCT_VARIANT' },
      });
      const error = yield* makeCatalogToStockBindingResolver(
        { findCurrentByExactSelectionMeaning: () => Effect.succeed([binding]) },
        { findById: () => Effect.succeed(Option.some(incompatibleItem)) },
      )
        .resolve(demand)
        .pipe(Effect.flip);

      expect(Schema.is(CatalogToStockBindingRejected)(error)).toBe(true);
      expect(error).toMatchObject({
        reason: 'INTRINSIC_MEANING_MISMATCH',
        stockItemRef: incompatibleItem.stockItemRef,
      });
      expect(incompatibleItem.exactSelectionMeaning.id).toBe('catalog-owner:different-meaning');
    }),
  );

  it.effect('rejects Unit substitution instead of converting the requested Quantity', () =>
    Effect.gen(function* rejectUnitSubstitution() {
      const otherUnitDemand = Schema.decodeUnknownSync(CatalogStockDemandSchema)({
        ...demand,
        unitRef: { ...unitRef, resourceId: '88888888-8888-4888-8888-888888888888' },
      });
      const error = yield* makeCatalogToStockBindingResolver(
        { findCurrentByExactSelectionMeaning: () => Effect.succeed([binding]) },
        { findById: () => Effect.succeed(Option.some(stockItem)) },
      )
        .resolve(otherUnitDemand)
        .pipe(Effect.flip);

      expect(Schema.is(CatalogToStockBindingRejected)(error)).toBe(true);
      expect(error.reason).toBe('STOCK_UNIT_MISMATCH');
      expect(otherUnitDemand.quantity).toBe('2.50');
    }),
  );

  it.effect('distinguishes a missing Stock Item target from a retired target', () =>
    Effect.gen(function* rejectMissingOrRetiredTarget() {
      const missing = yield* makeCatalogToStockBindingResolver(
        { findCurrentByExactSelectionMeaning: () => Effect.succeed([binding]) },
        { findById: () => Effect.succeedNone },
      )
        .resolve(demand)
        .pipe(Effect.flip);
      const retiredItem = Schema.decodeUnknownSync(StockItemSchema)({
        ...stockItem,
        lifecycle: 'RETIRED',
        retiredAt: '2026-09-24T11:00:00.000Z',
        revision: 2,
      });
      const retired = yield* makeCatalogToStockBindingResolver(
        { findCurrentByExactSelectionMeaning: () => Effect.succeed([binding]) },
        { findById: () => Effect.succeed(Option.some(retiredItem)) },
      )
        .resolve(demand)
        .pipe(Effect.flip);

      expect(Schema.is(CatalogToStockBindingRejected)(missing)).toBe(true);
      expect(missing.reason).toBe('STOCK_ITEM_NOT_FOUND');
      expect(Schema.is(CatalogToStockBindingRejected)(retired)).toBe(true);
      expect(retired.reason).toBe('STOCK_ITEM_NOT_CURRENT');
    }),
  );
});

const bindingsForSelectionMeaning = (
  bindings: readonly CatalogToStockBinding[],
  requestedTenantId: string,
  requestedMeaning: CatalogToStockBinding['exactSelectionMeaning'],
) =>
  bindings.filter(
    (candidate) =>
      candidate.bindingRef.tenantId === requestedTenantId && candidate.exactSelectionMeaning.id === requestedMeaning.id,
  );

const bindingForStockItem = (
  bindings: readonly CatalogToStockBinding[],
  stockItemRef: CatalogToStockBinding['stockItemRef'],
) =>
  Option.fromNullishOr(
    bindings.find(
      (candidate) =>
        candidate.stockItemRef.tenantId === stockItemRef.tenantId &&
        candidate.stockItemRef.resourceId === stockItemRef.resourceId,
    ),
  );

const replaceMemoryBinding = (
  currentState: Ref.Ref<readonly CatalogToStockBinding[]>,
  historyState: Ref.Ref<readonly CatalogToStockBindingHistoryEntry[]>,
  input: Parameters<CatalogToStockBindingPersistence['replaceCurrent']>[0],
) =>
  Effect.gen(function* replaceBinding() {
    yield* Ref.update(historyState, (entries) => [...entries, input.historyEntry]);
    yield* Ref.update(currentState, (bindings) =>
      bindings.map((candidate) =>
        candidate.bindingRef.resourceId === input.current.bindingRef.resourceId ? input.next : candidate,
      ),
    );
    return input.next;
  });

const endMemoryBinding = (
  currentState: Ref.Ref<readonly CatalogToStockBinding[]>,
  historyState: Ref.Ref<readonly CatalogToStockBindingHistoryEntry[]>,
  input: Parameters<CatalogToStockBindingPersistence['endCurrent']>[0],
) =>
  Effect.gen(function* archiveAndRemoveBinding() {
    yield* Ref.update(historyState, (entries) => [...entries, input.historyEntry]);
    yield* Ref.update(currentState, (bindings) =>
      bindings.filter((candidate) => candidate.bindingRef.resourceId !== input.current.bindingRef.resourceId),
    );
    return input.historyEntry;
  });

const makeMemoryPersistence = (initial: readonly CatalogToStockBinding[] = []) =>
  Effect.gen(function* makePersistence() {
    const current = yield* Ref.make<readonly CatalogToStockBinding[]>(initial);
    const history = yield* Ref.make<readonly CatalogToStockBindingHistoryEntry[]>([]);
    const persistence: CatalogToStockBindingPersistence = {
      endCurrent: (input) => endMemoryBinding(current, history, input),
      findCurrentByExactSelectionMeaning: (requestedTenantId, requestedMeaning) =>
        Ref.get(current).pipe(
          Effect.map((bindings) => bindingsForSelectionMeaning(bindings, requestedTenantId, requestedMeaning)),
        ),
      findCurrentByStockItem: (stockItemRef) =>
        Ref.get(current).pipe(Effect.map((bindings) => bindingForStockItem(bindings, stockItemRef))),
      insertCurrent: (candidate) =>
        Ref.update(current, (bindings) => [...bindings, candidate]).pipe(Effect.as(candidate)),
      readHistory: () => Ref.get(history),
      replaceCurrent: (input) => replaceMemoryBinding(current, history, input),
    };
    return persistence;
  });

describe('Catalog-to-Stock Binding lifecycle', () => {
  it.effect('creates a Current relation from the exact Selection without inventing a Selection ID', () =>
    Effect.gen(function* bindExactSelection() {
      const persistence = yield* makeMemoryPersistence();
      const lifecycle = makeCatalogToStockBindingLifecycle(persistence, {
        makeBindingId: () => bindingId,
        now: Effect.succeed(timestamp),
      });
      const candidate = Schema.decodeUnknownSync(CatalogToStockBindingCandidateSchema)({
        catalogSelection: selection,
        exactSelectionMeaning,
        stockItem,
      });

      const created = yield* lifecycle.establish(candidate);

      expect(created).toMatchObject({
        bindingRef: binding.bindingRef,
        catalogSelection: selection,
        exactSelectionMeaning,
        revision: 1,
        stockItemRef: stockItem.stockItemRef,
        unitRef,
      });
      expect(created).not.toHaveProperty('catalogSelectionId');
    }),
  );

  it.effect('treats a newer Configuration Definition revision as evidence, not a second stock identity', () =>
    Effect.gen(function* preserveConfiguredMeaningIdentity() {
      const firstSelection = configuredSelectionAtDefinitionRevision(7);
      const newerEvidence = configuredSelectionAtDefinitionRevision(8);
      const configuredMeaning = {
        id: 'catalog-owner:configured-selection-meaning-1',
        kind: 'CONFIGURED_SELECTION',
      } as const;
      const configuredItem = Schema.decodeUnknownSync(StockItemSchema)({
        ...stockItem,
        exactSelectionMeaning: configuredMeaning,
      });
      const configuredBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
        ...binding,
        catalogSelection: firstSelection,
        exactSelectionMeaning: configuredMeaning,
      });
      const persistence = yield* makeMemoryPersistence([configuredBinding]);
      const resolution = yield* makeCatalogToStockBindingResolver(persistence, {
        findById: () => Effect.succeed(Option.some(configuredItem)),
      }).resolve(
        Schema.decodeUnknownSync(CatalogStockDemandSchema)({
          ...demand,
          catalogSelection: newerEvidence,
          exactSelectionMeaning: configuredMeaning,
        }),
      );
      const duplicate = yield* makeCatalogToStockBindingLifecycle(persistence, {
        makeBindingId: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        now: Effect.succeed('2026-09-24T12:00:00.000Z'),
      })
        .establish(
          Schema.decodeUnknownSync(CatalogToStockBindingCandidateSchema)({
            catalogSelection: newerEvidence,
            exactSelectionMeaning: configuredMeaning,
            stockItem: configuredItem,
          }),
        )
        .pipe(Effect.flip);

      expect(firstSelection.configuration?.definition.revision).toBe(7);
      expect(newerEvidence.configuration?.definition.revision).toBe(8);
      expect(resolution.stockItem.stockItemRef).toEqual(configuredItem.stockItemRef);
      expect(resolution.catalogSelection).toEqual(newerEvidence);
      expect(Schema.is(CatalogToStockBindingRejected)(duplicate)).toBe(true);
      expect(duplicate.reason).toBe('SELECTION_MEANING_ALREADY_BOUND');
    }),
  );

  it.effect('corrects only the Current relation and appends immutable history without mutating either Stock Item', () =>
    Effect.gen(function* correctRelation() {
      const erroneousItem = Schema.decodeUnknownSync(StockItemSchema)({
        ...stockItem,
        exactSelectionMeaning: { id: 'catalog-owner:wrong-meaning', kind: 'PRODUCT_VARIANT' },
      });
      const erroneousBinding = Schema.decodeUnknownSync(CatalogToStockBindingSchema)({
        ...binding,
        exactSelectionMeaning,
        stockItemRef: erroneousItem.stockItemRef,
      });
      const replacementItem = Schema.decodeUnknownSync(StockItemSchema)({
        ...stockItem,
        stockItemRef: { ...stockItem.stockItemRef, resourceId: '77777777-7777-4777-8777-777777777777' },
      });
      const persistence = yield* makeMemoryPersistence([erroneousBinding]);
      const lifecycle = makeCatalogToStockBindingLifecycle(persistence, {
        makeBindingId: () => bindingId,
        now: Effect.succeed('2026-09-24T11:00:00.000Z'),
      });
      const candidate = Schema.decodeUnknownSync(CatalogToStockBindingCandidateSchema)({
        catalogSelection: selection,
        exactSelectionMeaning,
        stockItem: replacementItem,
      });

      const corrected = yield* lifecycle.correct({ candidate, evidence: lifecycleEvidence });
      const history = yield* persistence.readHistory(corrected.bindingRef);

      expect(corrected).toMatchObject({
        bindingRef: erroneousBinding.bindingRef,
        exactSelectionMeaning,
        revision: 2,
        stockItemRef: replacementItem.stockItemRef,
      });
      expect(history).toEqual([
        {
          binding: erroneousBinding,
          endedAt: '2026-09-24T11:00:00.000Z',
          ownerEvidenceRef: lifecycleEvidence.ownerEvidenceRef,
          transition: 'CORRECTED',
        },
      ]);
      expect(erroneousItem.exactSelectionMeaning.id).toBe('catalog-owner:wrong-meaning');
      expect(replacementItem.exactSelectionMeaning).toEqual(exactSelectionMeaning);
    }),
  );

  it.effect('rejects correction that changes exact meaning kind or Stock Unit instead of only the relation', () =>
    Effect.gen(function* rejectMeaningOrUnitChange() {
      const replacementRef = { ...stockItem.stockItemRef, resourceId: '77777777-7777-4777-8777-777777777777' };
      const changedKind = { ...exactSelectionMeaning, kind: 'SET_VARIANT' } as const;
      const changedUnit = { ...unitRef, resourceId: '88888888-8888-4888-8888-888888888888' };
      const cases = [
        {
          candidate: Schema.decodeUnknownSync(CatalogToStockBindingCandidateSchema)({
            catalogSelection: selection,
            exactSelectionMeaning: changedKind,
            stockItem: { ...stockItem, exactSelectionMeaning: changedKind, stockItemRef: replacementRef },
          }),
          reason: 'INTRINSIC_MEANING_MISMATCH',
        },
        {
          candidate: Schema.decodeUnknownSync(CatalogToStockBindingCandidateSchema)({
            catalogSelection: selection,
            exactSelectionMeaning,
            stockItem: { ...stockItem, stockItemRef: replacementRef, unitRef: changedUnit },
          }),
          reason: 'STOCK_UNIT_MISMATCH',
        },
      ] as const;

      for (const { candidate, reason } of cases) {
        const persistence = yield* makeMemoryPersistence([binding]);
        const lifecycle = makeCatalogToStockBindingLifecycle(persistence, {
          makeBindingId: () => bindingId,
          now: Effect.succeed('2026-09-24T11:00:00.000Z'),
        });

        const failure = yield* lifecycle.correct({ candidate, evidence: lifecycleEvidence }).pipe(Effect.flip);
        const current = yield* persistence.findCurrentByExactSelectionMeaning(tenantId, binding.exactSelectionMeaning);
        const history = yield* persistence.readHistory(binding.bindingRef);

        expect(failure).toMatchObject({ reason });
        expect(current).toEqual([binding]);
        expect(history).toEqual([]);
      }
    }),
  );

  it.effect('rejects correction and end timestamps that are not later than the Current revision', () =>
    Effect.gen(function* rejectNonMonotonicTransitions() {
      const replacementItem = Schema.decodeUnknownSync(StockItemSchema)({
        ...stockItem,
        stockItemRef: { ...stockItem.stockItemRef, resourceId: '77777777-7777-4777-8777-777777777777' },
      });
      const candidate = Schema.decodeUnknownSync(CatalogToStockBindingCandidateSchema)({
        catalogSelection: selection,
        exactSelectionMeaning,
        stockItem: replacementItem,
      });

      const correctionPersistence = yield* makeMemoryPersistence([binding]);
      const correctionLifecycle = makeCatalogToStockBindingLifecycle(correctionPersistence, {
        makeBindingId: () => bindingId,
        now: Effect.succeed(timestamp),
      });
      const correctionFailure = yield* correctionLifecycle
        .correct({ candidate, evidence: lifecycleEvidence })
        .pipe(Effect.flip);

      const endPersistence = yield* makeMemoryPersistence([binding]);
      const endLifecycle = makeCatalogToStockBindingLifecycle(endPersistence, {
        makeBindingId: () => bindingId,
        now: Effect.succeed(timestamp),
      });
      const endFailure = yield* endLifecycle
        .end(
          Schema.decodeUnknownSync(CatalogToStockBindingEndInputSchema)({
            bindingRef: binding.bindingRef,
            disposition: 'ENDED',
            evidence: lifecycleEvidence,
            exactSelectionMeaning,
          }),
        )
        .pipe(Effect.flip);

      expect(correctionFailure).toMatchObject({ reason: 'TRANSITION_TIME_NOT_AFTER_CURRENT' });
      expect(endFailure).toMatchObject({ reason: 'TRANSITION_TIME_NOT_AFTER_CURRENT' });
      expect(yield* correctionPersistence.readHistory(binding.bindingRef)).toEqual([]);
      expect(yield* endPersistence.readHistory(binding.bindingRef)).toEqual([]);
    }),
  );

  it.effect('ends or supersedes a Current relation by archiving it without inferring a replacement', () =>
    Effect.gen(function* endRelation() {
      for (const disposition of ['ENDED', 'SUPERSEDED'] as const) {
        const persistence = yield* makeMemoryPersistence([binding]);
        const lifecycle = makeCatalogToStockBindingLifecycle(persistence, {
          makeBindingId: () => bindingId,
          now: Effect.succeed('2026-09-24T11:00:00.000Z'),
        });
        const input = Schema.decodeUnknownSync(CatalogToStockBindingEndInputSchema)({
          bindingRef: binding.bindingRef,
          disposition,
          evidence: lifecycleEvidence,
          exactSelectionMeaning,
        });

        const ended = yield* lifecycle.end(input);
        const current = yield* persistence.findCurrentByExactSelectionMeaning(tenantId, binding.exactSelectionMeaning);
        const history = yield* persistence.readHistory(binding.bindingRef);

        expect(ended).toEqual({
          disposition,
          historyEntry: {
            binding,
            endedAt: '2026-09-24T11:00:00.000Z',
            ownerEvidenceRef: lifecycleEvidence.ownerEvidenceRef,
            transition: disposition,
          },
        });
        expect(current).toEqual([]);
        expect(history).toEqual([ended.historyEntry]);
      }
    }),
  );
});
