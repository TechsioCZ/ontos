import assert from 'node:assert/strict';
import test from 'node:test';
import type { Layer } from 'effect';
import type {
  DatabaseConfigError,
  DatabaseConnectionError,
  OutboxRuntime,
} from '@app/core-runtime';
import { outboxWorkerLayer } from '../../src/worker-host/layer.ts';
import type { PartySearchProjector } from '../../src/services/party-search-projection.service.ts';

const workerRootLayer: Layer.Layer<
  OutboxRuntime | PartySearchProjector,
  DatabaseConfigError | DatabaseConnectionError,
  never
> = outboxWorkerLayer;

test('worker root exposes a fully composed layer', () => {
  assert.strictEqual(workerRootLayer, outboxWorkerLayer);
});
