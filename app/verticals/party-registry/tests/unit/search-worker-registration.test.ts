import assert from 'node:assert/strict';
import test from 'node:test';
import { CORE_SEARCH_INGESTION_REGISTRATIONS } from '@app/core-runtime';
import { outboxWorkers } from '../../src/workers/index.ts';

test('every accepted Party search lifecycle and explicit rebuild topic has its exact generated self-consumer', () => {
  for (const registration of CORE_SEARCH_INGESTION_REGISTRATIONS) {
    const matches = outboxWorkers.filter(
      ({ descriptor }) => descriptor.workerKey === registration.workerKey,
    );
    assert.equal(matches.length, 1, registration.workerKey);
    const [worker] = matches;
    assert.ok(worker);
    assert.equal(worker.descriptor.topic, registration.topic);
    assert.equal(worker.descriptor.producerModuleKey, 'party.registry');
    assert.equal(worker.descriptor.consumerModuleKey, 'party.registry');
    assert.equal(worker.descriptor.entrypoint.access, 'background');
    assert.equal(worker.descriptor.entrypoint.scope, 'tenant');
  }
  assert.equal(CORE_SEARCH_INGESTION_REGISTRATIONS.length, 15);
});
