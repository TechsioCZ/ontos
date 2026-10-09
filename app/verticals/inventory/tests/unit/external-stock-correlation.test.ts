import { Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  AmbiguousExternalStockCorrelationSchema,
  ExternalStockCorrelationSchema,
  ExternalStockItemTargetSchema,
  ExternalStockKeySchema,
  ExternalStockTargetSchema,
  makeExternalStockCorrelationLifecycle,
  makeExternalStockCorrelationResolver,
  ResolvedExternalStockCorrelationSchema,
  UnresolvedExternalStockCorrelationSchema,
} from '../../shared/domain/external-stock-correlation.ts';
import type {
  ExternalStockCorrelation,
  ExternalStockCorrelationPersistence,
  ExternalStockKey,
} from '../../shared/domain/external-stock-correlation.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const itemId = '22222222-2222-4222-8222-222222222222';
const currentInstant = '2026-09-24T10:00:00.000Z';
const correctionInstant = '2026-09-24T11:00:00.000Z';
const endInstant = '2026-09-24T12:00:00.000Z';

const decodeKey = Schema.decodeUnknownSync(ExternalStockKeySchema, { onExcessProperty: 'error' });
const decodeCorrelation = Schema.decodeUnknownSync(ExternalStockCorrelationSchema, { onExcessProperty: 'error' });

const itemKey = decodeKey({
  customerConfigurationId: 'customer-configuration:primary',
  externalScope: 'warehouse:prague',
  externalValue: 'ABC123',
  identifierKind: 'ITEM',
  issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
  namespace: 'inventory',
  tenantId,
});
const selectedConfiguration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId: '99999999-9999-4999-8999-999999999999',
  customerConfigurationId: itemKey.customerConfigurationId,
  revision: 1,
  selectedAt: currentInstant,
  selection: {
    backend: itemKey.issuer.backendKind,
    backendId: itemKey.issuer.backendId,
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'UNSUPPORTED',
  },
  tenantId,
});

const itemTarget = {
  _tag: 'STOCK_ITEM',
  ref: {
    moduleId: 'commerce.inventory',
    resourceId: itemId,
    resourceType: 'commerce.inventory.stock-item',
    tenantId,
  },
} as const;

const correlation = (overrides: Partial<ExternalStockCorrelation> = {}) =>
  decodeCorrelation({
    confirmedAt: currentInstant,
    correlationRef: {
      moduleId: 'commerce.inventory',
      resourceId: '44444444-4444-4444-8444-444444444444',
      resourceType: 'commerce.inventory.external-stock-correlation',
      tenantId,
    },
    effectivePeriod: { from: currentInstant, to: null },
    externalKey: itemKey,
    lifecycle: 'CURRENT',
    ownerEvidenceRef: 'erp-a:correlation-proof:1',
    revision: 1,
    target: itemTarget,
    ...overrides,
  });

describe('Inventory External Stock Correlation resolution', () => {
  it.effect('resolves only the exact issuer-qualified key to the stable Inventory target', () =>
    Effect.gen(function* resolveExactKey() {
      const expected = correlation();
      const resolver = makeExternalStockCorrelationResolver({
        findEffective: () => Effect.succeed([expected]),
      });

      const resolved = yield* resolver.resolve({
        asOf: currentInstant,
        externalKey: itemKey,
        selectedConfiguration,
      });

      expect(Schema.is(ResolvedExternalStockCorrelationSchema)(resolved)).toBe(true);
      if (!Schema.is(ResolvedExternalStockCorrelationSchema)(resolved)) {
        return;
      }
      expect(resolved).toMatchObject({
        correlationRef: expected.correlationRef,
        effectivePeriod: expected.effectivePeriod,
        externalKey: itemKey,
        selectedBackendOriginMatch: 'MATCHES_SELECTED_BACKEND',
        target: itemTarget,
      });
      expect(resolved.target.ref.resourceId).not.toBe(itemKey.externalValue);
      expect(resolved).not.toHaveProperty('authority');
      expect(resolved).not.toHaveProperty('authoritativeStockAssertion');
    }),
  );

  it.effect('keeps equal visible IDs distinct by issuer, namespace, scope, and identifier kind', () =>
    Effect.gen(function* keepQualifiedKeysDistinct() {
      const seen: unknown[] = [];
      const resolver = makeExternalStockCorrelationResolver({
        findEffective: (externalKey) => {
          seen.push(externalKey);
          return Effect.succeed([]);
        },
      });
      const locationKey = decodeKey({
        ...itemKey,
        identifierKind: 'LOCATION',
      });
      const otherNamespaceKey = decodeKey({ ...itemKey, namespace: 'warehouse-master' });
      const otherScopeKey = decodeKey({ ...itemKey, externalScope: 'warehouse:brno' });
      const replacementIssuerKey = decodeKey({
        ...itemKey,
        issuer: { backendId: 'erp-b', backendKind: 'external_business_system' },
      });

      const itemOutcome = yield* resolver.resolve({
        asOf: currentInstant,
        externalKey: itemKey,
        selectedConfiguration,
      });
      const locationOutcome = yield* resolver.resolve({
        asOf: currentInstant,
        externalKey: locationKey,
        selectedConfiguration,
      });
      const replacementIssuerOutcome = yield* resolver.resolve({
        asOf: currentInstant,
        externalKey: replacementIssuerKey,
        selectedConfiguration,
      });
      yield* resolver.resolve({
        asOf: currentInstant,
        externalKey: otherNamespaceKey,
        selectedConfiguration,
      });
      yield* resolver.resolve({
        asOf: currentInstant,
        externalKey: otherScopeKey,
        selectedConfiguration,
      });

      expect(Schema.is(UnresolvedExternalStockCorrelationSchema)(itemOutcome)).toBe(true);
      expect(Schema.is(UnresolvedExternalStockCorrelationSchema)(locationOutcome)).toBe(true);
      expect(Schema.is(UnresolvedExternalStockCorrelationSchema)(replacementIssuerOutcome)).toBe(true);
      expect(seen).toEqual([itemKey, locationKey, replacementIssuerKey, otherNamespaceKey, otherScopeKey]);
    }),
  );

  it.effect('returns AMBIGUOUS for overlapping targets and never picks one', () =>
    Effect.gen(function* rejectOverlappingTargets() {
      const first = correlation();
      const second = decodeCorrelation({
        ...first,
        correlationRef: {
          ...first.correlationRef,
          resourceId: '55555555-5555-4555-8555-555555555555',
        },
        target: {
          _tag: 'STOCK_ITEM',
          ref: {
            ...itemTarget.ref,
            resourceId: '66666666-6666-4666-8666-666666666666',
          },
        },
      });
      const outcome = yield* makeExternalStockCorrelationResolver({
        findEffective: () => Effect.succeed([first, second]),
      }).resolve({ asOf: currentInstant, externalKey: itemKey, selectedConfiguration });

      expect(Schema.is(AmbiguousExternalStockCorrelationSchema)(outcome)).toBe(true);
      if (!Schema.is(AmbiguousExternalStockCorrelationSchema)(outcome)) {
        return;
      }
      expect(outcome).toMatchObject({
        asOf: currentInstant,
        candidateCorrelationRefs: [first.correlationRef, second.correlationRef],
        externalKey: itemKey,
      });
      expect(outcome).not.toHaveProperty('target');
    }),
  );

  it.effect(
    'resolves late pre-cutover evidence through its actual issuer history without granting Current authority',
    () =>
      Effect.gen(function* preserveIssuerAcrossCutover() {
        const historical = correlation({
          effectivePeriod: { from: currentInstant, to: correctionInstant },
          lifecycle: 'ENDED',
        });
        const resolver = makeExternalStockCorrelationResolver({
          findEffective: (externalKey, asOf) =>
            Effect.succeed(externalKey.issuer.backendId === 'erp-a' && asOf === currentInstant ? [historical] : []),
        });

        const replacementIssuerKey = decodeKey({
          ...itemKey,
          issuer: { backendId: 'erp-b', backendKind: 'external_business_system' },
        });
        const replacementConfiguration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
          ...selectedConfiguration,
          configurationId: '88888888-8888-4888-8888-888888888888',
          selection: {
            ...selectedConfiguration.selection,
            backendId: replacementIssuerKey.issuer.backendId,
          },
        });
        const outcome = yield* resolver.resolve({
          asOf: currentInstant,
          externalKey: itemKey,
          selectedConfiguration: replacementConfiguration,
        });

        expect(Schema.is(ResolvedExternalStockCorrelationSchema)(outcome)).toBe(true);
        if (!Schema.is(ResolvedExternalStockCorrelationSchema)(outcome)) {
          return;
        }
        expect(outcome.selectedBackendOriginMatch).toBe('OUTSIDE_SELECTED_BACKEND');
        expect(Schema.is(ExternalStockItemTargetSchema)(outcome.target)).toBe(true);
        if (Schema.is(ExternalStockItemTargetSchema)(outcome.target)) {
          expect(outcome.target.ref).toEqual(itemTarget.ref);
        }
        expect(outcome).not.toHaveProperty('onHand');
        expect(outcome).not.toHaveProperty('quantity');
        expect(outcome).not.toHaveProperty('factAuthority');
      }),
  );
});

const sameKey = (left: ExternalStockKey, right: ExternalStockKey): boolean =>
  left.tenantId === right.tenantId &&
  left.customerConfigurationId === right.customerConfigurationId &&
  left.issuer.backendKind === right.issuer.backendKind &&
  left.issuer.backendId === right.issuer.backendId &&
  left.namespace === right.namespace &&
  left.externalScope === right.externalScope &&
  left.identifierKind === right.identifierKind &&
  left.externalValue === right.externalValue;

const effectiveAt = (candidate: ExternalStockCorrelation, asOf: string) =>
  candidate.effectivePeriod.from <= asOf &&
  (candidate.effectivePeriod.to === null || asOf < candidate.effectivePeriod.to);

/* oxlint-disable sonarjs/no-nested-functions -- In-memory Effect persistence models the public transaction-owned lifecycle seam; expires: 2027-03-31. */
const makeMemoryPersistence = (initial: readonly ExternalStockCorrelation[] = []) =>
  Effect.gen(function* makePersistence() {
    const state = yield* Ref.make(initial);
    const persistence: ExternalStockCorrelationPersistence = {
      endCurrent: ({ current, endedAt }) =>
        Effect.gen(function* endCurrent() {
          const ended = decodeCorrelation({
            ...current,
            effectivePeriod: { ...current.effectivePeriod, to: endedAt },
            lifecycle: 'ENDED',
            revision: current.revision + 1,
          });
          yield* Ref.update(state, (all) =>
            all.map((candidate) =>
              candidate.correlationRef.resourceId === current.correlationRef.resourceId ? ended : candidate,
            ),
          );
          return ended;
        }),
      findByRef: (ref) =>
        Ref.get(state).pipe(
          Effect.map((all) =>
            Option.fromNullishOr(
              all.find(
                (candidate) =>
                  candidate.correlationRef.tenantId === ref.tenantId &&
                  candidate.correlationRef.resourceId === ref.resourceId,
              ),
            ),
          ),
        ),
      findEffective: (externalKey, asOf) =>
        Ref.get(state).pipe(
          Effect.map((all) =>
            all.filter((candidate) => sameKey(candidate.externalKey, externalKey) && effectiveAt(candidate, asOf)),
          ),
        ),
      insertCurrent: (candidate) => Ref.update(state, (all) => [...all, candidate]).pipe(Effect.as(candidate)),
      replaceCurrent: ({ current, endedAt, replacement }) =>
        Effect.gen(function* replaceCurrent() {
          const ended = decodeCorrelation({
            ...current,
            effectivePeriod: { ...current.effectivePeriod, to: endedAt },
            lifecycle: 'ENDED',
            revision: current.revision + 1,
          });
          yield* Ref.update(state, (all) => [
            ...all.map((candidate) =>
              candidate.correlationRef.resourceId === current.correlationRef.resourceId ? ended : candidate,
            ),
            replacement,
          ]);
          return replacement;
        }),
      saveConfirmation: ({ next }) =>
        Ref.update(state, (all) =>
          all.map((candidate) =>
            candidate.correlationRef.resourceId === next.correlationRef.resourceId ? next : candidate,
          ),
        ).pipe(Effect.as(next)),
    };
    return { persistence, state };
  });

describe('Inventory External Stock Correlation lifecycle', () => {
  it.effect('ends an old meaning and establishes a new Resource with its own Effective Period', () =>
    Effect.gen(function* correctExternalMeaning() {
      const { persistence } = yield* makeMemoryPersistence([correlation()]);
      const ids = ['55555555-5555-4555-8555-555555555555'];
      const lifecycle = makeExternalStockCorrelationLifecycle(persistence, {
        makeCorrelationId: () => ids.shift() ?? '77777777-7777-4777-8777-777777777777',
      });
      const replacementTarget = Schema.decodeUnknownSync(ExternalStockTargetSchema)({
        _tag: 'STOCK_ITEM',
        ref: {
          ...itemTarget.ref,
          resourceId: '66666666-6666-4666-8666-666666666666',
        },
      });

      const replacement = yield* lifecycle.correct({
        correctedAt: correctionInstant,
        externalKey: itemKey,
        ownerEvidenceRef: 'erp-a:correlation-proof:2',
        target: replacementTarget,
      });
      const historical = yield* persistence.findEffective(itemKey, currentInstant);
      const current = yield* persistence.findEffective(itemKey, correctionInstant);

      expect(historical).toHaveLength(1);
      expect(historical[0]?.lifecycle).toBe('ENDED');
      expect(Schema.is(ExternalStockItemTargetSchema)(historical[0]?.target)).toBe(true);
      expect(historical[0]?.effectivePeriod.to).toBe(correctionInstant);
      expect(current).toEqual([replacement]);
      expect(replacement.correlationRef.resourceId).not.toBe(correlation().correlationRef.resourceId);
      expect(Schema.is(ExternalStockItemTargetSchema)(replacement.target)).toBe(true);
      if (Schema.is(ExternalStockItemTargetSchema)(replacement.target)) {
        expect(replacement.target.ref).toEqual(replacementTarget.ref);
      }
    }),
  );

  it.effect('ends a correlation without deleting its historical meaning', () =>
    Effect.gen(function* endCorrelation() {
      const { persistence } = yield* makeMemoryPersistence([correlation()]);
      const lifecycle = makeExternalStockCorrelationLifecycle(persistence, {
        makeCorrelationId: () => '55555555-5555-4555-8555-555555555555',
      });

      const ended = yield* lifecycle.end({ endedAt: endInstant, externalKey: itemKey });

      expect(ended.lifecycle).toBe('ENDED');
      expect(Schema.is(ExternalStockItemTargetSchema)(ended.target)).toBe(true);
      expect(yield* persistence.findEffective(itemKey, currentInstant)).toEqual([ended]);
      expect(yield* persistence.findEffective(itemKey, endInstant)).toEqual([]);
    }),
  );
});
