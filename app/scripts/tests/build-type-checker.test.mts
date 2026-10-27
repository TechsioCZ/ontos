import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { loadModernConfigEvidence } from './modern-config-evidence-fixture.mts';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

const modernConfigs = ['apps', 'verticals'].flatMap((group) =>
  readdirSync(path.join(workspaceRoot, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${group}/${entry.name}/modern.config.ts`)
    .filter((config) => readdirSync(path.join(workspaceRoot, path.dirname(config))).includes('modern.config.ts')),
);

it.live(
  'no application build re-runs the TypeScript checker that pnpm typecheck owns',
  Effect.fn(function* testEffect() {
    expect(modernConfigs.length).toBeGreaterThan(0);
    const switches = yield* loadModernConfigEvidence(modernConfigs, 'build').pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
    expect(new Set(Object.keys(switches))).toEqual(new Set(modernConfigs));
    for (const [config, evidence] of Object.entries(switches)) {
      expect(evidence.disableTsChecker, `${config} must set output.disableTsChecker: true`).toBe(true);
    }
  }),
);
