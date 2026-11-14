import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { WorkerArtifactManifest, assertWorkerArtifact, workerArtifactJson } from '../ci/worker-host-artifact.mts';

const expected = { digest: 'b'.repeat(64), sourceRevision: 'a'.repeat(40), workflowRun: '100' };
const manifest = new WorkerArtifactManifest({ version: 1, ...expected });

it.effect('round-trips the portable worker manifest and accepts only the same-run artifact', () =>
  Effect.gen(function* workerManifest() {
    const encoded = yield* Schema.encodeEffect(workerArtifactJson)(manifest);
    const decoded = yield* Schema.decodeEffect(workerArtifactJson)(encoded);
    expect(decoded).toEqual(manifest);
    return yield* assertWorkerArtifact(decoded, expected);
  }),
);

it.effect('refuses stale workflow, source and archive identities before installing a runtime', () =>
  Effect.gen(function* workerProvenance() {
    for (const changed of [
      { ...expected, workflowRun: 'other-run' },
      { ...expected, sourceRevision: 'c'.repeat(40) },
      { ...expected, digest: 'd'.repeat(64) },
    ]) {
      expect(Exit.isFailure(yield* assertWorkerArtifact(manifest, changed).pipe(Effect.exit))).toBe(true);
    }
    return yield* Effect.void;
  }),
);
