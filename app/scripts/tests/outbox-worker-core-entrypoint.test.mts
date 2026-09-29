import { readFileSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

import { coreRuntimeValueReExports, focusedEntrypointValueExports } from '../materialize-outbox-worker.mjs';

it('reads value re-exports from Core and skips type-only ones', () => {
  const source = [
    "export { ContextAccessLive as outboxWorkerContextAccessLive } from '@app/core-runtime';",
    "export { type OutboxRuntime, BusinessPermissionRelationshipMutationLive } from '@app/core-runtime';",
    "export type { AnyOutboxWorkerRegistration } from '@app/core-runtime';",
    "export { local } from './local.ts';",
  ].join('\n');
  expect(coreRuntimeValueReExports(source)).toEqual([
    'ContextAccessLive',
    'BusinessPermissionRelationshipMutationLive',
  ]);
});

it('exports every Core value the deployed worker hosts re-export', () => {
  const entrypoint = focusedEntrypointValueExports(
    readFileSync(new URL('../../packages/core-runtime/src/outbox/worker-entrypoint.ts', import.meta.url), 'utf-8'),
  );
  const workerLayer = readFileSync(
    new URL('../../verticals/commerce-customer-context/src/worker-host/layer.ts', import.meta.url),
    'utf-8',
  );
  for (const name of coreRuntimeValueReExports(workerLayer)) {
    expect(entrypoint.has(name), name).toBe(true);
  }
  expect(entrypoint.has('AnyOutboxWorkerRegistration')).toBe(false);
});
