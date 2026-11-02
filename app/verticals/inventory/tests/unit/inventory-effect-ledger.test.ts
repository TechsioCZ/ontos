/* oxlint-disable sonarjs/no-nested-functions -- In-memory owner ports keep the public ledger seam explicit; expires: 2027-03-31. */
import { Array as EffectArray, Effect, Option, Ref, Schema } from 'effect';
import { CommitmentProtectionEffectRequestSchema } from '../../shared/domain/commitment-protection.ts';
import { buildInventoryOwnerAcceptanceBindingCorrectionLineage } from '../support/inventory-owner-acceptance-binding-correction.ts';
import { assert, describe, expect, it } from 'effect-rstest';

import {
  InventoryEffectLedgerConflict,
  InventoryEffectLedgerEffectIdSchema,
  InventoryEffectLedgerRejected,
  PhysicalIssueInventoryEffectLedgerResolutionSchema,
} from '../../shared/domain/inventory-effect-ledger.ts';
import {
  ActionInvocationIdSchema,
  PhysicalStockEffectRequestSchema,
} from '../../shared/domain/physical-stock-effect.ts';
import type { InventoryEffectLedgerRecord } from '../../shared/domain/inventory-effect-ledger.ts';
import type { InventoryEffectLedgerPersistence } from '../../src/services/inventory-effect-ledger.service.ts';
import {
  makeInventoryEffectLedgerService,
  commitmentProtectionLedgerIntent,
  commitmentProtectionLedgerResolution,
  canonicalInventoryEffectIntent,
  sameInventoryEffectIntent,
  inventoryEffectLedgerId,
  physicalStockLedgerIntent,
} from '../../src/services/inventory-effect-ledger.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const effectId = InventoryEffectLedgerEffectIdSchema.make('88888888-8888-4888-8888-888888888888');
const requestedAt = '2026-09-24T20:00:00.000Z';

const physicalRequest = Schema.decodeUnknownSync(PhysicalStockEffectRequestSchema)({
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
  requestedAt,
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
const baseIntent = physicalStockLedgerIntent({ _tag: 'REQUESTED', request: physicalRequest });

const rejectedResolution = Schema.decodeUnknownSync(PhysicalIssueInventoryEffectLedgerResolutionSchema)({
  _tag: 'PHYSICAL_ISSUE',
  effect: {
    _tag: 'REJECTED',
    reason: 'BACKEND_REJECTED',
    request: physicalRequest,
  },
});

const makeHarness = () =>
  Effect.gen(function* makeMemoryHarness() {
    const current = yield* Ref.make<Option.Option<InventoryEffectLedgerRecord>>(Option.none());
    const history = yield* Ref.make<readonly InventoryEffectLedgerRecord[]>([]);
    const persistence: InventoryEffectLedgerPersistence = {
      createOrRead: (candidate) =>
        Effect.gen(function* createOrRead() {
          const stored = yield* Ref.modify(
            current,
            (
              existing,
            ): readonly [
              { readonly outcome: 'EXISTING' | 'INSERTED'; readonly record: InventoryEffectLedgerRecord },
              Option.Option<InventoryEffectLedgerRecord>,
            ] =>
              Option.match(existing, {
                onNone: () => [{ outcome: 'INSERTED', record: candidate }, Option.some(candidate)],
                onSome: (record) => [{ outcome: 'EXISTING', record }, existing],
              }),
          );
          if (stored.outcome === 'INSERTED') {
            yield* Ref.update(history, (records) => [...records, stored.record]);
          }
          return stored;
        }),
      read: () => Ref.get(current),
      save: (expected, next) =>
        Effect.gen(function* save() {
          const result = yield* Ref.modify(
            current,
            (
              existing,
            ): readonly [
              {
                readonly saved: Option.Option<InventoryEffectLedgerRecord>;
                readonly updated: boolean;
              },
              Option.Option<InventoryEffectLedgerRecord>,
            ] =>
              Option.match(existing, {
                onNone: () => [{ saved: Option.none(), updated: false }, existing],
                onSome: (record) =>
                  record.revision === expected.revision
                    ? [{ saved: Option.some(next), updated: true }, Option.some(next)]
                    : [{ saved: Option.some(record), updated: false }, existing],
              }),
          );
          if (result.updated) {
            yield* Ref.update(history, (records) => [...records, next]);
          }
          return result.saved;
        }),
    };
    return { history, service: makeInventoryEffectLedgerService(persistence, Effect.succeed(requestedAt)) };
  });

describe('Inventory effect ledger', () => {
  it.effect('collapses concurrent exact retries onto one durable owner-scoped effect', () =>
    Effect.gen(function* exactRetry() {
      const { history, service } = yield* makeHarness();
      const results = yield* Effect.all(
        [service.claim(tenantId, effectId, baseIntent), service.claim(tenantId, effectId, baseIntent)],
        { concurrency: 'unbounded' },
      );

      expect(new Set(results.map(({ outcome }) => outcome))).toEqual(new Set(['CLAIMED', 'EXACT_REPLAY']));
      expect(yield* Ref.get(history)).toHaveLength(1);
    }),
  );

  it.effect('ignores regenerated physical dispatch identity and request time', () =>
    Effect.gen(function* stablePhysicalIntent() {
      const { service } = yield* makeHarness();
      const retriedIntent = physicalStockLedgerIntent({
        _tag: 'REQUESTED',
        request: {
          ...physicalRequest,
          actionInvocationId: ActionInvocationIdSchema.make('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
          requestedAt: '2026-09-24T20:01:00.000Z',
        },
      });
      const results = yield* Effect.all(
        [service.claim(tenantId, effectId, baseIntent), service.claim(tenantId, effectId, retriedIntent)],
        { concurrency: 'unbounded' },
      );

      expect(new Set(results.map(({ outcome }) => outcome))).toEqual(new Set(['CLAIMED', 'EXACT_REPLAY']));
    }),
  );

  it.effect('rejects changed meaning under the same identity without changing the original', () =>
    Effect.gen(function* changedMeaning() {
      const { service } = yield* makeHarness();
      const original = yield* service.claim(tenantId, effectId, baseIntent);
      const changed = physicalStockLedgerIntent({
        _tag: 'REQUESTED',
        request: {
          ...physicalRequest,
          quantity: {
            ...physicalRequest.quantity,
            amount: Schema.decodeUnknownSync(PhysicalStockEffectRequestSchema.fields.quantity.fields.amount)('3'),
          },
        },
      });
      const failure = yield* Effect.flip(service.claim(tenantId, effectId, changed));
      const recovered = yield* service.recover(tenantId, effectId, baseIntent);

      expect(failure).toBeInstanceOf(InventoryEffectLedgerConflict);
      expect(recovered.record).toEqual(original.record);
    }),
  );

  it.effect('recovers an indeterminate effect through the original identity and preserves its history', () =>
    Effect.gen(function* recoverOriginal() {
      const { history, service } = yield* makeHarness();
      const claimed = yield* service.claim(tenantId, effectId, baseIntent);
      const indeterminate = yield* service.transition(claimed.record, {
        currentState: 'INDETERMINATE',
        resolution: null,
      });
      const recovered = yield* service.recover(tenantId, effectId, baseIntent);

      expect(recovered.record).toEqual(indeterminate);
      expect(recovered.outcome).toBe('EXACT_REPLAY');
      expect((yield* Ref.get(history)).map(({ revision }) => revision)).toEqual([1, 2]);
    }),
  );

  it.effect('uses compare-and-set revisions and keeps terminal outcomes immutable', () =>
    Effect.gen(function* terminalImmutability() {
      const { service } = yield* makeHarness();
      const claimed = yield* service.claim(tenantId, effectId, baseIntent);
      const terminal = yield* service.transition(claimed.record, {
        currentState: 'REJECTED',
        resolution: rejectedResolution,
      });
      const terminalFailure = yield* Effect.flip(
        service.transition(terminal, { currentState: 'SUCCEEDED', resolution: null }),
      );
      const staleFailure = yield* Effect.flip(
        service.transition(claimed.record, { currentState: 'INDETERMINATE', resolution: null }),
      );

      expect(terminalFailure).toBeInstanceOf(InventoryEffectLedgerRejected);
      expect(terminalFailure).toMatchObject({ reason: 'TERMINAL_EFFECT_IMMUTABLE' });
      expect(staleFailure).toMatchObject({ reason: 'REVISION_CONFLICT' });
    }),
  );

  it.effect('rejects a resolution whose embedded request changes immutable Quantity', () =>
    Effect.gen(function* changedResolutionIntent() {
      const { service } = yield* makeHarness();
      const claimed = yield* service.claim(tenantId, effectId, baseIntent);
      const changedResolution = Schema.decodeUnknownSync(PhysicalIssueInventoryEffectLedgerResolutionSchema)({
        ...rejectedResolution,
        effect: {
          ...rejectedResolution.effect,
          request: {
            ...rejectedResolution.effect.request,
            quantity: { ...rejectedResolution.effect.request.quantity, amount: '3' },
          },
        },
      });
      const failure = yield* Effect.flip(
        service.transition(claimed.record, { currentState: 'REJECTED', resolution: changedResolution }),
      );

      expect(failure).toMatchObject({ reason: 'INVALID_RESOLUTION' });
    }),
  );

  it.effect('rejects a caller state that disagrees with the typed resolution outcome', () =>
    Effect.gen(function* mismatchedResolutionState() {
      const { service } = yield* makeHarness();
      const claimed = yield* service.claim(tenantId, effectId, baseIntent);
      const failure = yield* Effect.flip(
        service.transition(claimed.record, { currentState: 'SUCCEEDED', resolution: rejectedResolution }),
      );

      expect(failure).toMatchObject({ reason: 'INVALID_RESOLUTION' });
    }),
  );
});

const originalProtectionRequest = Effect.gen(function* originalProtectionRequest() {
  const lineage = yield* buildInventoryOwnerAcceptanceBindingCorrectionLineage;
  const request = yield* Schema.decodeUnknownEffect(CommitmentProtectionEffectRequestSchema)({
    confirmation: lineage.confirmation,
    effectId: lineage.protection.authorityEvidence.effectId,
    legalEntityId: '12111111-1111-4111-8111-111111111111',
    mutationId: lineage.protection.ref.resourceId,
    protectionRef: lineage.protection.ref,
    requestedAt: '2026-09-25T10:10:00.000Z',
    sourceActionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  });
  return { protection: lineage.protection, request };
});

for (const state of ['REQUESTED', 'INDETERMINATE', 'SUCCEEDED'] as const) {
  it.effect(`Protection ${state} exact replay ignores only new invocation and dispatch time`, () =>
    Effect.gen(function* protectionMetadataReplay() {
      const { protection, request } = yield* originalProtectionRequest;
      const { history, service } = yield* makeHarness();
      const identity = inventoryEffectLedgerId(request.effectId);
      let original = (yield* service.claim(tenantId, identity, commitmentProtectionLedgerIntent(request))).record;
      if (state !== 'REQUESTED') {
        original = yield* service.transition(original, { currentState: 'INDETERMINATE', resolution: null });
      }
      if (state === 'SUCCEEDED') {
        original = yield* service.transition(original, {
          currentState: 'SUCCEEDED',
          resolution: commitmentProtectionLedgerResolution({ _tag: 'PROTECTED', protection, request }),
        });
      }
      const priorHistory = yield* Ref.get(history);
      const later = {
        ...request,
        requestedAt: '2026-09-25T11:10:00.000Z',
        sourceActionInvocationId: ActionInvocationIdSchema.make('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'),
      };
      expect(canonicalInventoryEffectIntent(commitmentProtectionLedgerIntent(later))).not.toBe(
        canonicalInventoryEffectIntent(commitmentProtectionLedgerIntent(request)),
      );
      expect(
        sameInventoryEffectIntent(
          commitmentProtectionLedgerIntent(request),
          commitmentProtectionLedgerIntent({ ...request, requestedAt: later.requestedAt }),
        ),
      ).toBe(true);
      expect(
        sameInventoryEffectIntent(
          commitmentProtectionLedgerIntent(request),
          commitmentProtectionLedgerIntent({ ...request, sourceActionInvocationId: later.sourceActionInvocationId }),
        ),
      ).toBe(true);
      const replay = yield* service.claim(tenantId, identity, commitmentProtectionLedgerIntent(later));
      expect(replay.outcome).toBe('EXACT_REPLAY');
      expect(replay.record).toEqual(original);
      expect(yield* Ref.get(history)).toEqual(priorHistory);
    }),
  );
}

it.effect(
  'Protection business projection preserves every material dimension and normalizes only permitted ordering',
  () =>
    Effect.gen(function* protectionMaterialControls() {
      const { request } = yield* originalProtectionRequest;
      const original = commitmentProtectionLedgerIntent(request);
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(CommitmentProtectionEffectRequestSchema))(
        request,
      );
      const [requirement] = request.confirmation.reservation.requirements;
      assert(requirement !== undefined);
      const [materialAllocation] = requirement.allocations;
      assert(materialAllocation !== undefined);
      const changes = [
        [request.effectId, 'protection:different-effect'],
        [request.mutationId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'],
        [requirement.purchaseDemandOccurrenceId, 'different-occurrence'],
        [materialAllocation.positionRef.resourceId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'],
        [request.protectionRef.resourceId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'],
        [request.legalEntityId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'],
        [request.confirmation.ref.resourceId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'],
        [request.confirmation.reservation.ref.resourceId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'],
        [request.confirmation.reservation.origin.attemptId, 'different-attempt'],
        [request.confirmation.reservation.authority.selection.backendId, 'different-backend'],
        [request.confirmation.reservation.authority.configurationId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'],
        [request.confirmation.reservation.authority.customerConfigurationId, 'different-customer-configuration'],
        [request.protectionRef.tenantId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'],
        [requirement.unitRef.resourceId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'],
        [requirement.stockItem.stockItemRef.resourceId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'],
        ['"4"', '"5"'],
      ] as const;
      for (const [source, target] of changes) {
        const typed = yield* Schema.decodeEffect(Schema.fromJsonString(CommitmentProtectionEffectRequestSchema))(
          encoded.replaceAll(source, target),
        );
        expect(sameInventoryEffectIntent(original, commitmentProtectionLedgerIntent(typed))).toBe(false);
      }
      const otherBackend = yield* Schema.decodeEffect(Schema.fromJsonString(CommitmentProtectionEffectRequestSchema))(
        encoded
          .replaceAll('"ontos_wms"', '"external_business_system"')
          .replaceAll('"ONTOS_WMS"', '"EXTERNAL_BUSINESS_SYSTEM"'),
      );
      expect(sameInventoryEffectIntent(original, commitmentProtectionLedgerIntent(otherBackend))).toBe(false);
      const [allocation] = requirement.allocations;
      assert(allocation !== undefined);
      const requirements = ['first', 'second'].map((label) => ({
        ...requirement,
        allocations: ['a', 'b'].map((suffix) => ({
          ...allocation,
          allocationId: `allocation:${label}:${suffix}`,
          quantity: { ...allocation.quantity, amount: '2' },
        })),
        purchaseDemandOccurrenceId: `demand:${label}`,
      }));
      const multiple = yield* Schema.decodeUnknownEffect(CommitmentProtectionEffectRequestSchema)({
        ...request,
        confirmation: {
          ...request.confirmation,
          authorityEvidence: {
            ...request.confirmation.authorityEvidence,
            evidence: {
              ...request.confirmation.authorityEvidence.evidence,
              allocations: requirements.flatMap((entry) =>
                entry.allocations.map((entryAllocation) => ({
                  ...entryAllocation,
                  stockPositionRef: entryAllocation.positionRef,
                })),
              ),
            },
          },
          reservation: { ...request.confirmation.reservation, requirements },
        },
      });
      expect(sameInventoryEffectIntent(original, commitmentProtectionLedgerIntent(multiple))).toBe(false);
      expect(sameInventoryEffectIntent(commitmentProtectionLedgerIntent(multiple), original)).toBe(false);
      const reordered = yield* Schema.decodeUnknownEffect(CommitmentProtectionEffectRequestSchema)({
        ...multiple,
        confirmation: {
          ...multiple.confirmation,
          reservation: {
            ...multiple.confirmation.reservation,
            requirements: EffectArray.reverse(multiple.confirmation.reservation.requirements).map((entry) => ({
              ...entry,
              allocations: EffectArray.reverse(entry.allocations),
            })),
          },
        },
      });
      expect(reordered.confirmation.reservation.requirements).not.toEqual(
        multiple.confirmation.reservation.requirements,
      );
      expect(
        sameInventoryEffectIntent(
          commitmentProtectionLedgerIntent(multiple),
          commitmentProtectionLedgerIntent(reordered),
        ),
      ).toBe(true);
    }),
);

it.effect('Protection resolution still requires original dispatch provenance', () =>
  Effect.gen(function* originalResolutionProvenance() {
    const { protection, request } = yield* originalProtectionRequest;
    const { service } = yield* makeHarness();
    const original = (yield* service.claim(
      tenantId,
      inventoryEffectLedgerId(request.effectId),
      commitmentProtectionLedgerIntent(request),
    )).record;
    const changes = [
      { ...request, sourceActionInvocationId: ActionInvocationIdSchema.make('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2') },
      { ...request, requestedAt: '2026-09-25T11:10:00.000Z' },
    ];
    for (const changed of changes) {
      const failure = yield* Effect.flip(
        service.transition(original, {
          currentState: 'SUCCEEDED',
          resolution: commitmentProtectionLedgerResolution({ _tag: 'PROTECTED', protection, request: changed }),
        }),
      );
      expect(Schema.is(InventoryEffectLedgerRejected)(failure)).toBe(true);
      expect(failure.reason).toBe('INVALID_RESOLUTION');
    }
  }),
);
