import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

import { buildShardUnits, readReleaseModules, SHELL_SHARD } from './build-shard-units.mts';
import { SHELL_ID } from './hosted-units.mts';

const BuildWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    build: Schema.Struct({
      env: Schema.Struct({ SHARDS: Schema.Number }),
      steps: Schema.Array(
        Schema.Struct({
          env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
          name: Schema.optionalKey(Schema.String),
          run: Schema.optionalKey(Schema.String),
          with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      ),
      strategy: Schema.Struct({ matrix: Schema.Struct({ shard: Schema.Array(Schema.Number) }) }),
    }),
  }),
});

const MATRIX_SHARD = `\${{ matrix.shard }}`;

const readBuildJob = Effect.gen(function* readBuildJob() {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(
    path.resolve(import.meta.dirname, '../../../.github/workflows/zerops-stage.yml'),
  );
  return { job: (yield* Schema.decodeUnknownEffect(BuildWorkflowSchema)(parse(source))).jobs.build, source };
});

it.effect('builds the Shell alone and every released module in exactly one other shard', () =>
  Effect.gen(function* shellAlone() {
    const modules = yield* readReleaseModules;
    const { job } = yield* readBuildJob;
    const shards = job.env.SHARDS;
    const dealt = buildShardUnits(modules, shards);
    expect(job.strategy.matrix.shard).toEqual(Array.from({ length: shards }, (_, shard) => shard));
    expect(dealt[SHELL_SHARD]).toEqual([SHELL_ID]);
    const built = dealt.flat().filter((unit) => unit !== SHELL_ID);
    expect(built.toSorted()).toEqual([...modules].toSorted());
    const sizes = dealt.slice(1).map((units) => units.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('keeps every module that did not share the Shell shard in its cached shard', () =>
  Effect.gen(function* stableShards() {
    const modules = yield* readReleaseModules;
    const shards = (yield* readBuildJob).job.env.SHARDS;
    const dealt = buildShardUnits(modules, shards);
    for (const [position, module] of modules.entries()) {
      const previous = (position + 1) % shards;
      if (previous !== SHELL_SHARD) {
        expect(dealt[previous], module).toContain(module);
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('builds, caches and uploads each shard under its own shard number', () =>
  Effect.gen(function* shardWiring() {
    const { job, source } = yield* readBuildJob;
    const step = (name: string) => job.steps.find((candidate) => candidate.name === name);
    const build = step("Build the shard's units");
    expect(build?.env?.SHARD).toBe(MATRIX_SHARD);
    expect(build?.run).toContain('scripts/zerops/build-shard-units.mts "$SHARD" "$SHARDS"');
    expect(build?.run).not.toContain('node -e');
    expect(step("Restore the shard's unit builds")?.with?.key).toBe(`zerops-units-${MATRIX_SHARD}-\${{ github.sha }}`);
    expect(step("Save the shard's unit builds")?.with?.key).toBe(`zerops-units-${MATRIX_SHARD}-\${{ github.sha }}`);
    expect(step("Upload the shard's unit builds")?.with?.name).toBe(`zerops-units-${MATRIX_SHARD}`);
    // The app deploy unpacks every shard's archive, whatever the shard count.
    expect(source).toContain('pattern: zerops-units-*');
  }).pipe(Effect.provide(NodeServices.layer)),
);
