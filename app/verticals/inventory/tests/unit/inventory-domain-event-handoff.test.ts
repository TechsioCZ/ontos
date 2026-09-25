import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  InventoryCommittedEventNoticeSchema,
  InventoryDomainEventDeliveryAcceptedSchema,
  InventoryDomainEventDeliveryRejectedSchema,
  InventoryDomainEventFamilySchema,
  currentInventoryTruthRequirement,
  evaluateInventoryDomainEventDelivery,
  inventoryDomainEventFamilies,
  inventoryDomainEventFamilyByKey,
  inventoryDomainEventDeliveryFailureBoundary,
} from '../../shared/domain/inventory-domain-event-handoff.ts';
import type {
  InventoryCommittedEventNotice,
  InventoryDomainEventConsumerState,
  InventoryDomainEventDeliveryResult,
  InventoryDomainEventFamilyKey,
} from '../../shared/domain/inventory-domain-event-handoff.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const positionId = '22222222-2222-4222-8222-222222222222';
const reservationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const resourceTypeByFamily = {
  COMMITMENT_PROTECTION_CHANGED: 'commerce.inventory.commitment-protection',
  COMMITTED_OBLIGATION_CHANGED: 'commerce.inventory.inventory-reservation',
  RESERVATION_GUARANTEE_CHANGED: 'commerce.inventory.inventory-reservation',
  STOCK_POSITION_EVIDENCE_CHANGED: 'commerce.inventory.stock-position',
} as const satisfies Readonly<Record<InventoryDomainEventFamilyKey, string>>;

const resourceIdByFamily = {
  COMMITMENT_PROTECTION_CHANGED: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  COMMITTED_OBLIGATION_CHANGED: reservationId,
  RESERVATION_GUARANTEE_CHANGED: reservationId,
  STOCK_POSITION_EVIDENCE_CHANGED: positionId,
} as const satisfies Readonly<Record<InventoryDomainEventFamilyKey, string>>;

const defaultOrdering = (family: InventoryDomainEventFamilyKey) =>
  inventoryDomainEventFamilyByKey[family].ordering === 'OWNER_AGGREGATE_REVISION'
    ? { _tag: 'OWNER_AGGREGATE_REVISION', revision: 4 }
    : { _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY', occurrenceId: 'reservation-transition:create-effect-a' };

const notice = (
  family: InventoryDomainEventFamilyKey,
  overrides: Partial<typeof InventoryCommittedEventNoticeSchema.Encoded> & {
    readonly providerPayload?: { readonly token: string };
    readonly subjectRevision?: number;
  } = {},
): InventoryCommittedEventNotice => {
  const descriptor = inventoryDomainEventFamilyByKey[family];
  return Schema.decodeUnknownSync(InventoryCommittedEventNoticeSchema, { onExcessProperty: 'error' })({
    correlationId: 'inventory-event-handoff:test',
    domainEventId: '33333333-3333-4333-8333-333333333333',
    eventType: descriptor.eventType,
    occurredAt: '2026-09-25T10:00:00.000Z',
    ordering: defaultOrdering(family),
    producerModuleKey: 'commerce.inventory',
    producerRevision: 1,
    subjectRef: {
      moduleId: 'commerce.inventory',
      resourceId: resourceIdByFamily[family],
      resourceType: resourceTypeByFamily[family],
      tenantId,
    },
    tenantSequenceNo: '42',
    ...overrides,
  });
};

const acceptedResult = (result: InventoryDomainEventDeliveryResult) =>
  Schema.decodeUnknownSync(InventoryDomainEventDeliveryAcceptedSchema)(result);

const rejectedResult = (result: InventoryDomainEventDeliveryResult) =>
  Schema.decodeUnknownSync(InventoryDomainEventDeliveryRejectedSchema)(result);

const deliver = (
  family: InventoryDomainEventFamilyKey,
  event: InventoryCommittedEventNotice,
  state: InventoryDomainEventConsumerState | null,
  consumerModuleKey = inventoryDomainEventFamilyByKey[family].consumer.moduleKey,
) => evaluateInventoryDomainEventDelivery({ consumerModuleKey, event, family, state });

describe('Inventory domain events and owner handoffs', () => {
  it('owns exactly four canonical family mappings instead of accepting caller-authored descriptors', () => {
    const decoded = inventoryDomainEventFamilies.map((entry) =>
      Schema.decodeUnknownSync(InventoryDomainEventFamilySchema, { onExcessProperty: 'error' })(entry),
    );
    expect(decoded.map(({ family }) => family)).toEqual([
      'RESERVATION_GUARANTEE_CHANGED',
      'COMMITMENT_PROTECTION_CHANGED',
      'STOCK_POSITION_EVIDENCE_CHANGED',
      'COMMITTED_OBLIGATION_CHANGED',
    ]);
    expect(inventoryDomainEventFamilyByKey.STOCK_POSITION_EVIDENCE_CHANGED).toMatchObject({
      consumer: { moduleKey: 'commerce.availability' },
      eventType: 'commerce.inventory.stock-position-evidence-changed.v1',
      ordering: 'OWNER_AGGREGATE_REVISION',
      ownerReadOrProofKey: 'commerce.inventory.api.current-stock-evidence-for-availability',
      producer: { moduleKey: 'commerce.inventory', revision: 1 },
      subjectResourceTypes: ['commerce.inventory.stock-position'],
    });
    expect(new Set(decoded.map(({ eventType }) => eventType)).size).toBe(4);
    expect(new Set(decoded.map(({ family }) => family)).size).toBe(4);
  });

  it('keeps the committed notice minimal and rejects provider payloads', () => {
    expect(notice('STOCK_POSITION_EVIDENCE_CHANGED')).not.toHaveProperty('providerPayload');
    expect(() => notice('STOCK_POSITION_EVIDENCE_CHANGED', { providerPayload: { token: 'secret' } })).toThrow();
  });

  it('treats delayed or silent delivery as no Current proof', () => {
    expect(currentInventoryTruthRequirement()).toEqual({
      currentTruthSource: 'SUPPORTED_OWNER_READ_OR_PROOF',
      eventSilenceIsCurrentProof: false,
      retainedEventIsCurrentGuarantee: false,
    });
  });

  it('derives the exact canonical owner read for a new family event', () => {
    const result = acceptedResult(
      deliver('STOCK_POSITION_EVIDENCE_CHANGED', notice('STOCK_POSITION_EVIDENCE_CHANGED'), null),
    );
    expect(result).toMatchObject({
      consumerBusinessEffectAllowedFromEventAlone: false,
      disposition: 'INVALIDATE_AND_REREAD_OWNER',
      ownerReadOrProofKey: 'commerce.inventory.api.current-stock-evidence-for-availability',
      ownerReadRequired: true,
      producerFactMutationRequired: false,
      retainedEventIsCurrentGuarantee: false,
    });
  });

  it('processes A then B and suppresses exact A replay without another invalidation', () => {
    const eventA = notice('STOCK_POSITION_EVIDENCE_CHANGED');
    const afterA = acceptedResult(deliver('STOCK_POSITION_EVIDENCE_CHANGED', eventA, null));
    const eventB = notice('STOCK_POSITION_EVIDENCE_CHANGED', {
      domainEventId: '44444444-4444-4444-8444-444444444444',
      ordering: { _tag: 'OWNER_AGGREGATE_REVISION', revision: 5 },
      tenantSequenceNo: '43',
    });
    const afterB = acceptedResult(deliver('STOCK_POSITION_EVIDENCE_CHANGED', eventB, afterA.nextState));
    const replayA = acceptedResult(deliver('STOCK_POSITION_EVIDENCE_CHANGED', eventA, afterB.nextState));

    expect(afterB).toMatchObject({ disposition: 'INVALIDATE_AND_REREAD_OWNER', ownerReadRequired: true });
    expect(afterB.nextState).toMatchObject({ highestTenantSequenceNo: 43n, latestOwnerRevision: 5 });
    expect(replayA).toMatchObject({ disposition: 'DUPLICATE_IGNORED', ownerReadRequired: false });
    expect(replayA.nextState).toEqual(afterB.nextState);
  });

  it('suppresses an unseen older transport sequence after a newer event without another invalidation', () => {
    const afterA = acceptedResult(
      deliver('STOCK_POSITION_EVIDENCE_CHANGED', notice('STOCK_POSITION_EVIDENCE_CHANGED'), null),
    );
    const afterB = acceptedResult(
      deliver(
        'STOCK_POSITION_EVIDENCE_CHANGED',
        notice('STOCK_POSITION_EVIDENCE_CHANGED', {
          domainEventId: '44444444-4444-4444-8444-444444444444',
          ordering: { _tag: 'OWNER_AGGREGATE_REVISION', revision: 5 },
          tenantSequenceNo: '43',
        }),
        afterA.nextState,
      ),
    );
    const older = acceptedResult(
      deliver(
        'STOCK_POSITION_EVIDENCE_CHANGED',
        notice('STOCK_POSITION_EVIDENCE_CHANGED', {
          domainEventId: '55555555-5555-4555-8555-555555555555',
          ordering: { _tag: 'OWNER_AGGREGATE_REVISION', revision: 3 },
          tenantSequenceNo: '41',
        }),
        afterB.nextState,
      ),
    );

    expect(older).toMatchObject({ disposition: 'OUT_OF_ORDER_IGNORED', ownerReadRequired: false });
    expect(older.nextState).toMatchObject({ highestTenantSequenceNo: 43n, latestOwnerRevision: 5 });
  });

  it('rejects the same domain event identity paired with a changed tenant sequence', () => {
    const afterA = acceptedResult(
      deliver('STOCK_POSITION_EVIDENCE_CHANGED', notice('STOCK_POSITION_EVIDENCE_CHANGED'), null),
    );
    const conflict = rejectedResult(
      deliver(
        'STOCK_POSITION_EVIDENCE_CHANGED',
        notice('STOCK_POSITION_EVIDENCE_CHANGED', {
          ordering: { _tag: 'OWNER_AGGREGATE_REVISION', revision: 6 },
          tenantSequenceNo: '44',
        }),
        afterA.nextState,
      ),
    );
    expect(conflict.reason).toBe('DOMAIN_EVENT_SEQUENCE_CONFLICT');
  });

  it('rejects a conflicting event identity at an already-observed tenant sequence', () => {
    const afterA = acceptedResult(
      deliver('STOCK_POSITION_EVIDENCE_CHANGED', notice('STOCK_POSITION_EVIDENCE_CHANGED'), null),
    );
    const conflict = rejectedResult(
      deliver(
        'STOCK_POSITION_EVIDENCE_CHANGED',
        notice('STOCK_POSITION_EVIDENCE_CHANGED', {
          domainEventId: '66666666-6666-4666-8666-666666666666',
          ordering: { _tag: 'OWNER_AGGREGATE_REVISION', revision: 6 },
        }),
        afterA.nextState,
      ),
    );
    expect(conflict.reason).toBe('TENANT_SEQUENCE_IDENTITY_CONFLICT');
  });

  it('rejects a second event identity claiming an already-observed owner revision', () => {
    const afterA = acceptedResult(
      deliver('STOCK_POSITION_EVIDENCE_CHANGED', notice('STOCK_POSITION_EVIDENCE_CHANGED'), null),
    );
    const conflict = rejectedResult(
      deliver(
        'STOCK_POSITION_EVIDENCE_CHANGED',
        notice('STOCK_POSITION_EVIDENCE_CHANGED', {
          domainEventId: '77777777-7777-4777-8777-777777777777',
          tenantSequenceNo: '44',
        }),
        afterA.nextState,
      ),
    );
    expect(conflict.reason).toBe('REVISION_IDENTITY_CONFLICT');
  });

  it('orders Reservation transitions by immutable occurrence and event sequence without subjectRevision', () => {
    const eventA = notice('RESERVATION_GUARANTEE_CHANGED', {
      ordering: { _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY', occurrenceId: 'reservation-create-effect:a' },
      tenantSequenceNo: '50',
    });
    const afterA = acceptedResult(deliver('RESERVATION_GUARANTEE_CHANGED', eventA, null));
    const eventB = notice('RESERVATION_GUARANTEE_CHANGED', {
      domainEventId: '88888888-8888-4888-8888-888888888888',
      ordering: { _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY', occurrenceId: 'reservation-release-effect:b' },
      tenantSequenceNo: '51',
    });
    const afterB = acceptedResult(deliver('RESERVATION_GUARANTEE_CHANGED', eventB, afterA.nextState));
    const replayA = acceptedResult(deliver('RESERVATION_GUARANTEE_CHANGED', eventA, afterB.nextState));

    expect(eventA).not.toHaveProperty('subjectRevision');
    expect(() => notice('RESERVATION_GUARANTEE_CHANGED', { subjectRevision: 1 })).toThrow();
    expect(afterB).toMatchObject({ disposition: 'INVALIDATE_AND_REREAD_OWNER', ownerReadRequired: true });
    expect(afterB.nextState.latestOwnerRevision).toBeUndefined();
    expect(replayA).toMatchObject({ disposition: 'DUPLICATE_IGNORED', ownerReadRequired: false });

    const occurrenceConflict = rejectedResult(
      deliver(
        'RESERVATION_GUARANTEE_CHANGED',
        notice('RESERVATION_GUARANTEE_CHANGED', {
          domainEventId: '99999999-9999-4999-8999-999999999999',
          ordering: { _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY', occurrenceId: 'reservation-create-effect:a' },
          tenantSequenceNo: '52',
        }),
        afterB.nextState,
      ),
    );
    expect(occurrenceConflict.reason).toBe('OCCURRENCE_IDENTITY_CONFLICT');
  });

  it('fails closed on every attempted canonical-family bypass', () => {
    const canonical = notice('STOCK_POSITION_EVIDENCE_CHANGED');
    expect(
      rejectedResult(
        deliver(
          'STOCK_POSITION_EVIDENCE_CHANGED',
          notice('STOCK_POSITION_EVIDENCE_CHANGED', {
            eventType: 'commerce.inventory.reservation-guarantee-changed.v1',
          }),
          null,
        ),
      ).reason,
    ).toBe('EVENT_FAMILY_MISMATCH');
    expect(rejectedResult(deliver('STOCK_POSITION_EVIDENCE_CHANGED', canonical, null, 'commerce.order')).reason).toBe(
      'CONSUMER_MISMATCH',
    );
    expect(
      rejectedResult(
        deliver(
          'STOCK_POSITION_EVIDENCE_CHANGED',
          notice('STOCK_POSITION_EVIDENCE_CHANGED', {
            subjectRef: {
              ...canonical.subjectRef,
              resourceId: reservationId,
              resourceType: 'commerce.inventory.inventory-reservation',
            },
          }),
          null,
        ),
      ).reason,
    ).toBe('SUBJECT_IDENTITY_MISMATCH');
    expect(
      rejectedResult(
        deliver(
          'STOCK_POSITION_EVIDENCE_CHANGED',
          notice('STOCK_POSITION_EVIDENCE_CHANGED', {
            ordering: { _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY', occurrenceId: 'bypass' },
          }),
          null,
        ),
      ).reason,
    ).toBe('ORDERING_EVIDENCE_MISMATCH');
    expect(
      rejectedResult(
        deliver(
          'STOCK_POSITION_EVIDENCE_CHANGED',
          notice('STOCK_POSITION_EVIDENCE_CHANGED', { producerRevision: 2 }),
          null,
        ),
      ).reason,
    ).toBe('PRODUCER_MISMATCH');
  });

  it('retries delivery separately and never rolls back the committed producer transaction', () => {
    expect(inventoryDomainEventDeliveryFailureBoundary).toEqual({
      producerTransactionRolledBack: false,
      retry: 'SEPARATE_DELIVERY_RETRY',
    });
  });
});
