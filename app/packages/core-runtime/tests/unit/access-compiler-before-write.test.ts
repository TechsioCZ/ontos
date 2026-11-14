import { v1 } from '@authzed/authzed-node';
import { Effect, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { AccessProjectionError } from '../../src/access/compiler/projection-error.ts';
import { makeAccessProjectionCompiler } from '../../src/access/compiler/spice-db-compiler.ts';
import type { AccessProjectionTransport } from '../../src/access/compiler/spice-db-compiler.ts';
import { projectionIntent } from './access-compiler-fixtures.ts';

/*
 * The writer learns from `beforeWrite` that the engine is about to be written (from then on the graph may be
 * half-written, so its fence stays closed on a failure) and stops a write it may no longer make. The compiler must run
 * it before every relationship write it sends, and send nothing once it refuses.
 */
const emptyEngine = (log: string[]): AccessProjectionTransport => ({
  close: () => {},
  readRelationships: () => Effect.succeed([]),
  writeRelationships: (request) =>
    Effect.sync(() => {
      log.push(`write ${String(request.updates.length)}`);
      return v1.WriteRelationshipsResponse.create({});
    }),
});

it.effect('runs beforeWrite before every relationship write it sends', () =>
  Effect.gen(function* everyWrite() {
    const log: string[] = [];
    const compiler = makeAccessProjectionCompiler(emptyEngine(log));
    yield* Effect.result(
      compiler.reconcile(projectionIntent(), {
        beforeWrite: Effect.sync(() => {
          log.push('check');
        }),
        fence: () => Effect.void,
      }),
    );
    const writes = log.filter((entry) => entry.startsWith('write'));
    expect(writes.length).toBeGreaterThan(0);
    expect(log).toEqual(writes.flatMap((write) => ['check', write]));
  }),
);

it.effect('sends nothing once beforeWrite refuses, and fails with its refusal', () =>
  Effect.gen(function* refusedWrite() {
    const log: string[] = [];
    const compiler = makeAccessProjectionCompiler(emptyEngine(log));
    const refusal = new AccessProjectionError({ code: 'access_projection_unavailable', reason: 'hold lost' });
    const outcome = yield* Effect.result(
      compiler.reconcile(projectionIntent(), { beforeWrite: Effect.fail([refusal]), fence: () => Effect.void }),
    );
    expect(Result.isFailure(outcome) ? outcome.failure : []).toEqual([refusal]);
    expect(log).toEqual([]);
  }),
);
