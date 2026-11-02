import { DateTime, Effect, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  RetainedOwnerHistoryEnvelopeSchema,
  RetainedOwnerHistoryRequestSchema,
} from '../../src/actions/retained-owner-history.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '10000000-0000-4000-8000-000000000002';
const subjectRef = {
  moduleId: 'owner.fixture',
  resourceId: 'profile-1',
  resourceType: 'owner.fixture.profile',
  tenantId,
};
const selectors = [
  { actionKey: 'owner.fixture.change', binding: { kind: 'subject' }, eventType: 'owner.fixture.changed.v1' },
  {
    actionKey: 'owner.fixture.remove',
    binding: {
      aggregateRefKey: 'profileRef',
      kind: 'payload_refs',
      subjectRefKey: 'entitlementRef',
      subjectResourceType: 'owner.fixture.entitlement',
    },
    eventType: 'owner.fixture.removed.v1',
  },
];
const event = {
  actionInvocationId: '10000000-0000-4000-8000-000000000003',
  actionKey: 'owner.fixture.change',
  completedAt: '2026-10-19T12:00:00.000Z',
  domainEventId: '10000000-0000-4000-8000-000000000004',
  eventType: 'owner.fixture.changed.v1',
  occurredAt: '2026-10-19T12:00:00.000Z',
  payloadJson: {
    changes: [
      { kind: 'GRANT', ref: 'first' },
      { kind: 'END', ref: 'second' },
    ],
    profileRef: subjectRef,
  },
  producerModuleKey: 'owner.fixture',
  subjectModuleKey: 'owner.fixture',
  subjectResourceId: 'profile-1',
  subjectResourceType: 'owner.fixture.profile',
  tenantSequenceNo: '17',
};
const envelope = {
  events: [event],
  legalEntityId,
  outcome: 'READ_COMPLETE',
  schemaVersion: '1',
  selectors,
  subjectRef,
};
const decode = Schema.decodeUnknownEffect(RetainedOwnerHistoryEnvelopeSchema, { onExcessProperty: 'error' });
const decodeRequest = Schema.decodeUnknownEffect(RetainedOwnerHistoryRequestSchema, { onExcessProperty: 'error' });

it.effect('preserves exact original owner payload order and permits unrelated gaps in the global sequence', () =>
  Effect.gen(function* originalPayload() {
    const next = { ...event, domainEventId: '10000000-0000-4000-8000-000000000005', tenantSequenceNo: '99' };
    const decoded = yield* decode({ ...envelope, events: [event, next] });
    expect(decoded.events[0]?.payloadJson).toEqual(event.payloadJson);
    expect(decoded.events.map((value) => value.tenantSequenceNo)).toEqual(['17', '99']);
    expect(DateTime.formatIso(Option.getOrThrow(Option.fromNullishOr(decoded.events[0])).completedAt)).toBe(
      event.completedAt,
    );
  }),
);

it.effect('requires exact scope and bounded closed selector/request metadata', () =>
  Effect.gen(function* requestBoundary() {
    const request = { legalEntityId, limit: 256, ownerModuleKey: 'owner.fixture', selectors, subjectRef, tenantId };
    yield* decodeRequest(request);
    for (const input of [
      { ...request, limit: 257 },
      { ...request, limit: 0 },
      { ...request, selectors: [] },
      { ...request, selectors: [...selectors, selectors[0]] },
      { ...request, ownerModuleKey: 'foreign.owner' },
      { ...request, subjectRef: { ...subjectRef, tenantId: legalEntityId } },
      { ...request, selectors: [{ ...selectors[1], predicate: 'arbitrary' }] },
      {
        ...request,
        selectors: [
          { ...selectors[1], binding: { ...selectors[1]?.binding, aggregateRefKey: 'profileRef->tenantId' } },
        ],
      },
    ]) {
      expect(Predicate.isTagged(yield* Effect.flip(decodeRequest(input)), 'SchemaError')).toBe(true);
    }
  }),
);

it.effect('never presents truncated or unusable binding evidence as a partial usable history', () =>
  Effect.gen(function* incompleteBoundary() {
    for (const outcome of ['TRUNCATED', 'UNUSABLE_BINDING']) {
      expect((yield* decode({ ...envelope, events: [], outcome })).events).toEqual([]);
      expect(Predicate.isTagged(yield* Effect.flip(decode({ ...envelope, outcome })), 'SchemaError')).toBe(true);
    }
  }),
);

it.effect('rejects mismatched producer/action/subject, duplicate rows, reverse ordering and malformed timestamps', () =>
  Effect.gen(function* boundEventBoundary() {
    for (const events of [
      [{ ...event, producerModuleKey: 'foreign.owner' }],
      [{ ...event, actionKey: 'owner.fixture.other' }],
      [{ ...event, subjectResourceId: 'foreign-profile' }],
      [event, event],
      [event, { ...event, domainEventId: '10000000-0000-4000-8000-000000000005', tenantSequenceNo: '16' }],
      [{ ...event, completedAt: 'not-an-instant' }],
    ]) {
      expect(Predicate.isTagged(yield* Effect.flip(decode({ ...envelope, events })), 'SchemaError')).toBe(true);
    }
  }),
);

it.effect(
  'binds an entitlement-subject event to its exact aggregate and independently checks the actual retained subject',
  () =>
    Effect.gen(function* payloadReferenceBinding() {
      const entitlementRef = { ...subjectRef, resourceId: 'entitlement-1', resourceType: 'owner.fixture.entitlement' };
      const removal = {
        ...event,
        actionKey: 'owner.fixture.remove',
        eventType: 'owner.fixture.removed.v1',
        payloadJson: { entitlementRef, profileRef: subjectRef },
        subjectResourceId: entitlementRef.resourceId,
        subjectResourceType: entitlementRef.resourceType,
      };
      yield* decode({ ...envelope, events: [removal] });
      for (const payloadJson of [
        { entitlementRef, profileRef: { ...subjectRef, resourceId: 'foreign-profile' } },
        { entitlementRef: { ...entitlementRef, tenantId: legalEntityId }, profileRef: subjectRef },
        { entitlementRef: { ...entitlementRef, resourceId: 'foreign-entitlement' }, profileRef: subjectRef },
        { entitlementRef: { ...entitlementRef, extra: 'unrecognized' }, profileRef: subjectRef },
      ]) {
        expect(
          Predicate.isTagged(
            yield* Effect.flip(decode({ ...envelope, events: [{ ...removal, payloadJson }] })),
            'SchemaError',
          ),
        ).toBe(true);
      }
    }),
);
