import { Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ExternalStockLocationKeySchema,
  LogicalAggregateScopeSchema,
  MergedLifecycleSchema,
  ReplacedLifecycleSchema,
  StockLocationSchema,
  StockLocationTransitionRejected,
  transitionStockLocation,
} from '../../shared/domain/stock-location.ts';
import { StockLocationRefSchema } from '../../shared/resources/stock-location.ts';
import type {
  StockLocationCorrelationReader,
  StockLocationPersistence,
} from '../../src/persistence/stock-location-repository.ts';
import { StockLocationPersistenceRejected } from '../../src/persistence/stock-location-persistence-rejected.ts';
import {
  StockLocationCorrelationUnresolved,
  makeStockLocationCorrelationResolver,
  makeStockLocationService,
} from '../../src/services/stock-location-service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const locationAId = '22222222-2222-4222-8222-222222222222';
const locationBId = '33333333-3333-4333-8333-333333333333';
const locationCId = '44444444-4444-4444-8444-444444444444';
const timestamp = '2026-09-24T10:00:00.000Z';

const decodeLocation = Schema.decodeUnknownSync(StockLocationSchema, { onExcessProperty: 'error' });
const decodeRef = Schema.decodeUnknownSync(StockLocationRefSchema, { onExcessProperty: 'error' });
const decodeExternalKey = Schema.decodeUnknownSync(ExternalStockLocationKeySchema, {
  onExcessProperty: 'error',
});

const locationRef = (resourceId: string) =>
  decodeRef({
    moduleId: 'commerce.inventory',
    resourceId,
    resourceType: 'commerce.inventory.stock-location',
    tenantId,
  });

const location = (input: {
  readonly displayName: string;
  readonly physicalSiteKeys: readonly string[];
  readonly ref: ReturnType<typeof locationRef>;
  readonly scopeKind: 'LOGICAL_AGGREGATE' | 'PHYSICAL_SITE';
}) =>
  decodeLocation({
    addressEvidence: {
      countryCode: 'CZ',
      lines: ['Průmyslová 12'],
      locality: 'Praha',
      postalCode: '10200',
    },
    displayName: input.displayName,
    lifecycle: { _tag: 'ACTIVE' },
    operationalScope: {
      _tag: input.scopeKind,
      physicalSiteKeys: input.physicalSiteKeys,
    },
    ref: input.ref,
    revision: 1,
  });

describe('Inventory Stock Location domain', () => {
  it('keeps same-address operational scopes as distinct durable Resources', () => {
    const first = location({
      displayName: 'Receiving',
      physicalSiteKeys: ['site-prague-receiving'],
      ref: locationRef(locationAId),
      scopeKind: 'PHYSICAL_SITE',
    });
    const second = location({
      displayName: 'Saleable stock',
      physicalSiteKeys: ['site-prague-saleable'],
      ref: locationRef(locationBId),
      scopeKind: 'PHYSICAL_SITE',
    });

    expect(first.addressEvidence).toEqual(second.addressEvidence);
    expect(first.ref).not.toEqual(second.ref);
  });

  it('allows several physical sites only as one declared indivisible logical scope', () => {
    const aggregate = location({
      displayName: 'Authoritative regional pool',
      physicalSiteKeys: ['warehouse-prague', 'warehouse-brno'],
      ref: locationRef(locationAId),
      scopeKind: 'LOGICAL_AGGREGATE',
    });

    expect(Schema.is(LogicalAggregateScopeSchema)(aggregate.operationalScope)).toBe(true);
    expect(aggregate.operationalScope.physicalSiteKeys).toEqual(['warehouse-prague', 'warehouse-brno']);
    expect(() =>
      location({
        displayName: 'Invalid physical scope',
        physicalSiteKeys: ['warehouse-prague', 'warehouse-brno'],
        ref: locationRef(locationBId),
        scopeKind: 'PHYSICAL_SITE',
      }),
    ).toThrow();
  });

  it.effect('retires, replaces, and merges without rewriting the historical Resource identity', () =>
    Effect.gen(function* preserveHistoricalIdentity() {
      const original = location({
        displayName: 'Legacy pool',
        physicalSiteKeys: ['legacy-pool'],
        ref: locationRef(locationAId),
        scopeKind: 'LOGICAL_AGGREGATE',
      });
      const replacementRef = locationRef(locationBId);
      const survivorRef = locationRef(locationCId);

      const retired = yield* transitionStockLocation(original, {
        _tag: 'RETIRE',
        reason: 'The authoritative owner retired this scope.',
        transitionedAt: timestamp,
      });
      const replaced = yield* transitionStockLocation(original, {
        _tag: 'REPLACE',
        reason: 'The authoritative owner introduced a new scope.',
        successorRef: replacementRef,
        transitionedAt: timestamp,
      });
      const merged = yield* transitionStockLocation(original, {
        _tag: 'MERGE',
        reason: 'The authoritative owner merged the scopes.',
        successorRef: survivorRef,
        transitionedAt: timestamp,
      });

      expect(retired.ref).toEqual(original.ref);
      expect(replaced.ref).toEqual(original.ref);
      expect(Schema.is(ReplacedLifecycleSchema)(replaced.lifecycle)).toBe(true);
      expect('successorRef' in replaced.lifecycle ? replaced.lifecycle.successorRef : undefined).toEqual(
        replacementRef,
      );
      expect(merged.ref).toEqual(original.ref);
      expect(Schema.is(MergedLifecycleSchema)(merged.lifecycle)).toBe(true);
      expect('successorRef' in merged.lifecycle ? merged.lifecycle.successorRef : undefined).toEqual(survivorRef);
      expect(retired.revision).toBe(2);
    }),
  );

  it.effect('rejects a lifecycle rewrite after a location reaches a terminal state', () =>
    Effect.gen(function* rejectTerminalRewrite() {
      const original = location({
        displayName: 'Retired pool',
        physicalSiteKeys: [],
        ref: locationRef(locationAId),
        scopeKind: 'LOGICAL_AGGREGATE',
      });
      const retired = yield* transitionStockLocation(original, {
        _tag: 'RETIRE',
        reason: 'No longer authoritative.',
        transitionedAt: timestamp,
      });
      const failure = yield* transitionStockLocation(retired, {
        _tag: 'REPLACE',
        reason: 'Too late to rewrite the old identity.',
        successorRef: locationRef(locationBId),
        transitionedAt: timestamp,
      }).pipe(Effect.flip);

      expect(Schema.is(StockLocationTransitionRejected)(failure)).toBe(true);
      expect(failure.reason).toBe('TERMINAL_LIFECYCLE');
    }),
  );
});

describe('Inventory Stock Location services', () => {
  it.effect('returns a typed unresolved result for unknown legacy store=3 and never guesses', () =>
    Effect.gen(function* unknownLegacyStore() {
      const source = decodeExternalKey({
        externalValue: '3',
        identifierKind: 'store',
        issuerId: 'legacy-erp',
        issuerKind: 'EXTERNAL_BUSINESS_SYSTEM',
        namespace: 'inventory-location',
        tenantId,
      });
      const reader: StockLocationCorrelationReader = {
        readExplicit: () => Effect.succeed([]),
      };
      const resolver = makeStockLocationCorrelationResolver(reader);

      const failure = yield* resolver.resolve(source).pipe(Effect.flip);

      expect(Schema.is(StockLocationCorrelationUnresolved)(failure)).toBe(true);
      expect(failure).toMatchObject({ reason: 'NO_EXPLICIT_CORRELATION', source });
    }),
  );

  it.effect('resolves only an exact explicit correlation and keeps the external value out of identity', () =>
    Effect.gen(function* explicitCorrelationOnly() {
      const ref = locationRef(locationAId);
      const source = decodeExternalKey({
        externalValue: '3',
        identifierKind: 'store',
        issuerId: 'legacy-erp',
        issuerKind: 'EXTERNAL_BUSINESS_SYSTEM',
        namespace: 'inventory-location',
        tenantId,
      });
      const reader: StockLocationCorrelationReader = {
        readExplicit: () =>
          Effect.succeed([
            {
              correlationId: '55555555-5555-4555-8555-555555555555',
              locationRef: ref,
              source,
            },
          ]),
      };
      const resolved = yield* makeStockLocationCorrelationResolver(reader).resolve(source);

      expect(resolved).toEqual({
        correlation: {
          correlationId: '55555555-5555-4555-8555-555555555555',
          locationRef: ref,
          source,
        },
        locationRef: ref,
        source,
        status: 'RESOLVED',
      });
      expect(resolved.locationRef.resourceId).not.toBe(source.externalValue);
    }),
  );

  it.effect('persists a terminal transition with optimistic revision evidence', () =>
    Effect.gen(function* persistTransition() {
      const current = location({
        displayName: 'Temporary pool',
        physicalSiteKeys: ['temporary'],
        ref: locationRef(locationAId),
        scopeKind: 'PHYSICAL_SITE',
      });
      const state = yield* Ref.make(current);
      const persistence: StockLocationPersistence = {
        create: () =>
          Effect.fail(new StockLocationPersistenceRejected({ locationRef: current.ref, reason: 'IDENTITY_CONFLICT' })),
        read: () => Ref.get(state).pipe(Effect.map(Option.some)),
        readHistory: () => Ref.get(state).pipe(Effect.map((observed) => [observed])),
        saveTransition: ({ expectedRevision, next }) =>
          Effect.gen(function* saveWithExpectedRevision() {
            const observed = yield* Ref.get(state);
            if (observed.revision !== expectedRevision) {
              return yield* new StockLocationPersistenceRejected({
                actualRevision: observed.revision,
                locationRef: observed.ref,
                reason: 'REVISION_CONFLICT',
              });
            }
            yield* Ref.set(state, next);
            return next;
          }),
      };
      const service = makeStockLocationService(persistence);

      const retired = yield* service.transition(current.ref, {
        _tag: 'RETIRE',
        reason: 'Temporary scope closed.',
        transitionedAt: timestamp,
      });

      expect(retired.ref).toEqual(current.ref);
      expect(retired.revision).toBe(2);
      expect(yield* Ref.get(state)).toEqual(retired);
    }),
  );
});
