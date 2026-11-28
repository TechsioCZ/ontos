import { deepStrictEqual, equal } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { Schema } from 'effect';

const read = (name: string) => readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf-8');
const branches = Schema.Struct({ branches: Schema.Array(Schema.String) });

await test('demo pushes deploy directly while main retains its engineering gates', () => {
  const gates = Schema.decodeUnknownSync(
    Schema.Struct({
      on: Schema.Struct({
        merge_group: Schema.Struct({ types: Schema.Array(Schema.String) }),
        pull_request: branches,
        push: branches,
      }),
    }),
  )(parse(read('ultramodern-workspace-gates.yml')));
  const stage = Schema.decodeUnknownSync(
    Schema.Struct({
      on: Schema.Struct({ push: branches }),
    }),
  )(parse(read('zerops-stage.yml')));
  deepStrictEqual(gates.on.push.branches, ['main']);
  deepStrictEqual(gates.on.pull_request.branches, ['main']);
  deepStrictEqual(gates.on.merge_group.types, ['checks_requested']);
  deepStrictEqual(stage.on.push.branches, ['demo/sales-crm']);
});

await test('all eight build shards can finish and deployment still requires their success', () => {
  const stage = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Struct({
        build: Schema.Struct({
          strategy: Schema.Struct({
            'fail-fast': Schema.Boolean,
            matrix: Schema.Struct({ shard: Schema.Array(Schema.Int) }),
          }),
        }),
        deliver_app: Schema.Struct({ needs: Schema.Array(Schema.String) }),
      }),
    }),
  )(parse(read('zerops-stage.yml')));
  equal(stage.jobs.build.strategy['fail-fast'], false);
  deepStrictEqual(stage.jobs.build.strategy.matrix.shard, [0, 1, 2, 3, 4, 5, 6, 7]);
  deepStrictEqual(stage.jobs.deliver_app.needs, ['deliver', 'build', 'lint']);
});
