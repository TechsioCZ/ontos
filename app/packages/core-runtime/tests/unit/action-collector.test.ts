import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { makeActionCollector } from '../../src/actions/collector.ts';
import type { DomainEventReference } from '../../src/actions/events.ts';

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
  makeActionCollector(
    domainEventContracts,
    'shell.core',
    {
      captureMode: 'metadata_only',
      policyKey: 'counter.read.v1',
    },
    Schema.Struct({ checkpoint: Schema.String, nested: Schema.optionalKey(Schema.Json) }),
  );

test('preserves event order, multiple messages, and events without messages', async () => {
  const collector = makeCollector();
  const first = await Effect.runPromise(collector.addDomainEvent(event('first')));
  await Effect.runPromise(collector.addDomainEvent(event('second')));
  await Effect.runPromise(collector.addOutboxMessage(first, message('counter.project')));
  await Effect.runPromise(collector.addOutboxMessage(first, message('counter.notify')));
  await Effect.runPromise(
    collector.recordDataAccess({
      accessKind: 'read',
      queryHash: 'query-hash',
      resultCount: 1,
      servingModuleKey: 'shell.core',
      targetModuleKey: 'shell.core',
      targetResourceId: 'first',
      targetResourceType: 'counter',
    }),
  );

  const snapshot = collector.snapshot();

  assert.deepEqual(
    snapshot.domainEvents.map((item) => item.subjectResourceId),
    ['first', 'second'],
  );
  assert.deepEqual(
    snapshot.outboxMessages.map((item) => [item.domainEventIndex, item.message.topic]),
    [
      [0, 'counter.project'],
      [0, 'counter.notify'],
    ],
  );
  assert.equal(snapshot.dataAccessEvents.length, 1);
});

test('rejects orphan and foreign Domain Event references', async () => {
  const first = makeCollector();
  const second = makeCollector();
  const foreign = await Effect.runPromise(first.addDomainEvent(event('foreign')));

  const foreignError = await Effect.runPromise(
    Effect.flip(second.addOutboxMessage(foreign, message('counter.project'))),
  );
  const orphanError = await Effect.runPromise(
    Effect.flip(second.addOutboxMessage({} as DomainEventReference, message('counter.project'))),
  );

  assert.equal(foreignError._tag, 'ActionCollectorError');
  assert.equal(orphanError._tag, 'ActionCollectorError');
});

test('does not expose externally mutable collector arrays or captured payloads', async () => {
  const collector = makeCollector();
  const mutablePayload = { value: 1 };
  await Effect.runPromise(
    collector.addDomainEvent({
      ...event('immutable'),
      payloadJson: { id: 'immutable', mutable: mutablePayload },
    }),
  );
  mutablePayload.value = 2;

  const snapshot = collector.snapshot();

  assert.equal(Object.isFrozen(snapshot.domainEvents), true);
  assert.equal(Object.isFrozen(snapshot.domainEvents[0]), true);
  assert.deepEqual(snapshot.domainEvents[0]?.payloadJson, {
    id: 'immutable',
    mutable: { value: 1 },
  });
  assert.throws(() => {
    (snapshot.domainEvents as unknown[]).push(event('mutated'));
  });
});

test('captures one immutable JSON audit-evidence object and rejects invalid repeats', async () => {
  const collector = makeCollector();
  const nested = { reason: 'support request' };
  await Effect.runPromise(collector.recordAuditEvidence({ checkpoint: 'started', nested }));
  nested.reason = 'mutated';

  const snapshot = collector.snapshot();
  assert.deepEqual(snapshot.auditEvidence, {
    checkpoint: 'started',
    nested: { reason: 'support request' },
  });
  assert.equal(Object.isFrozen(snapshot.auditEvidence), true);
  assert.equal(Object.isFrozen(snapshot.auditEvidence['nested']), true);

  const repeated = await Effect.runPromise(
    Effect.flip(collector.recordAuditEvidence({ checkpoint: 'stopped' })),
  );
  const invalid = await Effect.runPromise(
    Effect.flip(makeCollector().recordAuditEvidence({ value: undefined } as never)),
  );
  const undeclared = await Effect.runPromise(
    Effect.flip(
      makeCollector().recordAuditEvidence({ checkpoint: 'started', secret: 'must-not-persist' }),
    ),
  );
  const missingSchema = await Effect.runPromise(
    Effect.flip(
      makeActionCollector(domainEventContracts, 'shell.core', {
        captureMode: 'metadata_only',
        policyKey: 'counter.read.v1',
      }).recordAuditEvidence({ checkpoint: 'started' }),
    ),
  );
  assert.equal(repeated._tag, 'ActionCollectorError');
  assert.equal(invalid._tag, 'ActionCollectorError');
  assert.equal(undeclared._tag, 'ActionCollectorError');
  assert.equal(missingSchema._tag, 'ActionCollectorError');
});

test('applies descriptor evidence policy and rejects incompatible evidence', async () => {
  const collector = makeActionCollector(domainEventContracts, 'shell.core', {
    captureMode: 'redacted_payload',
    policyKey: 'counter.read.redacted.v1',
    redactionProfile: 'counter.summary.v1',
  });
  const error = await Effect.runPromise(
    Effect.flip(
      collector.recordDataAccess({
        accessKind: 'read',
        queryHash: 'query-hash',
        resultCount: 1,
        servingModuleKey: 'shell.core',
      } as never),
    ),
  );

  assert.equal(error._tag, 'ActionCollectorError');

  const metadataCollector = makeCollector();
  await Effect.runPromise(
    metadataCollector.recordDataAccess({
      accessKind: 'read',
      evidenceCaptureMode: 'stored_artifact',
      evidencePolicyKey: 'handler-controlled',
      queryHash: 'metadata-query',
      resultCount: 1,
      servingModuleKey: 'shell.core',
    } as never),
  );
  assert.equal(
    metadataCollector.snapshot().dataAccessEvents[0]?.evidenceCaptureMode,
    'metadata_only',
  );
  assert.equal(
    metadataCollector.snapshot().dataAccessEvents[0]?.evidencePolicyKey,
    'counter.read.v1',
  );
});

test('rejects an Outbox producer that differs from its registered Domain Event', async () => {
  const collector = makeCollector();
  const reference = await Effect.runPromise(collector.addDomainEvent(event('producer')));
  const error = await Effect.runPromise(
    Effect.flip(
      collector.addOutboxMessage(reference, {
        payloadJson: {},
        producerModuleKey: 'another.module',
        topic: 'counter.project',
      }),
    ),
  );

  assert.equal(error._tag, 'ActionCollectorError');
});

test('enforces Action-declared event payloads and producer ownership', async () => {
  const collector = makeCollector();
  const invalidPayload = await Effect.runPromise(
    Effect.flip(
      collector.addDomainEvent({
        ...event('payload'),
        payloadJson: { id: 1 },
      } as never),
    ),
  );
  const invalidProducer = await Effect.runPromise(
    Effect.flip(
      collector.addDomainEvent({
        ...event('producer'),
        producerModuleKey: 'another.module',
      }),
    ),
  );
  const undeclared = await Effect.runPromise(
    Effect.flip(
      collector.addDomainEvent({
        ...event('undeclared'),
        eventType: 'counter.reset',
      } as never),
    ),
  );
  const inheritedName = await Effect.runPromise(
    Effect.flip(
      collector.addDomainEvent({
        ...event('inherited'),
        eventType: 'toString',
      } as never),
    ),
  );

  assert.equal(invalidPayload._tag, 'ActionCollectorError');
  assert.equal(invalidProducer._tag, 'ActionCollectorError');
  assert.equal(undeclared._tag, 'ActionCollectorError');
  assert.equal(inheritedName._tag, 'ActionCollectorError');
  assert.equal(collector.snapshot().domainEvents.length, 0);
});
