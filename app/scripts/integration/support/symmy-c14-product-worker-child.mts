import { outboxWorkerEntry } from '@app/symmy-integration/outbox-worker-host';
import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Effect, Layer, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { holdC14ModuleCredential } from './symmy-c14-module-credential-channel.mts';

const run = Effect.gen(function* runActualSymmyWorker() {
  const claimOwner = yield* Config.String('ONTOS_C14_WORKER_CLAIM_OWNER');
  // The Symmy module key arrives on the worker's private channel before it claims a delivery; never from the environment.
  yield* holdC14ModuleCredential('symmy-integration');
  const line = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Struct({ type: Schema.Literal('ready') })))({
    type: 'ready',
  });
  yield* Effect.sync(() => process.stdout.write(`${line}\n`));
  return yield* outboxWorkerEntry.runLoop({ config: { claimOwner, maxDeliveries: 1, pollIntervalMs: 100 } });
});
NodeRuntime.runMain(
  run.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer))),
);
