import { Array as EffectArray, Console, Config, Effect, FileSystem, Order, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { runQualityCli } from './quality-cli-lifecycle.mts';
import { workspaceConsumerClosure } from './workspace-consumer-closure.mts';

const CommandEntrySchema = Schema.Struct({
  'artifact-units': Schema.optionalKey(Schema.String),
  commands: Schema.String,
  fetch_depth: Schema.optionalKey(Schema.Number),
  name: Schema.String,
  'node-artifacts': Schema.optionalKey(Schema.Boolean),
  'typescript-build': Schema.optionalKey(Schema.Boolean),
});
const IntegrationEntrySchema = Schema.Struct({
  'artifact-units': Schema.optionalKey(Schema.String),
  name: Schema.String,
  'native-composition': Schema.optionalKey(Schema.Boolean),
  'native-preproposal': Schema.optionalKey(Schema.Boolean),
  'package-filters': Schema.optionalKey(Schema.String),
  'proof-packages': Schema.optionalKey(Schema.Array(Schema.String)),
  'root-rstest-shard': Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d+\/\d+$/u))),
  'root-suite': Schema.optionalKey(Schema.Boolean),
  'rstest-shard': Schema.optionalKey(Schema.String),
  /** Rstest file workers; 2 only for suites reviewed safe in parallel (unique template databases, UUID tenants). */
  'rstest-workers': Schema.optionalKey(Schema.Literals([1, 2])),
  suite: Schema.Literals(['integration', 'browser']),
}).check(
  Schema.makeFilter((entry) =>
    entry.suite === 'integration' &&
    entry['root-suite'] !== true &&
    entry['native-preproposal'] !== true &&
    (entry['package-filters'] === undefined || entry['package-filters'].length === 0)
      ? 'Integration templates must name package filters, run the root suite or run the native preproposal proof'
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
  /** Measured seconds of a test-file family by file-name prefix; scripts/ci/rstest-weighted-shard.sh deals by it. */
  'test-weights': Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  unit: Schema.Array(CommandEntrySchema),
});
type Templates = typeof CiTemplatesSchema.Type;
type IntegrationEntry = typeof IntegrationEntrySchema.Type;

export interface CiWorkspacePackage {
  readonly contractProducer?: string;
  readonly dependencies: readonly string[];
  readonly directory: string;
  readonly name: string;
  readonly uncertain?: boolean;
}

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

/** Runtime federation references are consumer edges even when package manifests omit them. */
export const withCiTopologyDependencies = (
  packages: readonly CiWorkspacePackage[],
  topology: typeof CiTopologySchema.Type,
): readonly CiWorkspacePackage[] => {
  const units = [topology.shell, ...topology.verticals];
  const invalid =
    new Set(units.map(({ id }) => id)).size !== units.length ||
    new Set(units.map((unit) => unit.package)).size !== units.length ||
    units.some((unit) => !packages.some((entry) => entry.name === unit.package && entry.directory === unit.path));
  return packages.map((entry) => {
    const unit = units.find((candidate) => candidate.package === entry.name);
    const references = [
      ...(unit?.verticalRefs ?? []),
      ...(unit?.moduleFederation?.verticalRefs ?? []),
      ...(unit?.moduleFederation?.remotes ?? []).map(({ id }) => id),
    ];
    return {
      ...entry,
      dependencies: [
        ...new Set([
          ...entry.dependencies,
          ...references.flatMap((id) =>
            units.filter((candidate) => candidate.id === id).map((candidate) => candidate.package),
          ),
        ]),
      ],
      uncertain:
        entry.uncertain === true || invalid || references.some((id) => !units.some((candidate) => candidate.id === id)),
    };
  });
};

const gateIds = [
  'workspace-gate',
  'workspace-unit',
  'workspace-unit-artifacts',
  'static-contracts',
  'format-and-lint',
  'service-integration',
  'browser-integration',
  'node-artifact-build',
  'node-artifact-proof',
] as const;

const rootDocumentation = (changedPath: string) =>
  changedPath.startsWith('docs/') || ['CONTEXT-MAP.md', 'README.md', 'AGENTS.md'].includes(changedPath);

const broadPath = (changedPath: string) =>
  !rootDocumentation(changedPath) &&
  (!/^app\/(?:apps|verticals|packages)\/[a-z0-9-]+\//u.test(changedPath) ||
    /^app\/packages\/(?:core-runtime|shared-contracts|shared-design-tokens|gateway-principal-verifier|better-auth-effect-drizzle)\//u.test(
      changedPath,
    ) ||
    /\/(?:package\.json|schema\.ts|[^/]*config\.[^/]+|vertical\.manifest\.ts|vertical\.registration\.ts)$/u.test(
      changedPath,
    ) ||
    /\/[^/]*(?:auth|permission|policy|grant)[^/]*\.[cm]?[jt]sx?$/iu.test(changedPath) ||
    /\/(?:drizzle[^/]*|database|db|auth|authorization|permissions|policies|migrations|shared|api)\//u.test(
      changedPath,
    ));

const filterPaths = (filters: string) =>
  [...filters.matchAll(/--filter\s+['"]?(?<exclude>!)?(?<path>\.\/[a-z0-9/-]+|\.)['"]?/gu)].map(({ groups }) => ({
    exclude: groups?.exclude === '!',
    path: groups?.path?.replace(/^\.\//u, ''),
  }));

const unknownFilters = (command: string) =>
  command.includes('--filter=') ||
  [...command.matchAll(/--filter\s+(?<selector>\S+)/gu)].some(
    ({ groups }) => !/^['"]?!?(?:\.\/[a-z0-9/-]+|\.)['"]?$/u.test(groups?.selector ?? ''),
  );

const matchingPackages = (filters: string, packages: readonly CiWorkspacePackage[]) => {
  const selectors = filterPaths(filters);
  const included = selectors.filter(({ exclude }) => !exclude);
  const excluded = selectors.filter(({ exclude }) => exclude);
  return packages.filter(
    ({ directory }) =>
      directory !== '.' &&
      (included.length === 0 || included.some((selector) => selector.path === directory)) &&
      !excluded.some((selector) => selector.path === directory),
  );
};

export const planCiChecks = (input: {
  readonly applyAffected: boolean;
  readonly changedPaths: readonly string[];
  readonly forceFull?: boolean;
  readonly packages: readonly CiWorkspacePackage[];
  readonly templates: Templates;
}) => {
  const { packages, templates } = input;
  const seeds = input.changedPaths.flatMap((changedPath) =>
    packages
      .filter(({ directory }) => directory !== '.' && changedPath.startsWith(`app/${directory}/`))
      .map(({ name }) => name),
  );
  const affectedNames = workspaceConsumerClosure(packages, seeds);
  const affected = packages.filter(({ name }) => affectedNames.has(name));
  const affectedPackages = EffectArray.sort([...affectedNames], Order.String);
  const uncertain = packages.some(
    (entry) =>
      entry.uncertain === true ||
      (entry.directory !== '.' && !/^(?:apps|packages|verticals)\/[a-z0-9-]+$/u.test(entry.directory)) ||
      !/^(?:@app\/[a-z0-9-]+|app)$/u.test(entry.name) ||
      entry.dependencies.some((dependency) => !packages.some(({ name }) => name === dependency)) ||
      (entry.contractProducer !== undefined && !packages.some(({ name }) => name === entry.contractProducer)),
  );
  const broad =
    input.forceFull === true ||
    uncertain ||
    templates.unit.some(({ commands }) => unknownFilters(commands)) ||
    templates.integration.some(
      (entry) =>
        unknownFilters(entry['package-filters'] ?? '') ||
        (entry['proof-packages'] ?? []).some((dependency) => !packages.some(({ name }) => name === dependency)),
    ) ||
    new Set(packages.map(({ name }) => name)).size !== packages.length ||
    input.changedPaths.length === 0 ||
    input.changedPaths.some(broadPath) ||
    seeds.length === 0 ||
    input.changedPaths.some(
      (changedPath) =>
        !rootDocumentation(changedPath) &&
        !packages.some(({ directory }) => directory !== '.' && changedPath.startsWith(`app/${directory}/`)),
    );
  const mode = !broad && input.applyAffected ? 'affected' : 'full';
  const selectedIntegration = templates.integration.flatMap((entry): readonly IntegrationEntry[] => {
    if (entry.suite === 'browser') {
      return affected.some(({ directory }) => directory === 'apps/shell-super-app') ? [entry] : [];
    }
    const packageFilters = entry['package-filters'] ?? '';
    const selected = packageFilters.length === 0 ? [] : matchingPackages(packageFilters, affected);
    const rootSuite = entry['root-suite'] === true && affected.some(({ directory }) => directory === '.');
    const proofAffected = entry['proof-packages']?.some((name) => affectedNames.has(name)) === true;
    if (selected.length === 0 && !rootSuite && !proofAffected) {
      return [];
    }
    const filters = selected.length === 0 ? '' : selected.map(({ directory }) => `--filter ./${directory}`).join(' ');
    return [{ ...entry, 'package-filters': filters, 'root-suite': rootSuite }];
  });
  const selectedUnit = templates.unit.flatMap((entry) => {
    const filters = entry.commands.split('\n')[0] ?? '';
    const selected = matchingPackages(filters, affected);
    if (selected.length === 0) {
      return [];
    }
    // A row whose every package is affected runs exactly as planned, including a weighted shard of one package.
    if (selected.length === matchingPackages(filters, packages).length) {
      return [entry];
    }
    const selectedFilters = selected.map(({ directory }) => `--filter ./${directory}`).join(' ');
    return [
      {
        ...entry,
        commands: ['test:unit', 'test:component']
          .map((script) => `pnpm -r --no-sort --if-present ${selectedFilters} run ${script}`)
          .join('\n'),
      },
    ];
  });
  // A malformed/empty unit mapping never becomes a green no-op.
  const effectiveMode = mode === 'affected' && selectedUnit.length > 0 ? mode : 'full';
  const integration = effectiveMode === 'full' ? templates.integration : selectedIntegration;
  const unit = effectiveMode === 'full' ? templates.unit : selectedUnit;
  // Each matrix job gets only its own rows: artifact consumers wait for the build shards, every other row starts
  // right after planning. A matrix job with no row is planned as skipped instead of failing on an empty matrix.
  const jobs = {
    browser: integration.filter(({ suite }) => suite === 'browser'),
    services: integration.filter(({ suite }) => suite === 'integration'),
    unitArtifacts: unit.filter((entry) => entry['node-artifacts'] === true),
    unitPlain: unit.filter((entry) => entry['node-artifacts'] !== true),
  };
  const rows = (gate: (typeof gateIds)[number]) => {
    switch (gate) {
      case 'browser-integration': {
        return jobs.browser.length;
      }
      case 'service-integration': {
        return jobs.services.length;
      }
      case 'workspace-unit': {
        return jobs.unitPlain.length;
      }
      case 'workspace-unit-artifacts': {
        return jobs.unitArtifacts.length;
      }
      default: {
        return 1;
      }
    }
  };
  const expected = Object.fromEntries(gateIds.map((gate) => [gate, rows(gate) === 0 ? 'skipped' : 'success']));
  let reason = 'Shared, sensitive, unknown or explicitly full impact requires the complete suite.';
  if (!broad && (effectiveMode === 'affected' || !input.applyAffected)) {
    reason = input.applyAffected
      ? 'Required tests include the changed owners and their transitive consumers.'
      : 'Affected selection is recorded in shadow mode; the complete suite remains required.';
  }
  return {
    affectedPackages,
    candidateIntegration: broad ? templates.integration : selectedIntegration,
    expected,
    integration,
    jobs,
    mode: effectiveMode,
    reason,
    source: templates.source,
    unit,
  };
};

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
    applyAffected: Flag.Boolean('apply-affected').pipe(Flag.withDefault(false)),
    forceFull: Flag.Boolean('full').pipe(Flag.withDefault(false)),
    pathsFile: Flag.String('paths-file'),
  },
  ({ applyAffected, forceFull, pathsFile }) =>
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
        applyAffected,
        changedPaths: paths.split('\0').filter(Boolean),
        forceFull,
        packages,
        templates,
      });
      const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
      const encoded = yield* Effect.all({
        browser: encode(plan.jobs.browser),
        expected: encode(plan.expected),
        integration: encode(plan.jobs.services),
        source: encode(plan.source),
        unit: encode(plan.jobs.unitPlain),
        'unit-artifacts': encode(plan.jobs.unitArtifacts),
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
          `Affected-plan integration shards: ${plan.candidateIntegration.map(({ name }) => name).join(', ') || 'none'}.`,
          '',
          'Node artifact proof, static policy, compiler diagnostics and lint enforcement remain blocking.',
          'Set the CI_AFFECTED_ENABLED repository variable to true only after reviewing shadow plans.',
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
