import { CORE_SEARCH_INGESTION_REGISTRATIONS } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';

import { outboxWorkers } from '../../src/workers/index.ts';

it('every accepted Party search lifecycle and explicit rebuild topic has its exact generated self-consumer', () => {
  for (const registration of CORE_SEARCH_INGESTION_REGISTRATIONS) {
    const matches = outboxWorkers.filter(
      ({ descriptor }) => descriptor.workerKey === registration.workerKey
    );
    expect(matches.length, registration.workerKey).toBe(1);
    const [worker] = matches;
    expect(worker).toBeDefined();
    if (worker === undefined) {
      throw new Error('Expected registered worker');
    }
    expect(worker.descriptor.topic).toBe(registration.topic);
    expect(worker.descriptor.producerModuleKey).toBe('party.registry');
    expect(worker.descriptor.consumerModuleKey).toBe('party.registry');
    expect(worker.descriptor.entrypoint.access).toBe('background');
    expect(worker.descriptor.entrypoint.scope).toBe('tenant');
  }
  expect(CORE_SEARCH_INGESTION_REGISTRATIONS.length).toBe(15);
});
