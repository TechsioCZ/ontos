import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '../..');
const manifestPath = 'verticals/finance-billing/tests/fixtures/pohoda-xsd/version-2.sha256';
const scriptPath = 'scripts/provision-pohoda-xsd.sh';
const supportPath = 'verticals/finance-billing/tests/support/pohoda-xsd.ts';
const gatesWorkflowPath = '../.github/workflows/ultramodern-workspace-gates.yml';
const financeShard = 'Unit and Component Tests (every other package)';
const provisionStep = 'Provision the POHODA XML schemas for the finance-billing shard';
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
  name: Schema.String,
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
    const steps = workflow.jobs['workspace-gate']?.steps ?? [];
    const step = steps.find(({ name }) => name === provisionStep);
    expect(step?.if).toBe(`matrix.name == '${financeShard}'`);
    expect(step?.run).toContain('mise exec -- pnpm provision:pohoda-xsd');
    expect(step?.run).toContain('xmllint');
  }).pipe(Effect.provide(NodeServices.layer)),
);
