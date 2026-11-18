import type { CiTopologySchema, IntegrationEntry, Templates } from './plan-ci-checks.mts';

import { packIntegrationRows } from './ci-integration-packing.mts';
import { workspaceConsumerClosure } from './workspace-consumer-closure.mts';

export interface CiWorkspacePackage {
  readonly contractProducer?: string;
  readonly dependencies: readonly string[];
  readonly directory: string;
  readonly name: string;
  readonly uncertain?: boolean;
}

/**
 * Partition selected work by the job that runs it. No job holds a runner while it waits for another job of
 * the run: producers only produce, and every consumer names its producers in `needs`, so GitHub starts it
 * once their artifacts exist. Producers start with the run: the build shards (node-artifact-build) build
 * and upload every delivery unit on runtime-impacting runs, and the database producer (service-integration) migrates,
 * exports and uploads this run's database whenever integration work is selected, so neither gate job ever
 * expands an empty matrix. The browser checks migrate their own database and need nobody. The deployment
 * bootstrap and the owner rows consume the build shards; the owner rows also restore the database archive.
 */
export const integrationPhases = (entries: readonly IntegrationEntry[], build: Templates['build']) => ({
  browser: entries.filter(({ suite }) => suite === 'browser'),
  build: build.map(({ shard, units }) => ({
    name: `Build node artifacts (${String(shard)}/${String(build.length)})`,
    shard,
    units,
  })),
  database: entries.length === 0 ? [] : [{ name: 'Prepare integration database', suite: 'database' as const }],
  owners: entries.filter(({ suite }) => suite === 'integration'),
  topology: entries.filter(({ suite }) => suite === 'bootstrap'),
});

export const lintSweeps = ['all', 'changed'] as const;
export type LintSweep = (typeof lintSweeps)[number];

/**
 * Unit rows read the build shards' uploads, so each needs the build shards, and each also takes the slot of
 * the check it follows. The work job carries the workspace-unit gate id and follows the source contracts;
 * when none of its rows is selected, the first selected row is promoted into it. The other rows follow the
 * changed-file lint, the static contracts and the repository tooling tests, which free their runners after
 * the owner rows and the bootstrap have taken the build shards' and the database producer's. A whole-tree
 * lint frees two slots, so the static-contracts successor moves there while browser checks take its slot.
 */
export const unitPhases = (entries: Templates['unit'], lintSweep: LintSweep) => {
  const phase = (row: Templates['unit'][number]) =>
    row['after-check'] === 'static' && lintSweep === 'all' ? 'lint' : row['after-check'];
  const work = entries.filter((row) => phase(row) === undefined);
  const promoted = work.length === 0 ? entries[0] : undefined;
  const deferred = entries.filter((row) => row !== promoted);
  return {
    afterLint: deferred.filter((row) => phase(row) === 'lint'),
    afterStatic: deferred.filter((row) => phase(row) === 'static'),
    afterTooling: deferred.filter((row) => phase(row) === 'tooling'),
    work: promoted === undefined ? work : [promoted],
  };
};

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

type DependencyGroup = Readonly<Record<string, string>> | undefined;

export interface CiPackageManifest {
  readonly dependencies?: DependencyGroup;
  readonly devDependencies?: DependencyGroup;
  readonly name: string;
  readonly ontosContractOwner?: { readonly packageName: string };
  readonly optionalDependencies?: DependencyGroup;
  readonly peerDependencies?: DependencyGroup;
}

/** One `packages:` entry of app/pnpm-workspace.yaml: a path glob, and whether a leading `!` excludes what it names. */
export interface WorkspaceGlob {
  readonly exclude: boolean;
  readonly glob: string;
}

const WORKSPACE_ENTRY = /^\s*-\s+(?<pattern>\S+)\s*(?:#.*)?$/u;
const EXPANDABLE_GLOB = /^[A-Za-z0-9@_*?-][A-Za-z0-9@._*?-]*(?:\/[A-Za-z0-9@_*?-][A-Za-z0-9@._*?-]*)*$/u;

/** One block-list line read as a glob, or why ci-plan cannot expand it exactly. */
const workspaceGlob = (line: string): WorkspaceGlob | { readonly refused: string } => {
  const pattern = WORKSPACE_ENTRY.exec(line)?.groups?.pattern;
  if (pattern === undefined) {
    return { refused: `ci-plan cannot read this packages: entry of app/pnpm-workspace.yaml: ${line}` };
  }
  const entry = /^(?<quote>['"])(?<inner>.*)\k<quote>$/u.exec(pattern)?.groups?.inner ?? pattern;
  const glob = entry.replace(/^!/u, '');
  return EXPANDABLE_GLOB.test(glob) && !glob.includes('**')
    ? { exclude: entry.startsWith('!'), glob }
    : {
        refused: `ci-plan expands only '*' and '?' inside package directories; app/pnpm-workspace.yaml lists '${entry}'.`,
      };
};

/**
 * The `packages:` globs of app/pnpm-workspace.yaml, or why they cannot be read. ci-plan reads the file before any YAML
 * parser is installed, so this reads the block list the install action reads, by its rules: quotes, a leading `!` and
 * trailing comments are honoured, and only `*` and `?` inside a path segment are expanded. Any other form is refused
 * rather than planned from a partial package list.
 */
export const workspacePackageGlobs = (
  text: string,
): { readonly globs: readonly WorkspaceGlob[] } | { readonly unreadable: string } => {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^packages:\s*(?:#.*)?$/u.test(line));
  const following = start === -1 ? [] : lines.slice(start + 1);
  const end = following.findIndex((line) => /^[^\s#-]/u.test(line));
  const read = (end === -1 ? following : following.slice(0, end))
    .filter((line) => !/^\s*(?:#.*)?$/u.test(line))
    .map(workspaceGlob);
  const [refused] = read.flatMap((glob) => ('refused' in glob ? [glob.refused] : []));
  if (refused !== undefined) {
    return { unreadable: refused };
  }
  const globs = read.flatMap((glob) => ('refused' in glob ? [] : [glob]));
  return globs.some(({ exclude }) => !exclude)
    ? { globs }
    : { unreadable: 'app/pnpm-workspace.yaml lists no package directory.' };
};

/** Whether a glob segment matches against its parent's listed entries rather than naming one child. */
export const workspaceGlobLists = (segment: string) => /[*?]/u.test(segment);

/**
 * One glob segment applied to a directory (`.` for app/): a literal segment names its child, a `*` or `?` segment the
 * listed entries it matches. Like the install action's shell glob, a wildcard never matches a name starting with a dot.
 */
export const workspaceGlobChildren = (parent: string, segment: string, entries: readonly string[]) => {
  const prefix = parent === '.' ? '' : `${parent}/`;
  if (!workspaceGlobLists(segment)) {
    return [`${prefix}${segment}`];
  }
  const matcher = new RegExp(
    `^${segment
      .replaceAll('.', String.raw`\.`)
      .replaceAll('*', '[^/]*')
      .replaceAll('?', '[^/]')}$`,
    'u',
  );
  return entries.filter((entry) => !entry.startsWith('.') && matcher.test(entry)).map((entry) => `${prefix}${entry}`);
};

/**
 * The workspace package directories: every directory an included glob matched minus every directory an excluded one
 * matched, never one inside node_modules. Each list holds only directories with a package.json. Callers sort the result
 * bytewise, as the install action lists it and as the planner always ordered its packages.
 */
export const workspaceDirectories = (
  expanded: readonly { readonly directories: readonly string[]; readonly exclude: boolean }[],
): readonly string[] => {
  const excluded = new Set(expanded.filter(({ exclude }) => exclude).flatMap(({ directories }) => directories));
  return [...new Set(expanded.filter(({ exclude }) => !exclude).flatMap(({ directories }) => directories))].filter(
    (directory) => !excluded.has(directory) && !`/${directory}/`.includes('/node_modules/'),
  );
};

/**
 * The package directories app/pnpm-workspace.yaml declares, or why they cannot be read, listed synchronously: `entries`
 * lists a directory relative to app/ (empty when it is none) and `hasManifest` tells whether one holds a package.json.
 */
export const workspacePackageDirectories = (
  text: string,
  entries: (directory: string) => readonly string[],
  hasManifest: (directory: string) => boolean,
): { readonly directories: readonly string[] } | { readonly unreadable: string } => {
  const workspace = workspacePackageGlobs(text);
  if ('unreadable' in workspace) {
    return workspace;
  }
  return {
    directories: workspaceDirectories(
      workspace.globs.map(({ exclude, glob }) => {
        let level: readonly string[] = ['.'];
        for (const segment of glob.split('/')) {
          level = level.flatMap((parent) =>
            workspaceGlobChildren(parent, segment, workspaceGlobLists(segment) ? entries(parent) : []),
          );
        }
        return { directories: level.filter(hasManifest), exclude };
      }),
    ),
  };
};

/**
 * The planner's view of the workspace. Both entry points read the same files and call this one mapping:
 * the installed CLI through Effect, ci-plan through plain Node before any dependency is installed.
 */
export const ciWorkspacePackages = (input: {
  readonly manifests: readonly { readonly directory: string; readonly manifest: CiPackageManifest }[];
  readonly owners: readonly { readonly package: string; readonly path: string }[];
  readonly topology: typeof CiTopologySchema.Type;
}): readonly CiWorkspacePackage[] => {
  const names = new Set(input.manifests.map(({ manifest }) => manifest.name));
  const groups = (manifest: CiPackageManifest) => [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ];
  const workspacePackage = ({ directory, manifest }: (typeof input.manifests)[number]): CiWorkspacePackage => {
    const entry = {
      dependencies: [
        ...new Set(
          groups(manifest)
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
          !input.owners.some((owner) => owner.package === manifest.name && owner.path === directory)) ||
        groups(manifest).some((group) =>
          Object.values(group ?? {}).some((version) => /^(?:file:|link:|workspace:(?:[./]|.*[:/]))/u.test(version)),
        ),
    };
    const producer = manifest.ontosContractOwner?.packageName;
    return producer === undefined ? entry : { ...entry, contractProducer: producer };
  };
  return withCiTopologyDependencies(input.manifests.map(workspacePackage), input.topology);
};

const gateIds = [
  'workspace-gate',
  'workspace-unit',
  'static-contracts',
  'format-and-lint',
  'service-integration',
  'node-artifact-build',
] as const;

const rootDocumentation = (changedPath: string) =>
  changedPath.startsWith('docs/') || ['CONTEXT-MAP.md', 'README.md', 'AGENTS.md'].includes(changedPath);

/**
 * rstest.config.ts runs direct script test files only in test:scripts. Fixtures and helpers are not
 * covered: integration tests read scripts/tests/fixtures/migration-selected-intent.json. Lint plugins,
 * their helpers and fixtures feed oxlint.config.ts and the lint-rule checks, not application artifacts.
 * Keep source contracts, static contracts, all tooling tests and compiler/lint enforcement for both.
 */
const toolingPath = (changedPath: string, paths: Templates['toolingPaths']) =>
  paths !== undefined &&
  (paths.lintDirectories.some((directory) => changedPath.startsWith(`${directory}/`)) ||
    paths.scriptTestDirectories.some((directory) => {
      const file = changedPath.slice(directory.length + 1);
      return changedPath.startsWith(`${directory}/`) && !file.includes('/') && file.endsWith('.test.mts');
    }));

// A path under no workspace package directory widens in planCiChecks, which knows the directories app/pnpm-workspace.yaml
// declares; this names the paths that widen even inside one.
const broadPath = (changedPath: string) =>
  !rootDocumentation(changedPath) &&
  (/^app\/packages\/(?:core-runtime|shared-contracts|shared-design-tokens|gateway-principal-verifier|better-auth-effect-drizzle)\//u.test(
    changedPath,
  ) ||
    /\/(?:package\.json|schema\.ts|[^/]*config\.[^/]+|vertical\.manifest\.ts|vertical\.registration\.ts|vertical\.runtime-declaration\.ts)$/u.test(
      changedPath,
    ) ||
    /\/[^/]*(?:auth|permission|policy|grant)[^/]*\.[cm]?[jt]sx?$/iu.test(changedPath) ||
    /\/(?:drizzle[^/]*|database|db|auth|authorization|permissions|policies|migrations|shared|api)\//u.test(
      changedPath,
    ));

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

/** The workspace directory a package task such as `./verticals/privacy#2/8` runs in; undefined for root and whole proofs. */
export const taskDirectory = (task: string) =>
  /^\.\/(?<directory>[a-z0-9-]+(?:\/[a-z0-9-]+)*)(?:#\d+\/\d+)?$/u.exec(task)?.groups?.directory;

/** Every task form run-integration-suites.sh executes; anything else widens the plan instead of vanishing. */
export const knownTask = (task: string) =>
  /^root:\d+\/\d+$/u.test(task) ||
  /^whole:(?:organization|privacy|pricing|migrations|party-worker|preproposal-basis|preproposal-approval)$/u.test(
    task,
  ) ||
  taskDirectory(task) !== undefined;

export const planCiChecks = (input: {
  readonly changedPaths: readonly string[];
  readonly eventName?: string | undefined;
  readonly forceFull?: boolean;
  readonly integrationCosts?: Readonly<Record<string, number>>;
  readonly packages: readonly CiWorkspacePackage[];
  readonly templates: Templates;
}) => {
  const { packages } = input;
  const packed = packIntegrationRows(input.templates.integration, input.integrationCosts);
  if ('invalid' in packed) {
    return packed;
  }
  const templates = {
    ...input.templates,
    integration: packed,
  };
  // Queue, push, manual and nightly selection keep their prior strictness. A PR may mix tooling with
  // owner changes: remove only proven tooling inputs, then resolve every remaining path as before.
  const runtimePaths = input.changedPaths.filter(
    (changedPath) =>
      !rootDocumentation(changedPath) &&
      !(input.eventName === 'pull_request' && toolingPath(changedPath, templates.toolingPaths)),
  );
  const toolingOnly =
    input.changedPaths.some(
      (changedPath) => input.eventName === 'pull_request' && toolingPath(changedPath, templates.toolingPaths),
    ) && runtimePaths.length === 0;
  const seeds = input.changedPaths.flatMap((changedPath) =>
    packages
      .filter(({ directory }) => directory !== '.' && changedPath.startsWith(`app/${directory}/`))
      .map(({ name }) => name),
  );
  const affectedNames = workspaceConsumerClosure(packages, seeds);
  const affected = packages.filter(({ name }) => affectedNames.has(name));
  const affectedPackages = [...affectedNames];
  const uncertain = packages.some(
    (entry) =>
      entry.uncertain === true ||
      (entry.directory !== '.' && !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/u.test(entry.directory)) ||
      !/^(?:@app\/[a-z0-9-]+|app)$/u.test(entry.name) ||
      entry.dependencies.some((dependency) => !packages.some(({ name }) => name === dependency)) ||
      (entry.contractProducer !== undefined && !packages.some(({ name }) => name === entry.contractProducer)),
  );
  // A package task in a directory outside the workspace graph matches no affected package: it widens instead of vanishing.
  const unrunnable = (task: string) => {
    const directory = taskDirectory(task);
    return !knownTask(task) || (directory !== undefined && !packages.some((entry) => entry.directory === directory));
  };
  const broad =
    input.forceFull === true ||
    uncertain ||
    templates.unit.some(({ commands }) => unknownFilters(commands)) ||
    templates.integration.some(
      (entry) =>
        (entry.tasks ?? []).some(unrunnable) ||
        (entry['proof-packages'] ?? []).some((dependency) => !packages.some(({ name }) => name === dependency)),
    ) ||
    new Set(packages.map(({ name }) => name)).size !== packages.length ||
    input.changedPaths.length === 0 ||
    runtimePaths.some(broadPath) ||
    (!toolingOnly && seeds.length === 0) ||
    runtimePaths.some(
      (changedPath) =>
        !rootDocumentation(changedPath) &&
        !packages.some(({ directory }) => directory !== '.' && changedPath.startsWith(`app/${directory}/`)),
    );
  if (!broad && toolingOnly) {
    return {
      affectedPackages,
      build: [],
      expected: Object.fromEntries(
        gateIds.map((gate) => [
          gate,
          ['workspace-gate', 'static-contracts', 'format-and-lint'].includes(gate) ? 'success' : 'skipped',
        ]),
      ),
      integration: [],
      mode: 'tooling' as const,
      reason:
        'Only repository tooling tests or lint tools changed; source, static, compiler and lint checks remain required.',
      source: templates.source,
      unit: [],
    };
  }
  const affectedDirectories = new Set(affected.map(({ directory }) => directory));
  const rootAffected = affectedDirectories.has('.');
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
    const tasks = (entry.tasks ?? []).filter((task) => {
      if (task.startsWith('root:') || task === 'whole:migrations') {
        return rootAffected;
      }
      if (task.startsWith('whole:preproposal-')) {
        return proofAffected;
      }
      if (task === 'whole:party-worker') {
        return affectedDirectories.has('verticals/party-registry');
      }
      if (task.startsWith('whole:')) {
        return true;
      }
      const directory = taskDirectory(task);
      return directory !== undefined && affectedDirectories.has(directory);
    });
    return tasks.length > 0 ? [{ ...entry, tasks }] : [];
  });
  const selectedUnit = templates.unit.flatMap((entry) => {
    const selected = matchingPackages(entry.commands.split('\n')[0] ?? '', affected);
    if (selected.length === 0) {
      return [];
    }
    const filters = selected.map(({ directory }) => `--filter ./${directory}`).join(' ');
    return [
      {
        ...entry,
        commands: entry.commands.replaceAll(/(?:--filter\s+\S+\s*)+/gu, `${filters} `),
      },
    ];
  });
  // Affected selection is the default; a malformed or empty unit mapping never becomes a green no-op.
  const effectiveMode = !broad && selectedUnit.length > 0 ? 'affected' : 'full';
  const integration: readonly IntegrationEntry[] =
    effectiveMode === 'full' ? templates.integration : selectedIntegration;
  const expected = Object.fromEntries(
    gateIds.map((gate) => [gate, gate === 'service-integration' && integration.length === 0 ? 'skipped' : 'success']),
  );
  const reason =
    effectiveMode === 'affected'
      ? 'Required tests include the changed owners and their transitive consumers.'
      : 'Shared, sensitive, unknown or explicitly full impact requires the complete suite.';
  return {
    affectedPackages,
    // Runtime-impacting runs still build every delivery unit from this commit.
    build: templates.build,
    expected,
    integration,
    mode: effectiveMode,
    reason,
    source: templates.source,
    unit: effectiveMode === 'full' ? templates.unit : selectedUnit,
  };
};

/** Every ci-plan job output except `mode`, keyed exactly as the workflow reads them. */
export const ciPlanOutputs = (
  plan: Exclude<ReturnType<typeof planCiChecks>, { readonly invalid: string }>,
  lintSweep: LintSweep,
) => {
  const phases = integrationPhases(plan.integration, plan.build);
  const units = unitPhases(plan.unit, lintSweep);
  return {
    expected: plan.expected,
    integration: phases.database,
    integrationBrowser: lintSweep === 'all' ? [] : phases.browser,
    integrationBrowserAfterStatic: lintSweep === 'all' ? phases.browser : [],
    integrationBuild: phases.build,
    integrationOwners: phases.owners,
    integrationTopology: phases.topology,
    // Run 44300520644: 653s in the hook/diagnostics step plus 71s setup/cleanup. Two rows target ~400s each.
    lint: Array.from({ length: lintSweep === 'all' ? 2 : 1 }, (_, index) => ({
      row: index + 1,
      rows: lintSweep === 'all' ? 2 : 1,
    })),
    source: plan.source,
    unit: units.work,
    unitAfterLint: units.afterLint,
    unitAfterStatic: units.afterStatic,
    unitAfterTooling: units.afterTooling,
  };
};
