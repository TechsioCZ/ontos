/**
 * The CI planner: which gates, rows and integration tasks a change needs. It imports nothing outside the repository
 * and only erasable types, so the plan job runs it on the hosted runner's Node before anything is installed
 * (scripts/plan-ci-without-install.sh reads the files and writes the outputs).
 */
import { CI_TEXT, CI_TEXTS, knownTask, optionalField, requiredField, taskDirectory } from './ci/ci-matrices-rules.mts';
import type {
  CiAuthoredFields,
  CiAuthoredValue,
  CiIntegrationEntry,
  CiScope,
  CiTemplates,
} from './ci/ci-matrices-rules.mts';
import { workspaceConsumerClosure } from './workspace-consumer-closure.mts';

export type { CiScope } from './ci/ci-matrices-rules.mts';
type Templates = Required<CiTemplates>;
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

interface CiTopologyUnit {
  readonly id: string;
  readonly moduleFederation?: {
    readonly remotes?: readonly { readonly id: string }[];
    readonly verticalRefs?: readonly string[];
  };
  readonly package: string;
  readonly path: string;
  readonly verticalRefs?: readonly string[];
}
/** app/topology/reference-topology.json: the shell and the verticals the deployment composes. */
export interface CiTopology {
  readonly shell: CiTopologyUnit;
  readonly verticals: readonly CiTopologyUnit[];
}

/** Runtime federation references are consumer edges even when package manifests omit them. */
export const withCiTopologyDependencies = (
  packages: readonly CiWorkspacePackage[],
  topology: CiTopology,
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
/** How much of the suite a plan runs: everything, the changed owners and their consumers, or the rows of scopes. */
const PLAN_MODES = ['affected', 'full', 'scoped'] as const;
type PlanMode = (typeof PLAN_MODES)[number];

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
  const affectedPackages = [...affectedNames].toSorted();
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

/** The fields of a workspace package.json the planner reads. */
export interface CiPackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  /**
   * Every path the `exports` value names, through conditions and fallback lists, collected by the reader that checks
   * package.json against CI_WORKSPACE_FIELDS (scripts/plan-ci-without-install.sh).
   */
  readonly exportPaths: readonly string[];
  readonly name: string;
  readonly ontosContractOwner?: { readonly packageName: string };
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

/** A dependency the planner cannot resolve to a workspace package by name. */
const isLocalVersion = (version: string) => /^(?:file:|link:|workspace:(?:[./]|.*[:/]))/u.test(version);

/** The entries of the top-level `packages:` list of pnpm-workspace.yaml; undefined for a line that is no plain entry. */
const workspaceEntries = (text: string) => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^packages:\s*$/u.test(line));
  const end = lines.findIndex((line, index) => index > start && /^\S/u.test(line));
  return start === -1
    ? []
    : lines
        .slice(start + 1, end === -1 ? undefined : end)
        .filter((line) => !/^\s*(?:#.*)?$/u.test(line))
        .map((line) => /^\s+-\s+(?<quote>['"]?)(?<entry>[^\s#'"]+)\k<quote>\s*(?:#.*)?$/u.exec(line)?.groups?.entry);
};

/**
 * The package directories app/pnpm-workspace.yaml declares, read from its text: `<directory>/*` names every entry of
 * that directory (`entries`, in the order the file system lists it) that holds a package.json (`hasManifest`), any
 * other entry one package directory. A list this cannot read, or another entry form, cannot be resolved.
 */
export const workspacePackageDirectories = (
  text: string,
  entries: (directory: string) => readonly string[],
  hasManifest: (directory: string) => boolean,
): { readonly directories: readonly string[] } | { readonly unreadable: string } => {
  const declared = workspaceEntries(text);
  if (declared.length === 0) {
    return { unreadable: 'pnpm-workspace.yaml lists no packages' };
  }
  const directories = ['.'];
  for (const entry of declared) {
    const area = entry?.endsWith('/*') === true ? entry.slice(0, -2) : undefined;
    if (entry === undefined || !/^[a-z0-9-]+$/u.test(area ?? entry)) {
      return { unreadable: `unsupported pnpm-workspace.yaml package entry ${entry ?? '(not a plain list item)'}` };
    }
    directories.push(
      ...(area === undefined
        ? [entry]
        : entries(area)
            .map((name) => `${area}/${name}`)
            .filter(hasManifest)),
    );
  }
  return { directories };
};

const VERSIONS = optionalField({ map: CI_TEXT });
const topologyUnit: CiAuthoredValue = {
  closed: false,
  fields: {
    id: requiredField(CI_TEXT),
    moduleFederation: optionalField({
      closed: false,
      fields: {
        remotes: optionalField({ list: { closed: false, fields: { id: requiredField(CI_TEXT) } } }),
        verticalRefs: optionalField(CI_TEXTS),
      },
    }),
    package: requiredField(CI_TEXT),
    path: requiredField(CI_TEXT),
    verticalRefs: optionalField(CI_TEXTS),
  },
};

/**
 * What the planner reads from each workspace package.json, topology/ownership.json and
 * topology/reference-topology.json, to the strictness the installed planner decoded them with. A file that breaks
 * its contract leaves the workspace unreadable, and the complete suite runs. Keys outside a contract are not read.
 */
export const CI_WORKSPACE_FIELDS = {
  manifest: {
    dependencies: VERSIONS,
    devDependencies: VERSIONS,
    /** A path, a condition map, or a fallback list of either. */
    exports: optionalField({ tree: CI_TEXT }),
    name: requiredField(CI_TEXT),
    ontosContractOwner: optionalField({ closed: false, fields: { packageName: requiredField(CI_TEXT) } }),
    optionalDependencies: VERSIONS,
    peerDependencies: VERSIONS,
  },
  ownership: {
    owners: requiredField({
      list: { closed: false, fields: { package: requiredField(CI_TEXT), path: requiredField(CI_TEXT) } },
    }),
  },
  topology: { shell: requiredField(topologyUnit), verticals: requiredField({ list: topologyUnit }) },
} satisfies Readonly<Record<string, CiAuthoredFields>>;

/**
 * The planner's view of the workspace from the manifests of the declared directories, the OntOS module map
 * (topology/ownership.json `owners`) and the deployment topology. A package the module map does not name, outside the
 * matrices' root-level packages, is uncertain.
 */
export const ciWorkspacePackages = (input: {
  readonly manifests: readonly { readonly directory: string; readonly manifest: CiPackageManifest }[];
  readonly owners: readonly { readonly package: string; readonly path: string }[];
  readonly rootPackages: readonly string[];
  readonly topology: CiTopology;
}): readonly CiWorkspacePackage[] => {
  const names = new Set(input.manifests.map(({ manifest }) => manifest.name));
  return withCiTopologyDependencies(
    input.manifests.map(({ directory, manifest }): CiWorkspacePackage => {
      const groups = [
        manifest.dependencies,
        manifest.devDependencies,
        manifest.optionalDependencies,
        manifest.peerDependencies,
      ];
      return {
        contractProducer: manifest.ontosContractOwner?.packageName,
        dependencies: [
          ...new Set(
            groups
              .flatMap((group) => Object.entries(group ?? {}))
              .filter(
                ([name, version]) => names.has(name) || name.startsWith('@app/') || version.startsWith('workspace:'),
              )
              .map(([name]) => name),
          ),
        ],
        directory,
        exportTargets: manifest.exportPaths.map((target) => target.replace(/^\.\//u, '')),
        name: manifest.name,
        uncertain:
          // `topology/ownership.json` is the OntOS module map: it names the root-level storefront packages nowhere.
          (directory !== '.' &&
            !input.rootPackages.includes(directory) &&
            !input.owners.some((owner) => owner.package === manifest.name && owner.path === directory)) ||
          groups.some((group) => Object.values(group ?? {}).some(isLocalVersion)),
      };
    }),
    input.topology,
  );
};

type CiPlan = ReturnType<typeof planCiChecks>;

/** The plan job's outputs after `mode`, by output name, in the order it writes them. */
export const ciPlanOutputs = (plan: CiPlan) => ({
  expected: plan.expected,
  integration: plan.jobs.database,
  integrationBrowser: plan.jobs.browser,
  integrationOwners: plan.jobs.owners,
  integrationTopology: plan.jobs.topology,
  source: plan.source,
  unit: plan.jobs.unitPlain,
  'unit-artifacts': plan.jobs.unitArtifacts,
});

/** The plan job's step summary. */
export const ciPlanSummary = (plan: CiPlan, templates: Templates) =>
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
  ].join('\n');
