import { Effect, Schema, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { createActionCollector } from '../../src/actions/collector.ts';

const event = (id: string) =>
  ({
    eventType: 'counter.changed',
    payloadJson: { id },
    producerModuleKey: 'shell.core',
    subjectModuleKey: 'shell.core',
    subjectResourceId: id,
    subjectResourceType: 'counter',
  }) as const;

const message = (topic: string) => ({
  payloadJson: { topic },
  producerModuleKey: 'shell.core',
  topic,
});

const domainEventContracts = {
  'counter.changed': Schema.Struct({
    id: Schema.String,
    mutable: Schema.optionalKey(Schema.Struct({ value: Schema.Finite })),
  }),
} as const;

const makeCollector = () =>
  createActionCollector(
    domainEventContracts,
    'shell.core',
    {
      captureMode: 'metadata_only',
      policyKey: 'counter.read.v1',
    },
    Schema.Struct({
      checkpoint: Schema.String,
      nested: Schema.optionalKey(Schema.Json),
    })
  );

it.effect(
  'preserves event order, multiple messages, and events without messages',
  () =>
    Effect.gen(function* preservesEventOrderMultipleMessagesAndEventsWithout() {
      const collector = makeCollector();
      const first = yield* collector.addDomainEvent(event('first'));
      yield* collector.addDomainEvent(event('second'));
      yield* collector.addOutboxMessage(first, message('counter.project'));
      yield* collector.addOutboxMessage(first, message('counter.notify'));
      yield* collector.recordDataAccess({
        accessKind: 'read',
        queryHash: 'query-hash',
        resultCount: 1,
        servingModuleKey: 'shell.core',
        targetModuleKey: 'shell.core',
        targetResourceId: 'first',
        targetResourceType: 'counter',
      });

      const snapshot = collector.snapshot();

      expect(
        snapshot.domainEvents.map((item) => item.subjectResourceId)
      ).toEqual(['first', 'second']);
      expect(
        snapshot.outboxMessages.map((item) => [
          item.domainEventIndex,
          item.message.topic,
        ])
      ).toEqual([
        [0, 'counter.project'],
        [0, 'counter.notify'],
      ]);
      expect(snapshot.dataAccessEvents.length).toBe(1);
    })
);

it.effect('rejects orphan and foreign Domain Event references', () =>
  Effect.gen(function* rejectsOrphanAndForeignDomainEventReferences() {
    const first = makeCollector();
    const second = makeCollector();
    const foreign = yield* first.addDomainEvent(event('foreign'));

    const foreignError = yield* Effect.flip(
      second.addOutboxMessage(foreign, message('counter.project'))
    );
    const orphanError = yield* Effect.flip(
      second.addOutboxMessageInput({}, message('counter.project'))
    );

    expect(Predicate.isTagged(foreignError, 'ActionCollectorError')).toBe(true);
    expect(Predicate.isTagged(orphanError, 'ActionCollectorError')).toBe(true);
  })
);

it.effect(
  'does not expose externally mutable collector arrays or captured payloads',
  () =>
    Effect.gen(function* doesNotExposeExternallyMutableCollectorArraysOr() {
      const collector = makeCollector();
      const mutablePayload = { value: 1 };
      yield* collector.addDomainEvent({
        ...event('immutable'),
        payloadJson: { id: 'immutable', mutable: mutablePayload },
      });
      mutablePayload.value = 2;

      const snapshot = collector.snapshot();

      expect(Object.isFrozen(snapshot.domainEvents)).toBe(true);
      expect(Object.isFrozen(snapshot.domainEvents[0])).toBe(true);
      expect(snapshot.domainEvents[0]?.payloadJson).toEqual({
        id: 'immutable',
        mutable: { value: 1 },
      });
      expect(() => {
        Object.defineProperty(
          snapshot.domainEvents,
          snapshot.domainEvents.length,
          {
            value: event('mutated'),
          }
        );
      }).toThrow();
    })
);

it.effect(
  'captures one immutable JSON audit-evidence object and rejects invalid repeats',
  () =>
    Effect.gen(
      function* capturesOneImmutableJSONAuditevidenceObjectAndRejects() {
        const collector = makeCollector();
        const nested = { reason: 'support request' };
        yield* collector.recordAuditEvidence({ checkpoint: 'started', nested });
        nested.reason = 'mutated';

        const snapshot = collector.snapshot();
        expect(snapshot.auditEvidence).toEqual({
          checkpoint: 'started',
          nested: { reason: 'support request' },
        });
        expect(Object.isFrozen(snapshot.auditEvidence)).toBe(true);
        expect(Object.isFrozen(snapshot.auditEvidence['nested'])).toBe(true);

        const repeated = yield* Effect.flip(
          collector.recordAuditEvidence({ checkpoint: 'stopped' })
        );
        const invalid = yield* Effect.flip(
          makeCollector().recordAuditEvidenceInput({ value: undefined })
        );
        const undeclared = yield* Effect.flip(
          makeCollector().recordAuditEvidence({
            checkpoint: 'started',
            secret: 'must-not-persist',
          })
        );
        const missingSchema = yield* Effect.flip(
          createActionCollector(domainEventContracts, 'shell.core', {
            captureMode: 'metadata_only',
            policyKey: 'counter.read.v1',
          }).recordAuditEvidence({ checkpoint: 'started' })
        );
        expect(Predicate.isTagged(repeated, 'ActionCollectorError')).toBe(true);
        expect(Predicate.isTagged(invalid, 'ActionCollectorError')).toBe(true);
        expect(Predicate.isTagged(undeclared, 'ActionCollectorError')).toBe(
          true
        );
        expect(Predicate.isTagged(missingSchema, 'ActionCollectorError')).toBe(
          true
        );
      }
    )
);

it.effect(
  'applies descriptor evidence policy and rejects incompatible evidence',
  () =>
    Effect.gen(
      function* appliesDescriptorEvidencePolicyAndRejectsIncompatibleEvidence() {
        const collector = createActionCollector(
          domainEventContracts,
          'shell.core',
          {
            captureMode: 'redacted_payload',
            policyKey: 'counter.read.redacted.v1',
            redactionProfile: 'counter.summary.v1',
          }
        );
        const error = yield* Effect.flip(
          collector.recordDataAccessInput({
            accessKind: 'read',
            queryHash: 'query-hash',
            resultCount: 1,
            servingModuleKey: 'shell.core',
          })
        );

        expect(Predicate.isTagged(error, 'ActionCollectorError')).toBe(true);

        const metadataCollector = makeCollector();
        yield* metadataCollector.recordDataAccessInput({
          accessKind: 'read',
          evidenceCaptureMode: 'stored_artifact',
          evidencePolicyKey: 'handler-controlled',
          queryHash: 'metadata-query',
          resultCount: 1,
          servingModuleKey: 'shell.core',
        });
        expect(
          metadataCollector.snapshot().dataAccessEvents[0]?.evidenceCaptureMode
        ).toBe('metadata_only');
        expect(
          metadataCollector.snapshot().dataAccessEvents[0]?.evidencePolicyKey
        ).toBe('counter.read.v1');
      }
    )
);

it.effect(
  'rejects an Outbox producer that differs from its registered Domain Event',
  () =>
    Effect.gen(function* rejectsAnOutboxProducerThatDiffersFromIts() {
      const collector = makeCollector();
      const reference = yield* collector.addDomainEvent(event('producer'));
      const error = yield* Effect.flip(
        collector.addOutboxMessage(reference, {
          payloadJson: {},
          producerModuleKey: 'another.module',
          topic: 'counter.project',
        })
      );

      expect(Predicate.isTagged(error, 'ActionCollectorError')).toBe(true);
    })
);

it.effect(
  'enforces Action-declared event payloads and producer ownership',
  () =>
    Effect.gen(
      function* enforcesActiondeclaredEventPayloadsAndProducerOwnership() {
        const collector = makeCollector();
        const invalidPayload = yield* Effect.flip(
          collector.addDomainEventInput({
            ...event('payload'),
            payloadJson: { id: 1 },
          })
        );
        const invalidProducer = yield* Effect.flip(
          collector.addDomainEvent({
            ...event('producer'),
            producerModuleKey: 'another.module',
          })
        );
        const undeclared = yield* Effect.flip(
          collector.addDomainEventInput({
            ...event('undeclared'),
            eventType: 'counter.reset',
          })
        );
        const inheritedName = yield* Effect.flip(
          collector.addDomainEventInput({
            ...event('inherited'),
            eventType: 'toString',
          })
        );

        expect(Predicate.isTagged(invalidPayload, 'ActionCollectorError')).toBe(
          true
        );
        expect(
          Predicate.isTagged(invalidProducer, 'ActionCollectorError')
        ).toBe(true);
        expect(Predicate.isTagged(undeclared, 'ActionCollectorError')).toBe(
          true
        );
        expect(Predicate.isTagged(inheritedName, 'ActionCollectorError')).toBe(
          true
        );
        expect(collector.snapshot().domainEvents.length).toBe(0);
      }
    )
);
