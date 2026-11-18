import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

import { parseCiMatrices } from '../ci/ci-matrices.mts';

const root = path.resolve(import.meta.dirname, '../..');
const manifestPath = 'verticals/finance-billing/tests/fixtures/pohoda-xsd/version-2.sha256';
const scriptPath = 'scripts/provision-pohoda-xsd.sh';
const supportPath = 'verticals/finance-billing/tests/support/pohoda-xsd.ts';
const gatesWorkflowPath = '../.github/workflows/ultramodern-workspace-gates.yml';
const matricesPath = 'scripts/ci-matrices.json';
const overlayPath = 'scripts/ci-matrices.demo.json';
const financeShard = 'Unit and Component Tests (every other package)';
const setupStep = "Run the row's package setup";
const sourceBase = 'https://www.stormware.cz/schema/version_2';
/** The workspace cache both the provisioning script and the tests resolve to. */
const cacheDirectory = 'node_modules/.cache/pohoda-xsd/version_2';

const PinSchema = Schema.Struct({ checksum: Schema.String, name: Schema.String });

const pinsOf = (manifest: string): readonly (typeof PinSchema.Type)[] =>
  manifest
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [checksum = '', name = ''] = line.split(/\s+/u);
      return { checksum, name };
    });

const StepSchema = Schema.Struct({
  if: Schema.optional(Schema.String),
  // A grouped or reusable step may legitimately carry no name.
  name: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
});
const WorkflowSchema = Schema.Struct({
  jobs: Schema.Record(Schema.String, Schema.Struct({ steps: Schema.Array(StepSchema) })),
});

it.effect('pins every STORMWARE dataPack 2.0 schema the POHODA export tests validate against', () =>
  Effect.gen(function* checkPins() {
    const fs = yield* FileSystem.FileSystem;
    const pins = pinsOf(yield* fs.readFileString(path.join(root, manifestPath)));
    // data.xsd plus its transitive xs:import closure; a shrunken manifest would drop a schema the
    // validator needs and the export tests would fail to compile the schema.
    expect(pins.length).toBeGreaterThanOrEqual(70);
    expect(pins.every(({ checksum }) => /^[a-f0-9]{64}$/u.test(checksum))).toBe(true);
    expect(new Set(pins.map(({ name }) => name)).size).toBe(pins.length);
    expect(pins.map(({ name }) => name)).toContain('data.xsd');
    expect(pins.map(({ name }) => name)).toContain('type.xsd');
    expect(pins.map(({ name }) => name)).toContain('invoice.xsd');
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('downloads and verifies those pins into the cache the tests read, and never skips', () =>
  Effect.gen(function* provisioning() {
    const fs = yield* FileSystem.FileSystem;
    const script = yield* fs.readFileString(path.join(root, scriptPath));
    expect(script).toContain(sourceBase);
    expect(script).toContain('version-2.sha256');
    expect(script).toContain(cacheDirectory);
    // Every download is checked against its pin before it is used, and a mismatch aborts.
    expect(script).toContain('sha256sum');
    expect(script).toContain("--proto '=https'");
    expect(script).toContain('did not match its pinned SHA-256');
    const support = yield* fs.readFileString(path.join(root, supportPath));
    expect(support).toContain(cacheDirectory);
    expect(support).toContain('provision:pohoda-xsd');
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('provisions the pinned schemas in the shard that runs the finance-billing tests', () =>
  Effect.gen(function* checkWorkflow() {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(path.join(root, gatesWorkflowPath));
    const workflow = Schema.decodeUnknownSync(WorkflowSchema)(parse(source));
    const steps = workflow.jobs['workspace-unit']?.steps ?? [];
    // Every unit row runs its own `setup` before its tests; the finance-billing row's provisions the pinned schemas.
    const step = steps.find(({ name }) => name === setupStep);
    expect(step?.if).toBe('matrix.setup');
    expect(step?.run).toBe('bash -eo pipefail -c "$SETUP"');
    // The row that carries it is the matrix entry that runs finance-billing's unit tests, so the pinned schemas
    // reach the tests that compile them instead of a shard that never runs them.
    const matrices = yield* Effect.fromResult(
      parseCiMatrices(
        yield* fs.readFileString(path.join(root, matricesPath)),
        yield* fs.readFileString(path.join(root, overlayPath)),
      ),
    );
    const shard = matrices.unit.find(({ name }) => name === financeShard);
    expect(shard, financeShard).toBeDefined();
    expect(shard?.setup).toContain('mise exec -- pnpm provision:pohoda-xsd');
    expect(shard?.setup).toContain('xmllint');
    expect(matrices.unit.filter(({ setup }) => setup?.includes('provision:pohoda-xsd') === true)).toHaveLength(1);
    const commands = shard?.commands ?? '';
    expect(commands, financeShard).toContain('run test:unit');
    for (const filter of commands.matchAll(/--filter\s+'(?<value>[^']+)'/gu)) {
      const value = filter.groups?.value ?? '';
      // Every filter is an exclusion, so a shard that never names finance-billing still runs its tests; a
      // positive filter list would silently drop them while the step still looked provisioned.
      expect(value.startsWith('!'), `${financeShard} filter ${value}`).toBe(true);
      expect(value, financeShard).not.toContain('finance-billing');
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
