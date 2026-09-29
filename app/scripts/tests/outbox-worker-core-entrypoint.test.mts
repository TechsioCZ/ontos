import { readFileSync } from 'node:fs';

import { transform } from 'esbuild';
import { Array as EffectArray, Effect, Order } from 'effect';
import { expect, it } from 'effect-rstest';

import { coreRuntimeValueReExports, focusedEntrypointValueExports } from '../materialize-outbox-worker.mjs';

it.live('reads live value re-exports from Core, ignoring comments and type-only ones', () =>
  Effect.gen(function* liveReExports() {
    const source = [
      "export { ContextAccessLive as outboxWorkerContextAccessLive } from '@app/core-runtime';",
      "export { type OutboxRuntime, BusinessPermissionRelationshipMutationLive } from '@app/core-runtime';",
      "export type { AnyOutboxWorkerRegistration } from '@app/core-runtime';",
      "export { defineOutboxWorkerCompletion as completion } from '@app/core-runtime/outbox/worker';",
      "// export { RemovedBinding } from '@app/core-runtime';",
      "/* export { AlsoRemoved } from '@app/core-runtime'; */",
      "export { other } from '@app/core-runtime/testing/actions';",
      "export { local } from './local.ts';",
    ].join('\n');
    const compiled = yield* Effect.promise(async () => await transform(source, { format: 'esm', loader: 'ts' }));
    expect(EffectArray.sort(coreRuntimeValueReExports(compiled.code), Order.String)).toEqual([
      'BusinessPermissionRelationshipMutationLive',
      'ContextAccessLive',
      'defineOutboxWorkerCompletion',
    ]);
  }),
);

it.live('exports every Core value the deployed worker hosts re-export', () =>
  Effect.gen(function* workerHostReExports() {
    const entrypoint = focusedEntrypointValueExports(
      readFileSync(new URL('../../packages/core-runtime/src/outbox/worker-entrypoint.ts', import.meta.url), 'utf-8'),
    );
    const workerLayer = readFileSync(
      new URL('../../verticals/commerce-customer-context/src/worker-host/layer.ts', import.meta.url),
      'utf-8',
    );
    const compiled = yield* Effect.promise(async () => await transform(workerLayer, { format: 'esm', loader: 'ts' }));
    const reExports = coreRuntimeValueReExports(compiled.code);
    expect(reExports).toContain('ContextAccessLive');
    for (const name of reExports) {
      expect(entrypoint.has(name), name).toBe(true);
    }
    expect(entrypoint.has('AnyOutboxWorkerRegistration')).toBe(false);
  }),
);
