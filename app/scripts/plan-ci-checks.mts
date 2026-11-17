import { Console, Config, Effect, FileSystem, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { planCiChecks, withCiTopologyDependencies } from './ci-impact.mts';
import type { CiWorkspacePackage } from './ci-impact.mts';
import { runQualityCli } from './quality-cli-lifecycle.mts';

const CommandEntrySchema = Schema.Struct({
  commands: Schema.String,
  fetch_depth: Schema.optionalKey(Schema.Number),
  name: Schema.String,
  'node-artifacts': Schema.optionalKey(Schema.Boolean),
  'typescript-build': Schema.optionalKey(Schema.Boolean),
});
const IntegrationEntrySchema = Schema.Struct({
  lanes: Schema.optionalKey(Schema.Literals([2, 4])),
  name: Schema.String,
  'native-composition': Schema.optionalKey(Schema.Boolean),
  'native-preproposal': Schema.optionalKey(Schema.Boolean),
  'package-filters': Schema.optionalKey(Schema.String),
  'package-partition': Schema.optionalKey(Schema.String),
  'proof-packages': Schema.optionalKey(Schema.Array(Schema.String)),
  'root-rstest-shard': Schema.optionalKey(Schema.String),
  'root-suite': Schema.optionalKey(Schema.Boolean),
  'whole-owner-proofs': Schema.optionalKey(Schema.String),
  // The bootstrap row proves deployment and federation independently of package selection.
  suite: Schema.Literals(['bootstrap', 'integration', 'browser']),
}).check(
  Schema.makeFilter((entry) =>
    entry.suite === 'integration' &&
    entry['root-suite'] !== true &&
    (entry['package-filters'] === undefined || entry['package-filters'].length === 0)
      ? 'Integration templates must name package filters or run the root suite'
      : undefined,
  ),
  Schema.makeFilter((entry) =>
    entry['native-preproposal'] === true && (entry['proof-packages']?.length ?? 0) === 0
      ? 'Native preproposal templates must name their runtime proof packages'
      : undefined,
  ),
);
export const CiTemplatesSchema = Schema.Struct({
  integration: Schema.Array(IntegrationEntrySchema),
  source: Schema.Array(CommandEntrySchema),
  unit: Schema.Array(CommandEntrySchema),
});
export type Templates = typeof CiTemplatesSchema.Type;
export type IntegrationEntry = typeof IntegrationEntrySchema.Type;

const CiTopologyUnitSchema = Schema.Struct({
  id: Schema.String,
  moduleFederation: Schema.optionalKey(
    Schema.Struct({
      remotes: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
      verticalRefs: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  package: Schema.String,
  path: Schema.String,
  verticalRefs: Schema.optionalKey(Schema.Array(Schema.String)),
});
export const CiTopologySchema = Schema.Struct({
  shell: CiTopologyUnitSchema,
  verticals: Schema.Array(CiTopologyUnitSchema),
});

export {
  filterPaths,
  matchingPackages,
  planCiChecks,
  unknownFilters,
  withCiTopologyDependencies,
} from './ci-impact.mts';

const ManifestSchema = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  name: Schema.String,
  ontosContractOwner: Schema.optionalKey(Schema.Struct({ packageName: Schema.String })),
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const readWorkspace = Effect.gen(function* readCiWorkspace() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const app = yield* path.fromFileUrl(new URL('..', import.meta.url));
  const directories = ['.'];
  for (const area of ['apps', 'packages', 'verticals']) {
    const entries = yield* fs.readDirectory(path.join(app, area));
    for (const entry of entries) {
      if (yield* fs.exists(path.join(app, area, entry, 'package.json'))) {
        directories.push(`${area}/${entry}`);
      }
    }
  }
  const manifests = yield* Effect.forEach(
    directories,
    (directory) =>
      fs.readFileString(path.join(app, directory, 'package.json')).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ManifestSchema))),
        Effect.map((manifest) => ({ directory, manifest })),
      ),
    { concurrency: 4 },
  );
  const names = new Set(manifests.map(({ manifest }) => manifest.name));
  const ownership = yield* fs.readFileString(path.join(app, 'topology/ownership.json')).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            owners: Schema.Array(Schema.Struct({ package: Schema.String, path: Schema.String })),
          }),
        ),
      ),
    ),
  );
  const topology = yield* fs
    .readFileString(path.join(app, 'topology/reference-topology.json'))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CiTopologySchema))));
  return withCiTopologyDependencies(
    manifests.map(({ directory, manifest }): CiWorkspacePackage => ({
      contractProducer: manifest.ontosContractOwner?.packageName,
      dependencies: [
        ...new Set(
          [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies]
            .flatMap((group) => Object.entries(group ?? {}))
            .filter(
              ([name, version]) => names.has(name) || name.startsWith('@app/') || version.startsWith('workspace:'),
            )
            .map(([name]) => name),
        ),
      ],
      directory,
      name: manifest.name,
      uncertain:
        (directory !== '.' &&
          !ownership.owners.some((owner) => owner.package === manifest.name && owner.path === directory)) ||
        [
          manifest.dependencies,
          manifest.devDependencies,
          manifest.optionalDependencies,
          manifest.peerDependencies,
        ].some((group) =>
          Object.values(group ?? {}).some((version) => /^(?:file:|link:|workspace:(?:[./]|.*[:/]))/u.test(version)),
        ),
    })),
    topology,
  );
});

const cli = Command.make(
  'plan-ci-checks',
  {
    forceFull: Flag.Boolean('full').pipe(Flag.withDefault(false)),
    pathsFile: Flag.String('paths-file'),
  },
  ({ forceFull, pathsFile }) =>
    Effect.gen(function* writeCiPlan() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const app = yield* path.fromFileUrl(new URL('..', import.meta.url));
      const templates = yield* fs
        .readFileString(path.join(app, 'scripts/ci-matrices.json'))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CiTemplatesSchema))));
      const paths = yield* fs.readFileString(pathsFile);
      const packages = yield* readWorkspace.pipe(
        Effect.tapError((error) =>
          Console.log(`Workspace impact is unavailable: ${String(error)}. Running the complete suite.`),
        ),
        Effect.orElseSucceed((): readonly CiWorkspacePackage[] => []),
      );
      const plan = planCiChecks({
        changedPaths: paths.split('\0').filter(Boolean),
        forceFull,
        packages,
        templates,
      });
      const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
      const encoded = yield* Effect.all({
        expected: encode(plan.expected),
        integration: encode(plan.integration),
        source: encode(plan.source),
        unit: encode(plan.unit),
      });
      const output = yield* Config.String('GITHUB_OUTPUT');
      const outputLines = Object.entries(encoded).map(([key, value]) => `${key}=${value}`);
      yield* fs.writeFileString(output, `mode=${plan.mode}\n${outputLines.join('\n')}\n`, { flag: 'a' });
      const summary = yield* Config.String('GITHUB_STEP_SUMMARY');
      yield* fs.writeFileString(
        summary,
        [
          '## CI selection',
          '',
          plan.reason,
          '',
          `Affected packages: ${plan.affectedPackages.join(', ') || 'full/unknown'}.`,
          `Required integration shards: ${plan.integration.length} of ${templates.integration.length}.`,
          `Required unit shards: ${plan.unit.length} of ${templates.unit.length}.`,
          '',
          'Node artifact proof, static policy, compiler diagnostics and lint enforcement remain blocking.',
          '',
        ].join('\n'),
        { flag: 'a' },
      );
      yield* Console.log(plan.reason);
    }),
);

if (Schema.is(Schema.Struct({ main: Schema.Literal(true) }))(import.meta)) {
  runQualityCli(Command.run(cli, { version: '1.0.0' }));
}
