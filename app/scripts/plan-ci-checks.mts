import { Array as EffectArray, Console, Config, Effect, FileSystem, Order, Path, Predicate, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { parse } from 'yaml';

import { knownTask, loadCiMatrices, taskDirectory } from './ci/ci-matrices.mts';
import type { CiIntegrationEntry, CiScope, CiTemplates } from './ci/ci-matrices.mts';
import { runQualityCli } from './quality-cli-lifecycle.mts';
import { workspaceConsumerClosure } from './workspace-consumer-closure.mts';

export { CiTemplatesSchema } from './ci/ci-matrices.mts';
export type { CiScope } from './ci/ci-matrices.mts';
type Templates = CiTemplates;
type IntegrationEntry = CiIntegrationEntry;

export interface CiWorkspacePackage {
  readonly contractProducer?: string;
  readonly dependencies: readonly string[];
  readonly directory: string;
  /** Package-relative files the manifest's `exports` map points at: what other packages consume from it. */
  readonly exportTargets?: readonly string[];
  readonly name: string;
  readonly uncertain?: boolean;
}

/**
 * The root-level packages the matrices account for (`root-packages`). They are leaves no workspace package depends on,
 * and not OntOS modules, so `topology/ownership.json` does not name them; their own gate is a source row of the
 * matrices.
 */
const rootPackagesOf = (templates: Templates): readonly string[] => templates['root-packages'] ?? [];

/**
 * Trees the workspace root package (`directory: '.'`) owns for selection. pnpm's root package has no directory
 * prefix, so the trees whose change only its own suites prove are named here: the repository tooling under
 * `app/scripts` is proved by the Repository Tooling Tests source rows and the Root Integration shards. Everything
 * else under `app/` outside a package directory stays unowned and runs the complete suite, `.github/**` included.
 */
const rootOwnedTrees: readonly string[] = ['scripts/'];

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
  'node-artifact-build',
] as const;

const rootDocumentation = (changedPath: string) =>
  changedPath.startsWith('docs/') || ['CONTEXT-MAP.md', 'README.md', 'AGENTS.md'].includes(changedPath);

/** A path inside a tree some workspace package owns: a package directory, a root-level package or a root tree. */
const ownedTree = (changedPath: string, rootPackages: readonly string[]) =>
  /^app\/(?:apps|verticals|packages)\/[a-z0-9-]+\//u.test(changedPath) ||
  rootPackages.some((directory) => changedPath.startsWith(`app/${directory}/`)) ||
  rootOwnedTrees.some((tree) => changedPath.startsWith(`app/${tree}`));

/** The packages a changed path belongs to; the root package owns its named trees, never the whole repository. */
const pathOwners = (changedPath: string, packages: readonly CiWorkspacePackage[]) =>
  packages.filter(({ directory }) =>
    directory === '.'
      ? rootOwnedTrees.some((tree) => changedPath.startsWith(`app/${tree}`))
      : changedPath.startsWith(`app/${directory}/`),
  );

/** A shared package, a manifest or configuration, or an authority or database file: no scope or owner narrows it. */
const sensitivePath = (changedPath: string) =>
  /^app\/packages\/(?:core-runtime|shared-contracts|shared-design-tokens|gateway-principal-verifier|better-auth-effect-drizzle)\//u.test(
    changedPath,
  ) ||
  /\/(?:package\.json|schema\.ts|[^/]*config\.[^/]+|vertical\.manifest\.ts|vertical\.registration\.ts)$/u.test(
    changedPath,
  ) ||
  /\/[^/]*(?:auth|permission|policy|grant)[^/]*\.[cm]?[jt]sx?$/iu.test(changedPath) ||
  /\/(?:drizzle[^/]*|database|db|auth|authorization|permissions|policies|migrations|shared|api)\//u.test(changedPath);

const broadPath = (changedPath: string, rootPackages: readonly string[]) =>
  !rootDocumentation(changedPath) && (!ownedTree(changedPath, rootPackages) || sensitivePath(changedPath));

/** Every literal workspace selector a `--filter` list names, with its exclusion sense. */
export const filterPaths = (filters: string) =>
  [...filters.matchAll(/--filter\s+['"]?(?<exclude>!)?(?<path>\.\/[a-z0-9/-]+|\.)['"]?/gu)].map(({ groups }) => ({
    exclude: groups?.exclude === '!',
    path: groups?.path?.replace(/^\.\//u, ''),
  }));

/** True when a command carries a package selector this planner cannot resolve to a workspace directory. */
export const unknownFilters = (command: string) =>
  command.includes('--filter=') ||
  [...command.matchAll(/--filter\s+(?<selector>\S+)/gu)].some(
    ({ groups }) => !/^['"]?!?(?:\.\/[a-z0-9/-]+|\.)['"]?$/u.test(groups?.selector ?? ''),
  );

/** The workspace packages a `--filter` list selects, excluding the repository root. */
export const matchingPackages = (filters: string, packages: readonly CiWorkspacePackage[]) => {
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

/**
 * Whether a change reaches the package's consumers. Everything the broad-path rule does not already widen to the
 * complete suite and that is not part of the package's public surface (its runtime declaration, locales and the
 * files its `exports` map points at) is the package's own: only its own tests select it. The Shell and the root
 * suites consume every vertical through that surface, so a change confined to a vertical's internals no longer
 * selects them.
 */
const reachesConsumers = (changedPath: string, owner: CiWorkspacePackage) => {
  const relative = changedPath.slice(`app/${owner.directory}/`.length);
  return (
    owner.directory === '.' ||
    /^(?:vertical\.runtime-declaration\.[cm]?[jt]sx?|locales\/.*)$/u.test(relative) ||
    (owner.exportTargets ?? []).includes(relative)
  );
};

/** The glob dialect of `hashFiles`: `**` spans whole path segments, `*` stays inside one. */
const GLOBSTAR = '<<globstar>>';
const pathGlobMatcher = (glob: string) =>
  new RegExp(
    `^${glob
      .replaceAll('**', GLOBSTAR)
      .replaceAll(/[$()+.?[\\\]^{|}]/gu, String.raw`\$&`)
      .replaceAll('*', '[^/]*')
      .replaceAll(`/${GLOBSTAR}/`, '/(?:.*/)?')
      .replaceAll(`/${GLOBSTAR}`, '(?:/.*)?')
      .replaceAll(GLOBSTAR, '.*')}$`,
    'u',
  );

/**
 * What a migration, a database bootstrap or a recovery proves, and those proofs themselves: the migrations and their
 * runner, the database identities and grants, the access catalog, the service images, the lane scripts and matrices
 * that prepare every owner row's database, and every migration or recovery test. These are the inputs that selected the
 * demo trunk's former Fresh Database rows (app/scripts/tests/plan-ci-selection.test.mts); a change to one runs the
 * migration proof tasks below beside its owners.
 */
const migrationProofInputs = [
  'app/**/drizzle*/**',
  'app/**/drizzle*.config.ts',
  'app/database/**',
  'app/scripts/postgres/**',
  'app/scripts/run-zerops-migrator.mjs',
  'app/scripts/migration-convergence*',
  'app/scripts/access-release-activation*',
  'app/scripts/activate-access-catalog-release.mts',
  'app/scripts/application-migration-pending.mts',
  'app/verticals/commerce-customer-context/scripts/**',
  'app/scripts/run-optional-commerce-portal-auth-db.mts',
  'app/scripts/verify-application-db-schema.mts',
  'app/scripts/audit-database-trust-boundaries.mts',
  'app/scripts/prove-zerops-migrator-artifact.sh',
  'app/scripts/ci/*integration*',
  'app/scripts/ci-matrices*.json',
  'app/scripts/ci/ci-matrices.mts',
  'app/packages/core-runtime/spicedb/**',
  'app/topology/**',
  'app/docker-compose.yml',
  'app/zerops.yaml',
  'app/package.json',
  'app/pnpm-lock.yaml',
  'app/.mise.toml',
  'app/**/tests/integration/*migration*',
  'app/scripts/integration/*migration*',
  'app/**/*stage-recovery*',
  'app/scripts/integration/vat-deploy-sequence.test.mts',
  'app/scripts/integration/migrator-runtime-owner-access.test.mts',
];
const migrationProofExclusions = ['app/**/node_modules/**', 'app/tools/**'];
const migrationProofInput = (changedPath: string) =>
  migrationProofInputs.some((glob) => pathGlobMatcher(glob).test(changedPath)) &&
  !migrationProofExclusions.some((glob) => pathGlobMatcher(glob).test(changedPath));
/**
 * The tasks of scripts/ci/run-integration-suites.sh that run the migration and recovery proofs, each on a freshly reset
 * lane database, by their owner's directory. A migration proof input selects all of them; an owner selects its own.
 */
const migrationProofTasks = new Map([
  ['whole:migrator-owner-access', '.'],
  ['whole:stage-recovery', '.'],
  ['whole:vat-deploy-sequence', '.'],
  ['whole:core-runtime-migrations', 'packages/core-runtime'],
  ['whole:customer-context-migrations', 'verticals/commerce-customer-context'],
  ['whole:party-migrations', 'verticals/party-registry'],
]);

/** Whether a path is one of the scope's paths: some glob matches it and no `!` glob does. */
export const inScope = (scope: CiScope, changedPath: string) =>
  scope.paths.some((glob) => !glob.startsWith('!') && pathGlobMatcher(glob).test(changedPath)) &&
  !scope.paths.some((glob) => glob.startsWith('!') && pathGlobMatcher(glob.slice(1)).test(changedPath));

/**
 * The scopes a diff stays inside: every changed path that is not root documentation lies in one of them and none is
 * sensitive. Empty when any path is outside every scope, when a scope names a source row the matrices do not have,
 * or when nothing but documentation changed.
 */
const diffScopes = (changedPaths: readonly string[], templates: Templates): readonly CiScope[] => {
  const scopes = templates.scopes ?? [];
  const valid = scopes.every((scope) =>
    scope.source.every((name) => templates.source.some((entry) => entry.name === name)),
  );
  const paths = changedPaths.filter((changedPath) => !rootDocumentation(changedPath));
  if (
    !valid ||
    paths.length === 0 ||
    paths.some((changedPath) => sensitivePath(changedPath) || migrationProofInput(changedPath))
  ) {
    return [];
  }
  const owners = paths.map((changedPath) => scopes.filter((scope) => inScope(scope, changedPath)));
  return owners.some((matched) => matched.length === 0)
    ? []
    : scopes.filter((scope) => owners.some((matched) => matched.includes(scope)));
};

/**
 * Whether the workspace graph itself cannot be trusted: a package outside the directory and naming conventions, a
 * duplicate name, or a dependency or contract producer that is not in the workspace. Nothing is narrowed from a
 * graph with a hole in it.
 */
const unaccountedWorkspace = (packages: readonly CiWorkspacePackage[], rootPackages: readonly string[]) =>
  new Set(packages.map(({ name }) => name)).size !== packages.length ||
  packages.some(
    (entry) =>
      entry.uncertain === true ||
      (entry.directory !== '.' &&
        !/^(?:apps|packages|verticals)\/[a-z0-9-]+$/u.test(entry.directory) &&
        !rootPackages.includes(entry.directory)) ||
      (!/^(?:@app\/[a-z0-9-]+|app)$/u.test(entry.name) && !rootPackages.includes(entry.name)) ||
      entry.dependencies.some((dependency) => !packages.some(({ name }) => name === dependency)) ||
      (entry.contractProducer !== undefined && !packages.some(({ name }) => name === entry.contractProducer)),
  );

/** Whether the changed paths themselves demand the complete suite: empty, shared, sensitive or owned by nobody. */
const broadDiff = (
  changedPaths: readonly string[],
  packages: readonly CiWorkspacePackage[],
  rootPackages: readonly string[],
) =>
  changedPaths.length === 0 ||
  changedPaths.some((changedPath) => broadPath(changedPath, rootPackages)) ||
  changedPaths.some((changedPath) => !rootDocumentation(changedPath) && pathOwners(changedPath, packages).length === 0);

/**
 * Whether a matrix names a package selector, an integration task or a proof dependency this planner cannot resolve to
 * a package. A package task in a directory outside the workspace graph matches no affected package: it widens the plan
 * instead of vanishing from it.
 */
const unprovenTemplates = (templates: Templates, packages: readonly CiWorkspacePackage[]) =>
  templates.unit.some(({ commands }) => unknownFilters(commands)) ||
  templates.integration.some(
    (entry) =>
      (entry.tasks ?? []).some((task) => {
        const directory = taskDirectory(task);
        return (
          !knownTask(task) || (directory !== undefined && !packages.some((owner) => owner.directory === directory))
        );
      }) || (entry['proof-packages'] ?? []).some((dependency) => !packages.some(({ name }) => name === dependency)),
  );

interface PlanInput {
  readonly applyAffected: boolean;
  readonly changedPaths: readonly string[];
  readonly forceFull?: boolean;
  readonly packages: readonly CiWorkspacePackage[];
  readonly templates: Templates;
}
/** How much of the suite a plan runs: everything, the changed owners and their consumers, or the rows of scopes. */
const PlanModeSchema = Schema.Literals(['affected', 'full', 'scoped']);
type PlanMode = typeof PlanModeSchema.Type;

/**
 * The scopes a narrowed diff stays inside. A diff inside them runs their source rows and the unit rows of the packages
 * it changes; a unit row that reads build outputs needs the builds, so such a diff is not scoped.
 */
const selectedScopes = (input: PlanInput, narrowedUnit: readonly { readonly 'node-artifacts'?: boolean }[]) => {
  const trusted =
    input.applyAffected &&
    input.forceFull !== true &&
    !unaccountedWorkspace(input.packages, rootPackagesOf(input.templates)) &&
    !unprovenTemplates(input.templates, input.packages);
  return trusted && narrowedUnit.every((entry) => entry['node-artifacts'] !== true)
    ? diffScopes(input.changedPaths, input.templates)
    : [];
};

const planReason = (mode: PlanMode, input: PlanInput, broad: boolean, scopes: readonly CiScope[]) => {
  if (mode === 'scoped') {
    return `Every changed path is inside ${scopes.map(({ name }) => name).join(' and ')}: their rows, the static contracts, the lint of the changed files, the lint rule tests and the repository policy run; no unit is built and no service starts.`;
  }
  if (broad || (mode !== 'affected' && input.applyAffected)) {
    return 'Shared, sensitive, unknown or explicitly full impact requires the complete suite.';
  }
  return input.applyAffected
    ? 'Required tests include the changed owners and their transitive consumers.'
    : 'Affected selection is recorded in shadow mode; the complete suite remains required.';
};

/** The whole-owner tasks that run one root integration file (scripts/ci/run-integration-suites.sh). */
const rootWholeTasks = new Set([
  'whole:migrations',
  'whole:organization',
  'whole:organization-identity',
  'whole:customer-readback',
  'whole:customer-roundtrip',
  'whole:pricing-routes',
]);
/** The whole-owner tasks that run one file or project of a package's suite, by that package's directory. */
const packageWholeTasks = new Map([
  ['whole:party-worker', 'verticals/party-registry'],
  ['whole:pricing', 'verticals/pricing'],
  ['whole:privacy', 'verticals/privacy'],
  ['whole:privacy-recovery', 'verticals/privacy'],
]);

export const planCiChecks = (input: PlanInput) => {
  const { packages, templates } = input;
  const owned = input.changedPaths.flatMap((changedPath) =>
    pathOwners(changedPath, packages).map((owner) => ({
      consumed: reachesConsumers(changedPath, owner),
      name: owner.name,
    })),
  );
  const seeds = owned.map(({ name }) => name);
  const affectedNames = new Set([
    ...workspaceConsumerClosure(
      packages,
      owned.filter(({ consumed }) => consumed).map(({ name }) => name),
    ),
    ...seeds,
  ]);
  const affected = packages.filter(({ name }) => affectedNames.has(name));
  const affectedPackages = EffectArray.sort([...affectedNames], Order.String);
  const broad =
    input.forceFull === true ||
    unaccountedWorkspace(packages, rootPackagesOf(templates)) ||
    unprovenTemplates(templates, packages) ||
    broadDiff(input.changedPaths, packages, rootPackagesOf(templates)) ||
    seeds.length === 0;
  const mode = !broad && input.applyAffected ? 'affected' : 'full';
  const affectedDirectories = new Set(affected.map(({ directory }) => directory));
  const rootAffected = affectedDirectories.has('.');
  const migrationProofChanged = input.changedPaths.some(migrationProofInput);
  // Each task names its owner, so the task list alone decides what an affected plan keeps.
  const selectedIntegration = templates.integration.flatMap((entry): readonly IntegrationEntry[] => {
    // A row that is neither a package suite nor the browser suite proves the deployment bootstrap or the
    // build outputs themselves: it reads no matrix input and has nothing to narrow, so affected selection
    // always keeps it.
    if (entry.suite !== 'integration' && entry.suite !== 'browser') {
      return [entry];
    }
    if (entry.suite === 'browser') {
      return affectedDirectories.has('apps/shell-super-app') ? [entry] : [];
    }
    const proofAffected = entry['proof-packages']?.some((name) => affectedNames.has(name)) === true;
    // A whole-owner task runs one file of its owner's suite on its own; it follows that owner exactly as the file did
    // inside the suite: the root conformance proofs follow the root package, the others their package directory.
    const tasks = (entry.tasks ?? []).filter((task) => {
      const migrationProofOwner = migrationProofTasks.get(task);
      if (migrationProofOwner !== undefined) {
        return migrationProofChanged || affectedDirectories.has(migrationProofOwner);
      }
      if (task.startsWith('root:') || rootWholeTasks.has(task)) {
        return rootAffected;
      }
      if (task.startsWith('whole:preproposal-')) {
        return proofAffected;
      }
      const owner = packageWholeTasks.get(task) ?? taskDirectory(task);
      return owner !== undefined && affectedDirectories.has(owner);
    });
    return tasks.length > 0 ? [{ ...entry, tasks }] : [];
  });
  // A change only the root package owns is in no unit row: every row excludes the workspace root with
  // `--filter '!.'`, and `app/scripts/check-ci-gates.sh` requires the workspace unit gate to have run in an
  // affected plan. So the unit matrix stays complete for it and the integration matrix narrows to the root shards.
  const rootOnly = affected.length > 0 && affected.every(({ directory }) => directory === '.');
  const narrowedUnit = templates.unit.flatMap((entry) => {
    const filters = entry.commands.split('\n')[0] ?? '';
    const selected = matchingPackages(filters, affected);
    if (selected.length === 0) {
      return [];
    }
    // A row whose every package is affected runs exactly as planned, including a weighted shard of one package.
    if (selected.length === matchingPackages(filters, packages).length) {
      return [entry];
    }
    // Only the package list narrows: the row's own commands, scripts and worker flags run as authored.
    const selectedFilters = selected.map(({ directory }) => `--filter ./${directory}`).join(' ');
    return [{ ...entry, commands: entry.commands.replaceAll(/(?:--filter\s+\S+\s*)+/gu, `${selectedFilters} `) }];
  });
  const selectedUnit = rootOnly ? templates.unit : narrowedUnit;
  const scopes = selectedScopes(input, narrowedUnit);
  // A malformed/empty unit mapping never becomes a green no-op.
  let effectiveMode: PlanMode = mode === 'affected' && selectedUnit.length > 0 ? mode : 'full';
  if (scopes.length > 0) {
    effectiveMode = 'scoped';
  }
  const integration = { affected: selectedIntegration, full: templates.integration, scoped: [] }[effectiveMode];
  const unit = { affected: selectedUnit, full: templates.unit, scoped: narrowedUnit }[effectiveMode];
  const source =
    effectiveMode === 'scoped'
      ? templates.source.filter(({ name }) => scopes.some((scope) => scope.source.includes(name)))
      : templates.source;
  const built = effectiveMode === 'scoped' ? 0 : 1;
  // Each matrix job gets only its own rows: artifact consumers wait for the build shards, every other row starts
  // right after planning. A matrix job with no row is planned as skipped instead of failing on an empty matrix.
  // No job holds a runner while it waits for another: the database producer (service-integration) migrates, exports
  // and uploads this run's database whenever an owner row will restore it, and starts with the run like the build
  // shards; the owner rows need both, the bootstrap row needs the build shards, and the browser checks migrate their
  // own database and need nobody.
  const owners = integration.filter(({ suite }) => suite === 'integration');
  const jobs = {
    browser: integration.filter(({ suite }) => suite === 'browser'),
    database: owners.length === 0 ? [] : [{ name: 'Prepare integration database', suite: 'database' as const }],
    owners,
    topology: integration.filter(({ suite }) => suite === 'bootstrap'),
    unitArtifacts: unit.filter((entry) => entry['node-artifacts'] === true),
    unitPlain: unit.filter((entry) => entry['node-artifacts'] !== true),
  };
  // Every gate names its row count; gates without a matrix always run one row, except that a scoped plan builds no
  // unit. The owner rows, the bootstrap row and the browser checks report through the integration gate
  // (app/scripts/check-ci-gates.sh).
  const rows = {
    'format-and-lint': 3,
    'node-artifact-build': built,
    'service-integration': jobs.database.length,
    'static-contracts': 1,
    'workspace-gate': source.length,
    'workspace-unit': jobs.unitPlain.length,
    'workspace-unit-artifacts': jobs.unitArtifacts.length,
  } satisfies Readonly<Record<(typeof gateIds)[number], number>>;
  const expected = Object.fromEntries(gateIds.map((gate) => [gate, rows[gate] === 0 ? 'skipped' : 'success']));
  return {
    affectedPackages,
    candidateIntegration: broad ? templates.integration : selectedIntegration,
    expected,
    integration,
    jobs,
    mode: effectiveMode,
    reason: planReason(effectiveMode, input, broad, scopes),
    source,
    unit,
  };
};

/** A package `exports` target: a path, a condition map, or a fallback list of either. */
type ExportTarget = string | readonly ExportTarget[] | { readonly [condition: string]: ExportTarget };
const ExportTargetSchema: Schema.Codec<ExportTarget> = Schema.suspend(() =>
  Schema.Union([Schema.String, Schema.Array(ExportTargetSchema), Schema.Record(Schema.String, ExportTargetSchema)]),
);

const ManifestSchema = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  exports: Schema.optionalKey(ExportTargetSchema),
  name: Schema.String,
  ontosContractOwner: Schema.optionalKey(Schema.Struct({ packageName: Schema.String })),
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

/** Every file an `exports` map points at, package-relative, through conditions and fallback lists. */
const exportTargets = (exports: ExportTarget | undefined): readonly string[] => {
  if (exports === undefined) {
    return [];
  }
  if (Predicate.isString(exports)) {
    return [exports.replace(/^\.\//u, '')];
  }
  return (Array.isArray(exports) ? exports : Object.values(exports)).flatMap(exportTargets);
};

/** A dependency the planner cannot resolve to a workspace package by name. */
const isLocalVersion = (version: string) => /^(?:file:|link:|workspace:(?:[./]|.*[:/]))/u.test(version);
const PnpmWorkspaceSchema = Schema.Struct({ packages: Schema.Array(Schema.String) });
class WorkspaceUnreadable extends Schema.TaggedError<WorkspaceUnreadable>()('WorkspaceUnreadable', {
  reason: Schema.String,
}) {}

/**
 * The package directories app/pnpm-workspace.yaml declares: `<directory>/*` names every directory below it that holds a
 * package.json, any other entry one package directory. Another form cannot be resolved and fails.
 */
const readWorkspace = (rootPackages: readonly string[]) =>
  Effect.gen(function* readCiWorkspace() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const app = yield* path.fromFileUrl(new URL('..', import.meta.url));
    const workspace = yield* Schema.decodeUnknownEffect(PnpmWorkspaceSchema)(
      parse(yield* fs.readFileString(path.join(app, 'pnpm-workspace.yaml'))),
    );
    const directories = ['.'];
    for (const declared of workspace.packages) {
      const area = declared.endsWith('/*') ? declared.slice(0, -2) : undefined;
      if (!/^[a-z0-9-]+$/u.test(area ?? declared)) {
        return yield* new WorkspaceUnreadable({ reason: `unsupported pnpm-workspace.yaml package entry ${declared}` });
      }
      if (area === undefined) {
        directories.push(declared);
        continue;
      }
      for (const entry of yield* fs.readDirectory(path.join(app, area))) {
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
        exportTargets: exportTargets(manifest.exports),
        name: manifest.name,
        uncertain:
          // `topology/ownership.json` is the OntOS module map: it names the root-level storefront packages nowhere.
          (directory !== '.' &&
            !rootPackages.includes(directory) &&
            !ownership.owners.some((owner) => owner.package === manifest.name && owner.path === directory)) ||
          [
            manifest.dependencies,
            manifest.devDependencies,
            manifest.optionalDependencies,
            manifest.peerDependencies,
          ].some((group) => Object.values(group ?? {}).some(isLocalVersion)),
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
      const templates = yield* loadCiMatrices();
      const paths = yield* fs.readFileString(pathsFile);
      const packages = yield* readWorkspace(rootPackagesOf(templates)).pipe(
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
        expected: encode(plan.expected),
        integration: encode(plan.jobs.database),
        integrationBrowser: encode(plan.jobs.browser),
        integrationOwners: encode(plan.jobs.owners),
        integrationTopology: encode(plan.jobs.topology),
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
          `Required integration rows: ${plan.integration.length} of ${templates.integration.length}.`,
          `Affected-plan integration rows: ${plan.candidateIntegration.map(({ name }) => name).join(', ') || 'none'}.`,
          '',
          `Mode: ${plan.mode}. Source rows: ${plan.source.map(({ name }) => name).join(', ')}.`,
          'Only a candidate/* dispatch without force-ci-full and a push to the demo trunk narrow the gates; every other run is complete.',
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
