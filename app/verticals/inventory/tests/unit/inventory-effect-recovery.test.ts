/* oxlint-disable sonarjs/no-nested-functions -- Focused in-memory owner ports keep each recovery invariant explicit; expires: 2027-03-31. */
import { Effect, Match, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  DefinitiveNonEffectInventoryEffectResultSchema,
  IndeterminateInventoryEffectResultSchema,
  InventoryEffectRecoveryRejected,
  RecoveredInventoryEffectResultSchema,
  inventoryEffectRecoveryFenceFor,
} from '../../shared/domain/inventory-effect-recovery.ts';
import {
  InventoryEffectLedgerEffectIdSchema,
  PhysicalIssueInventoryEffectLedgerResolutionSchema,
} from '../../shared/domain/inventory-effect-ledger.ts';
import type { InventoryEffectLedgerRecord } from '../../shared/domain/inventory-effect-ledger.ts';
import { InventoryBackendIdSchema } from '../../shared/domain/inventory-backend-identifiers.ts';
import { PhysicalStockEffectRequestSchema } from '../../shared/domain/physical-stock-effect.ts';
import type { InventoryEffectRecoveryAuthority } from '../../src/services/inventory-effect-recovery-authority.ts';
import { makeInventoryEffectRecoveryService } from '../../src/services/inventory-effect-recovery.service.ts';
import type { InventoryEffectLedgerPersistence } from '../../src/services/inventory-effect-ledger.service.ts';
import {
  makeInventoryEffectLedgerService,
  physicalStockLedgerIntent,
} from '../../src/services/inventory-effect-ledger.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const effectId = InventoryEffectLedgerEffectIdSchema.make('88888888-8888-4888-8888-888888888888');
const occurredAt = '2026-09-24T20:01:00.000Z';
const learnedAt = '2026-09-24T20:05:00.000Z';

const request = Schema.decodeUnknownSync(PhysicalStockEffectRequestSchema)({
  actionInvocationId: '99999999-9999-4999-8999-999999999999',
  backend: 'external_business_system',
  backendConfigurationRef: {
    moduleId: 'commerce.inventory',
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'commerce.inventory.inventory-backend-configuration',
    tenantId,
  },
  backendId: 'erp-a',
  customerConfigurationId: 'customer:primary',
  effectId,
  kind: 'ISSUE',
  legalEntityId: '33333333-3333-4333-8333-333333333333',
  positionRef: {
    moduleId: 'commerce.inventory',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.inventory.stock-position',
    tenantId,
  },
  quantity: {
    amount: '2',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: '55555555-5555-4555-8555-555555555555',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
  reason: { code: 'ORDER_FULFILLMENT', reference: 'order:42' },
  requestedAt: '2026-09-24T20:00:00.000Z',
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
});
const intent = physicalStockLedgerIntent({ _tag: 'REQUESTED', request });
const successResolution = Schema.decodeUnknownSync(PhysicalIssueInventoryEffectLedgerResolutionSchema)({
  _tag: 'PHYSICAL_ISSUE',
  effect: {
    _tag: 'APPLIED',
    evidence: {
      appliedAt: occurredAt,
      backend: request.backend,
      backendConfigurationRef: request.backendConfigurationRef,
      backendEvidenceRef: 'erp:issue:42',
      backendId: request.backendId,
      effectId: request.effectId,
      issuer: 'erp-a',
      kind: request.kind,
      positionRef: request.positionRef,
      quantity: request.quantity,
    },
    request,
  },
});
const nonEffectResolution = Schema.decodeUnknownSync(PhysicalIssueInventoryEffectLedgerResolutionSchema)({
  _tag: 'PHYSICAL_ISSUE',
  effect: { _tag: 'REJECTED', reason: 'BACKEND_REJECTED', request },
});

const makeHarness = (authority: InventoryEffectRecoveryAuthority) =>
  Effect.gen(function* harness() {
    const current = yield* Ref.make<Option.Option<InventoryEffectLedgerRecord>>(Option.none());
    const persistence: InventoryEffectLedgerPersistence = {
      createOrRead: (candidate) =>
        Effect.gen(function* createOrRead() {
          const stored = yield* Ref.get(current);
          if (Option.isSome(stored)) {
            return { outcome: 'EXISTING' as const, record: stored.value };
          }
          yield* Ref.set(current, Option.some(candidate));
          return { outcome: 'INSERTED' as const, record: candidate };
        }),
      read: () => Ref.get(current),
      save: (expected, next) =>
        Ref.modify(current, (stored) =>
          Option.match(stored, {
            onNone: () => [Option.none<InventoryEffectLedgerRecord>(), stored] as const,
            onSome: (record) =>
              record.revision === expected.revision
                ? ([Option.some(next), Option.some(next)] as const)
                : ([Option.none<InventoryEffectLedgerRecord>(), stored] as const),
          }),
        ),
    };
    const ledger = makeInventoryEffectLedgerService(persistence, Effect.succeed(learnedAt));
    const claimed = yield* ledger.claim(tenantId, effectId, intent);
    yield* ledger.transition(claimed.record, { currentState: 'INDETERMINATE', resolution: null });
    const service = yield* makeInventoryEffectRecoveryService({
      authority,
      ledger,
      owners: { apply: () => Effect.void },
      records: { read: () => Ref.get(current) },
    });
    return { current, service };
  });

describe('Inventory indeterminate effect recovery', () => {
  it.effect('recovers one exact owner-scoped effect and collapses concurrent recovery', () =>
    Effect.gen(function* recoverExactlyOnce() {
      const calls = yield* Ref.make(0);
      const authority: InventoryEffectRecoveryAuthority = {
        recoverOriginal: (record) =>
          Ref.updateAndGet(calls, (count) => count + 1).pipe(
            Effect.as({
              _tag: 'AUTHORITATIVE_SUCCESS' as const,
              effectId: record.effectId,
              intent: record.intent,
              kind: record.intent._tag,
              learnedAt,
              occurredAt,
              ownerEvidenceRef: 'erp:issue:42',
              resolution: successResolution,
            }),
          ),
      };
      const { service } = yield* makeHarness(authority);

      const results = yield* Effect.all(
        [
          service.recover({ effectId, expectedKind: 'PHYSICAL_ISSUE', tenantId }),
          service.recover({ effectId, expectedKind: 'PHYSICAL_ISSUE', tenantId }),
        ],
        { concurrency: 'unbounded' },
      );

      expect(new Set(results.map(({ _tag }) => _tag))).toEqual(new Set(['ALREADY_TERMINAL', 'RECOVERED']));
      expect(yield* Ref.get(calls)).toBe(1);
      const recovered = results.find(Schema.is(RecoveredInventoryEffectResultSchema));
      expect(recovered).toMatchObject({ learnedAt, occurredAt });
    }),
  );

  it.effect('accepts definitive owner non-effect proof before allowing a competing effect', () =>
    Effect.gen(function* recoverNonEffect() {
      const authority: InventoryEffectRecoveryAuthority = {
        recoverOriginal: (record) =>
          Effect.succeed({
            _tag: 'DEFINITIVE_NON_EFFECT',
            effectId: record.effectId,
            intent: record.intent,
            kind: record.intent._tag,
            learnedAt,
            nonEffectFinal: true,
            ownerEvidenceRef: 'erp:issue:not-committed:42',
            provenAt: occurredAt,
            resolution: nonEffectResolution,
          }),
      };
      const { service } = yield* makeHarness(authority);

      const result = yield* service.recover({ effectId, expectedKind: 'PHYSICAL_ISSUE', tenantId });

      if (!Schema.is(DefinitiveNonEffectInventoryEffectResultSchema)(result)) {
        yield* Effect.die('expected definitive non-effect recovery');
      }
      const definitive = result;
      expect(definitive).toMatchObject({ learnedAt, provenAt: occurredAt });
      expect(definitive.record?.currentState).toBe('REJECTED');
    }),
  );

  it.effect('keeps timeout, temporary not-found, unavailable, and partial outcomes indeterminate', () =>
    Effect.gen(function* preserveDebt() {
      for (const reason of ['TIMEOUT', 'TEMPORARY_NOT_FOUND', 'OWNER_UNAVAILABLE', 'PARTIAL_BACKEND_EFFECT'] as const) {
        const authority: InventoryEffectRecoveryAuthority = {
          recoverOriginal: (record) =>
            Effect.succeed({
              _tag: 'INDETERMINATE',
              effectId: record.effectId,
              intent: record.intent,
              kind: record.intent._tag,
              learnedAt,
              reason,
            }),
        };
        const { service } = yield* makeHarness(authority);
        const result = yield* service.recover({ effectId, expectedKind: 'PHYSICAL_ISSUE', tenantId });

        if (!Schema.is(IndeterminateInventoryEffectResultSchema)(result)) {
          yield* Effect.die('expected indeterminate recovery debt');
        }
        const debt = result;
        expect(debt).toMatchObject({
          fence: 'PRESERVE_PHYSICAL_QUANTITY_UNCERTAINTY',
          possibleEffectOccurred: true,
          reason,
          reconciliationRequired: true,
        });
      }
    }),
  );

  it.effect('rejects owner evidence for a changed identity, kind, intent, Attempt, or backend', () =>
    Effect.gen(function* rejectRetargeting() {
      const authority: InventoryEffectRecoveryAuthority = {
        recoverOriginal: (record) =>
          Effect.succeed({
            _tag: 'AUTHORITATIVE_SUCCESS',
            effectId: record.effectId,
            intent: Match.value(record.intent).pipe(
              Match.tag('PHYSICAL_ISSUE', (physical) => ({
                ...physical,
                request: { ...physical.request, backendId: InventoryBackendIdSchema.make('different-backend') },
              })),
              Match.orElse(() => record.intent),
            ),
            kind: record.intent._tag,
            learnedAt,
            occurredAt,
            ownerEvidenceRef: 'wrong-owner-proof',
            resolution: successResolution,
          }),
      };
      const { service } = yield* makeHarness(authority);

      const failure = yield* Effect.flip(service.recover({ effectId, expectedKind: 'PHYSICAL_ISSUE', tenantId }));

      expect(failure).toBeInstanceOf(InventoryEffectRecoveryRejected);
      expect(failure).toMatchObject({ reason: 'AUTHORITY_INTENT_MISMATCH' });
    }),
  );

  it('uses operation-specific fences for create, release, Protection, and physical effects', () => {
    expect(inventoryEffectRecoveryFenceFor('RESERVATION_CREATE')).toBe('PRESERVE_POSSIBLE_PARTIAL_HOLD');
    expect(inventoryEffectRecoveryFenceFor('RESERVATION_RELEASE')).toBe('BLOCK_RELEASED_STOCK_REUSE');
    expect(inventoryEffectRecoveryFenceFor('ESTABLISH_COMMITMENT_PROTECTION')).toBe(
      'PRESERVE_POSSIBLE_PROTECTION_FENCE',
    );
    expect(inventoryEffectRecoveryFenceFor('PHYSICAL_RECEIPT')).toBe('PRESERVE_PHYSICAL_QUANTITY_UNCERTAINTY');
    expect(inventoryEffectRecoveryFenceFor('PHYSICAL_ISSUE')).toBe('PRESERVE_PHYSICAL_QUANTITY_UNCERTAINTY');
  });
});
