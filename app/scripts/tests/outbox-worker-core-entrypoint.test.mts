import { readFileSync } from 'node:fs';

import { Array as EffectArray, Order } from 'effect';
import { expect, it } from 'effect-rstest';

import { coreRuntimeValueReExports, focusedEntrypointValueExports } from '../materialize-outbox-worker.mjs';

it('reads live value re-exports from Core, ignoring comments, strings, and type-only ones', () => {
  const source = [
    "export { ContextAccessLive as outboxWorkerContextAccessLive } from '@app/core-runtime';",
    "export { type OutboxRuntime, BusinessPermissionRelationshipMutationLive } from '@app/core-runtime';",
    "export type { AnyOutboxWorkerRegistration } from '@app/core-runtime';",
    "export { defineOutboxWorkerCompletion as completion } from '@app/core-runtime/outbox/worker';",
    "// export { RemovedBinding } from '@app/core-runtime';",
    "/* export { AlsoRemoved } from '@app/core-runtime'; */",
    "console.log(`export { FromString } from '@app/core-runtime'`);",
    "export { other } from '@app/core-runtime/testing/actions';",
    "export { local } from './local.ts';",
  ].join('\n');
  expect(EffectArray.sort(coreRuntimeValueReExports('layer.ts', source), Order.String)).toEqual([
    'BusinessPermissionRelationshipMutationLive',
    'ContextAccessLive',
    'defineOutboxWorkerCompletion',
  ]);
});

it('reads only live value exports of the focused entrypoint', () => {
  const exports = focusedEntrypointValueExports(
    [
      "export { Live, Other as Renamed } from './live.ts';",
      "// export { CommentedOut } from './gone.ts';",
      "export { type OnlyType } from './types.ts';",
      "export type { AlsoType } from './types.ts';",
    ].join('\n'),
  );
  expect(EffectArray.sort([...exports], Order.String)).toEqual(['Live', 'Renamed']);
});

it('exports every Core value the deployed worker hosts re-export', () => {
  const entrypoint = focusedEntrypointValueExports(
    readFileSync(new URL('../../packages/core-runtime/src/outbox/worker-entrypoint.ts', import.meta.url), 'utf-8'),
  );
  const layerPath = '../../verticals/commerce-customer-context/src/worker-host/layer.ts';
  const reExports = coreRuntimeValueReExports('layer.ts', readFileSync(new URL(layerPath, import.meta.url), 'utf-8'));
  expect(reExports).toContain('ContextAccessLive');
  for (const name of reExports) {
    expect(entrypoint.has(name), name).toBe(true);
  }
  expect(entrypoint.has('AnyOutboxWorkerRegistration')).toBe(false);
});
