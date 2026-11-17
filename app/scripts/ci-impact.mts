import type { CiTopologySchema, IntegrationEntry, Templates } from './plan-ci-checks.mts';

import { workspaceConsumerClosure } from './workspace-consumer-closure.mts';

export interface CiWorkspacePackage {
  readonly contractProducer?: string;
  readonly dependencies: readonly string[];
  readonly directory: string;
  readonly name: string;
  readonly uncertain?: boolean;
}

/**
 * Partition selected integration work by the check slots it reuses. Early rows install and restore their
 * clusters while the builds run; built rows start on the build slots. The built job carries the
 * service-integration gate id, so it never receives an empty matrix while integration work is selected.
 */
export const integrationPhases = (entries: readonly IntegrationEntry[]) => {
  const browser = entries.filter(({ suite }) => suite === 'browser');
  const suites = entries.filter(({ suite }) => suite === 'integration');
  const built = suites.filter((entry) => entry.early !== true);
  const promoted = built.length === 0 ? suites.slice(0, 1) : [];
  return {
    built: [...promoted, ...built],
    early: suites.filter((entry) => entry.early === true && !promoted.includes(entry)),
    preparation:
      entries.length === 0 || browser.length > 0
        ? browser
        : [{ name: 'Prepare integration database', suite: 'database' as const }],
    topology: entries.filter(({ suite }) => suite === 'bootstrap'),
  };
};

export const lintSweeps = ['all', 'changed'] as const;
export type LintSweep = (typeof lintSweeps)[number];

/**
 * Unit rows reuse the slot of the check they follow. A full lint sweep keeps the lint slot busy for minutes,
 * so a row that follows lint follows the topology proof instead. The work job carries the workspace-unit gate
 * id: when no selected row starts with the builds, the first selected row is promoted into it.
 */
export const unitPhases = (entries: Templates['unit'], lintSweep: LintSweep) => {
  const phase = (row: Templates['unit'][number]) =>
    row['after-check'] === 'lint' && lintSweep === 'all' ? 'topology' : row['after-check'];
  const work = entries.filter((row) => phase(row) === undefined);
  const promoted = work.length === 0 ? entries[0] : undefined;
  const deferred = entries.filter((row) => row !== promoted);
  return {
    afterLint: deferred.filter((row) => phase(row) === 'lint'),
    afterStatic: deferred.filter((row) => phase(row) === 'static'),
    afterTopology: deferred.filter((row) => phase(row) === 'topology'),
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
  /^\.\/(?<directory>(?:apps|packages|verticals)\/[a-z0-9-]+)(?:#\d+\/\d+)?$/u.exec(task)?.groups?.directory;

/** Every task form run-integration-suites.sh executes; anything else widens the plan instead of vanishing. */
export const knownTask = (task: string) =>
  /^root:\d+\/\d+$/u.test(task) ||
  /^whole:(?:organization|privacy|pricing|migrations|party-worker|preproposal-basis|preproposal-approval)$/u.test(
    task,
  ) ||
  taskDirectory(task) !== undefined;

export const planCiChecks = (input: {
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
  const affectedPackages = [...affectedNames];
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
        (entry.tasks ?? []).some((task) => !knownTask(task)) ||
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
    return tasks.length === 0 ? [] : [{ ...entry, tasks }];
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
  const integration = effectiveMode === 'full' ? templates.integration : selectedIntegration;
  const expected = Object.fromEntries(
    gateIds.map((gate) => [gate, gate === 'service-integration' && integration.length === 0 ? 'skipped' : 'success']),
  );
  const reason =
    effectiveMode === 'affected'
      ? 'Required tests include the changed owners and their transitive consumers.'
      : 'Shared, sensitive, unknown or explicitly full impact requires the complete suite.';
  return {
    affectedPackages,
    expected,
    integration,
    mode: effectiveMode,
    reason,
    source: templates.source,
    unit: effectiveMode === 'full' ? templates.unit : selectedUnit,
  };
};

/** Every ci-plan job output except `mode`, keyed exactly as the workflow reads them. */
export const ciPlanOutputs = (plan: ReturnType<typeof planCiChecks>, lintSweep: LintSweep) => {
  const phases = integrationPhases(plan.integration);
  const units = unitPhases(plan.unit, lintSweep);
  return {
    expected: plan.expected,
    integration: phases.built,
    integrationEarly: phases.early,
    integrationSetup: phases.preparation,
    integrationTopology: phases.topology,
    source: plan.source,
    unit: units.work,
    unitAfterLint: units.afterLint,
    unitAfterStatic: units.afterStatic,
    unitAfterTopology: units.afterTopology,
  };
};
