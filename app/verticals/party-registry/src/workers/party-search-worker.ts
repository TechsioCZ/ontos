import { defineOutboxWorker } from '@app/core-runtime';
import type { OutboxWorkerDescriptor, OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Effect } from 'effect';
import type { Schema } from 'effect';

import { PartySearchProjector } from '../services/party-search-projection.service.ts';
import type { PartySearchProjectionTarget } from '../services/party-search-projection.service.ts';

export const definePartySearchWorker = <PayloadSchema extends Schema.ConstraintDecoder<unknown>>(
  descriptor: Pick<
    OutboxWorkerDescriptor<PayloadSchema, 'party.registry', 'party.registry'>,
    'entrypoint' | 'payloadSchema' | 'producerModuleKey' | 'topic'
  >,
  projection: {
    readonly spanName: string;
    readonly target: (payload: PayloadSchema['Type']) => PartySearchProjectionTarget;
  },
) => {
  const handle = Effect.fn(projection.spanName)(function* projectCommittedEvent(
    payload: PayloadSchema['Type'],
    context: OutboxWorkerHandlerContext,
  ) {
    const projector = yield* PartySearchProjector;
    yield* projector.project(context, projection.target(payload));
  });
  const worker = defineOutboxWorker(
    {
      ...descriptor,
      consumerModuleKey: 'party.registry',
      leaseDurationMs: 30_000,
      retryPolicy: {
        initialBackoffMs: 1000,
        maxAttempts: 5,
        maxBackoffMs: 60_000,
        multiplier: 2,
      },
      workerKey: descriptor.entrypoint.entrypointKey,
    },
    handle,
  );
  return { handle, worker };
};
