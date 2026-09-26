import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  InventoryCommittedEventNoticeSchema,
  InventoryDomainEventFamilySchema,
  InventoryImmutableOccurrenceOrderingSchema,
  InventoryOwnerAggregateRevisionOrderingSchema,
  currentInventoryTruthRequirement,
  inventoryDomainEventDeliveryFailureBoundary,
  inventoryDomainEventFamilies,
  inventoryDomainEventFamilyByKey,
} from '../../shared/domain/inventory-domain-event-handoff.ts';
import { OutboxPayloadSchema as CommitmentProtectionChangedPayloadSchema } from '../../shared/outbox/commerce-inventory-commitment-protection-changed-v1.ts';
import { OutboxPayloadSchema as CommittedObligationChangedPayloadSchema } from '../../shared/outbox/commerce-inventory-committed-obligation-changed-v1.ts';
import { OutboxPayloadSchema as ReservationGuaranteeChangedPayloadSchema } from '../../shared/outbox/commerce-inventory-reservation-guarantee-changed-v1.ts';
import { OutboxPayloadSchema as StockPositionEvidenceChangedPayloadSchema } from '../../shared/outbox/commerce-inventory-stock-position-evidence-changed-v1.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const positionId = '22222222-2222-4222-8222-222222222222';

const stockPositionNotice = (
  overrides: Partial<typeof InventoryCommittedEventNoticeSchema.Encoded> & {
    readonly consumerState?: unknown;
    readonly processedEvents?: unknown;
    readonly providerPayload?: unknown;
  } = {},
) =>
  Schema.decodeUnknownSync(InventoryCommittedEventNoticeSchema, { onExcessProperty: 'error' })({
    correlationId: 'inventory-event-handoff:test',
    domainEventId: '33333333-3333-4333-8333-333333333333',
    eventType: 'commerce.inventory.stock-position-evidence-changed.v1',
    occurredAt: '2026-09-25T10:00:00.000Z',
    ordering: { _tag: 'OWNER_AGGREGATE_REVISION', revision: 4 },
    producerModuleKey: 'commerce.inventory',
    producerRevision: 1,
    subjectRef: {
      moduleId: 'commerce.inventory',
      resourceId: positionId,
      resourceType: 'commerce.inventory.stock-position',
      tenantId,
    },
    tenantSequenceNo: '42',
    ...overrides,
  });

describe('Inventory committed Domain Event producer contract', () => {
  it('owns exactly four canonical family mappings with real consumer use-case metadata', () => {
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
      consumer: {
        behavior: 'INVALIDATE_AND_REREAD_OWNER',
        moduleKey: 'commerce.availability',
      },
      eventType: 'commerce.inventory.stock-position-evidence-changed.v1',
      ordering: 'OWNER_AGGREGATE_REVISION',
      ownerReadOrProofKey: 'commerce.inventory.api.current-stock-evidence-for-availability',
      producer: { moduleKey: 'commerce.inventory', revision: 1 },
      subjectResourceTypes: ['commerce.inventory.stock-position'],
    });
    expect(new Set(decoded.map(({ eventType }) => eventType)).size).toBe(4);
  });

  it('requires an event-type revision matching the producer schema revision', () => {
    const family = inventoryDomainEventFamilyByKey.STOCK_POSITION_EVIDENCE_CHANGED;
    expect(() =>
      Schema.decodeUnknownSync(InventoryDomainEventFamilySchema, { onExcessProperty: 'error' })({
        ...family,
        eventType: 'commerce.inventory.stock-position-evidence-changed.v2',
      }),
    ).toThrow();
  });

  it('keeps committed notices minimal and rejects provider or downstream state payloads', () => {
    expect(stockPositionNotice()).not.toHaveProperty('providerPayload');
    expect(() => stockPositionNotice({ providerPayload: { token: 'secret' } })).toThrow();
    expect(() => stockPositionNotice({ processedEvents: [] })).toThrow();
    expect(() => stockPositionNotice({ consumerState: { highestTenantSequenceNo: '42' } })).toThrow();
  });

  it('supports only the declared owner revision and immutable occurrence ordering evidence', () => {
    const revisionOrdering = Schema.decodeUnknownSync(InventoryOwnerAggregateRevisionOrderingSchema)({
      _tag: 'OWNER_AGGREGATE_REVISION',
      revision: 7,
    });
    const occurrenceOrdering = Schema.decodeUnknownSync(InventoryImmutableOccurrenceOrderingSchema)({
      _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY',
      occurrenceId: 'reservation-create-effect:effect-a',
    });
    expect(Schema.is(InventoryOwnerAggregateRevisionOrderingSchema)(revisionOrdering)).toBe(true);
    expect(revisionOrdering.revision).toBe(7);
    expect(Schema.is(InventoryImmutableOccurrenceOrderingSchema)(occurrenceOrdering)).toBe(true);
    expect(occurrenceOrdering.occurrenceId).toBe('reservation-create-effect:effect-a');
    expect(() =>
      Schema.decodeUnknownSync(InventoryOwnerAggregateRevisionOrderingSchema)({
        _tag: 'OWNER_AGGREGATE_REVISION',
        revision: 0,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(InventoryImmutableOccurrenceOrderingSchema)({
        _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY',
        occurrenceId: '   ',
      }),
    ).toThrow();
  });

  it('makes owner-read and producer-commit boundaries explicit without implementing a consumer state machine', () => {
    expect(currentInventoryTruthRequirement()).toEqual({
      currentTruthSource: 'SUPPORTED_OWNER_READ_OR_PROOF',
      eventSilenceIsCurrentProof: false,
      retainedEventIsCurrentGuarantee: false,
    });
    expect(inventoryDomainEventDeliveryFailureBoundary).toEqual({
      producerTransactionRolledBack: false,
      retry: 'SEPARATE_DELIVERY_RETRY',
    });
  });

  it('accepts only the minimal Reservation guarantee notice', () => {
    const payload = {
      ordering: {
        _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY',
        occurrenceId: 'reservation-create-effect:55555555-5555-4555-8555-555555555555',
      },
      ownerReadOrProofKey: 'commerce.inventory.api.inventory-reservation-detail',
      state: 'ESTABLISHED',
      subjectRef: {
        moduleId: 'commerce.inventory',
        resourceId: '44444444-4444-4444-8444-444444444444',
        resourceType: 'commerce.inventory.inventory-reservation',
        tenantId,
      },
    } as const;
    const decode = Schema.decodeUnknownSync(ReservationGuaranteeChangedPayloadSchema, {
      onExcessProperty: 'error',
    });

    expect(decode(payload)).toEqual(payload);
    expect(decode({ ...payload, state: 'RELEASED' })).toMatchObject({ state: 'RELEASED' });
    expect(decode({ ...payload, state: 'AT_RISK' })).toMatchObject({ state: 'AT_RISK' });
    expect(() => decode({ ...payload, state: 'PROTECTED' })).toThrow();
    expect(() =>
      decode({
        ordering: payload.ordering,
        state: payload.state,
        subjectRef: payload.subjectRef,
      }),
    ).toThrow();
    expect(() => decode({ ...payload, providerPayload: { token: 'secret' } })).toThrow();
  });

  it('accepts only revision-ordered Commitment Protection notices', () => {
    const payload = {
      ordering: { _tag: 'OWNER_AGGREGATE_REVISION', revision: 2 },
      ownerReadOrProofKey: 'commerce.inventory.api.commitment-protection-verification',
      state: 'AT_RISK',
      subjectRef: {
        moduleId: 'commerce.inventory',
        resourceId: '55555555-5555-4555-8555-555555555555',
        resourceType: 'commerce.inventory.commitment-protection',
        tenantId,
      },
    } as const;
    const decode = Schema.decodeUnknownSync(CommitmentProtectionChangedPayloadSchema, {
      onExcessProperty: 'error',
    });

    expect(decode(payload)).toEqual(payload);
    expect(decode({ ...payload, state: 'PROTECTED' })).toMatchObject({ state: 'PROTECTED' });
    expect(() =>
      decode({
        ...payload,
        ordering: { _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY', occurrenceId: 'effect-a' },
      }),
    ).toThrow();
    expect(() => decode({ ...payload, ownerReadOrProofKey: 'commerce.inventory.api.unknown' })).toThrow();
  });

  it('binds Stock Position change kind to owner revision or immutable effect ordering', () => {
    const subjectRef = {
      moduleId: 'commerce.inventory',
      resourceId: positionId,
      resourceType: 'commerce.inventory.stock-position',
      tenantId,
    } as const;
    const common = {
      ownerReadOrProofKey: 'commerce.inventory.api.current-stock-evidence-for-availability',
      subjectRef,
    } as const;
    const decode = Schema.decodeUnknownSync(StockPositionEvidenceChangedPayloadSchema, {
      onExcessProperty: 'error',
    });

    expect(
      decode({
        ...common,
        ordering: { _tag: 'OWNER_AGGREGATE_REVISION', revision: 7 },
        state: 'CORRECTED',
      }),
    ).toMatchObject({ state: 'CORRECTED' });
    expect(
      decode({
        ...common,
        ordering: { _tag: 'OWNER_AGGREGATE_REVISION', revision: 8 },
        state: 'INDETERMINATE',
      }),
    ).toMatchObject({ state: 'INDETERMINATE' });
    expect(
      decode({
        ...common,
        ordering: {
          _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY',
          occurrenceId: 'physical-stock-effect:66666666-6666-4666-8666-666666666666',
        },
        state: 'RECEIPT_APPLIED',
      }),
    ).toMatchObject({ state: 'RECEIPT_APPLIED' });
    expect(
      decode({
        ...common,
        ordering: {
          _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY',
          occurrenceId: 'physical-stock-effect:77777777-7777-4777-8777-777777777777',
        },
        state: 'ISSUE_APPLIED',
      }),
    ).toMatchObject({ state: 'ISSUE_APPLIED' });
    expect(() =>
      decode({
        ...common,
        ordering: { _tag: 'OWNER_AGGREGATE_REVISION', revision: 7 },
        state: 'ISSUE_APPLIED',
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...common,
        ordering: { _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY', occurrenceId: 'effect-a' },
        state: 'CORRECTED',
      }),
    ).toThrow();
  });

  it('accepts only immutable reconciliation-required committed-obligation notices', () => {
    const payload = {
      ordering: {
        _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY',
        occurrenceId: 'binding-correction-debt:77777777-7777-4777-8777-777777777777',
      },
      ownerReadOrProofKey: 'commerce.inventory.api.inventory-reconciliation-evidence',
      state: 'RECONCILIATION_REQUIRED',
      subjectRef: {
        moduleId: 'commerce.inventory',
        resourceId: '77777777-7777-4777-8777-777777777777',
        resourceType: 'commerce.inventory.imported-committed-obligation',
        tenantId,
      },
    } as const;
    const decode = Schema.decodeUnknownSync(CommittedObligationChangedPayloadSchema, {
      onExcessProperty: 'error',
    });

    expect(decode(payload)).toEqual(payload);
    expect(() => decode({ ...payload, state: 'COMMITTED' })).toThrow();
    expect(() => decode({ ...payload, consumerState: { reconciled: false } })).toThrow();
  });
});
