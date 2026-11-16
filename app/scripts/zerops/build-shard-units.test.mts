import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

import {
  buildShardUnits,
  MODULE_BUILD_SECONDS,
  moduleSeconds,
  readReleaseModules,
  SHELL_SHARD,
} from './build-shard-units.mts';
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
  }).pipe(Effect.provide(NodeServices.layer)),
);

const NEW_MODULE = 'new-module';
const shardSeconds = (units: readonly string[]) => units.reduce((total, unit) => total + moduleSeconds(unit), 0);

it.effect('balances the module shards by measured build seconds, not by count', () =>
  Effect.gen(function* balancedShards() {
    const modules = yield* readReleaseModules;
    const shards = (yield* readBuildJob).job.env.SHARDS;
    const loads = buildShardUnits(modules, shards).slice(1).map(shardSeconds);
    const longest = Math.max(...modules.map(moduleSeconds));
    // Longest-first dealing ends every shard within one module's build of the others.
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(longest);
    // Run 43764570181 dealt by count: its slowest module shard summed 487 s of builds.
    expect(Math.max(...loads)).toBeLessThan(400);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('measures only released modules, and a new module moves no other', () =>
  Effect.gen(function* stableShards() {
    const modules = yield* readReleaseModules;
    const shards = (yield* readBuildJob).job.env.SHARDS;
    for (const measured of MODULE_BUILD_SECONDS.keys()) {
      expect(modules, measured).toContain(measured);
    }
    const before = buildShardUnits(modules, shards);
    const after = buildShardUnits([...modules.slice(0, 3), NEW_MODULE, ...modules.slice(3)], shards);
    for (const [shard, units] of before.entries()) {
      expect(after[shard]?.filter((unit) => unit !== NEW_MODULE)).toEqual(units);
    }
    expect(after.flat()).toContain(NEW_MODULE);
    expect(buildShardUnits(modules, shards)).toEqual(before);
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
    // Named by the shard's unit identities, never by commit (cache-budget.test.mts runs the naming step).
    expect(step("Restore the shard's unit builds")?.with?.key).toBe(
      `\${{ steps.unit-cache-key.outputs.key || format('zerops-units-v2-{0}-unnamed', matrix.shard) }}`,
    );
    expect(step("Restore the shard's unit builds")?.with?.['restore-keys']).toBe(`zerops-units-v2-${MATRIX_SHARD}-`);
    expect(step("Save the shard's unit builds")?.with?.key).toBe(`\${{ steps.unit-cache-key.outputs.key }}`);
    expect(step("Upload the shard's unit builds")?.with?.name).toBe(`zerops-units-${MATRIX_SHARD}`);
    // The app deploy unpacks every shard's archive, whatever the shard count.
    expect(source).toContain('pattern: zerops-units-*');
  }).pipe(Effect.provide(NodeServices.layer)),
);
