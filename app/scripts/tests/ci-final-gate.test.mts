import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { Config, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

const WorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    'workspace-gates': Schema.Struct({
      if: Schema.String,
      steps: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          run: Schema.optional(Schema.String),
        }),
      ),
    }),
  }),
});

it.effect('rejects failed or cancelled prerequisites before preparing the final gate verifier', () =>
  Effect.gen(function* finalGate() {
    const searchPath = yield* Config.String('PATH');
    const source = readFileSync(
      new URL('../../../.github/workflows/ultramodern-workspace-gates.yml', import.meta.url),
      'utf-8',
    );
    const gate = Schema.decodeUnknownSync(WorkflowSchema)(parse(source)).jobs['workspace-gates'];
    expect(gate.if).toBe(`\${{ always() }}`);
    const reject = gate.steps.findIndex(({ name }) => name === 'Reject failed or cancelled prerequisites');
    const checkout = gate.steps.findIndex(({ name }) => name === 'Checkout the gate verifier');
    expect(reject).toBeGreaterThanOrEqual(0);
    expect(reject).toBeLessThan(checkout);
    const command = gate.steps[reject]?.run ?? 'exit 99';
    for (const result of ['success', 'skipped', 'failure', 'cancelled']) {
      const child = spawnSync('/bin/bash', ['-eo', 'pipefail', '-c', command], {
        env: { NEEDS_JSON: JSON.stringify({ check: { result } }), PATH: searchPath },
      });
      expect(child.status === 0, result).toBe(result === 'success' || result === 'skipped');
    }
  }),
);
