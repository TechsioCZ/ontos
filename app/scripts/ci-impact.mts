import type { CiTopologySchema, IntegrationEntry, Templates } from './plan-ci-checks.mts';

import { workspaceConsumerClosure } from './workspace-consumer-closure.mts';

export interface CiWorkspacePackage {
  readonly contractProducer?: string;
  readonly dependencies: readonly string[];
  readonly directory: string;
  readonly name: string;
  readonly uncertain?: boolean;
}

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
  const selectedIntegration = templates.integration.flatMap((entry): readonly IntegrationEntry[] => {
    // A row that is neither a package suite nor the browser suite proves the deployment bootstrap or the
    // build outputs themselves: it reads no matrix input and has nothing to narrow, so affected selection
    // always keeps it.
    if (entry.suite !== 'integration' && entry.suite !== 'browser') {
      return [entry];
    }
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
    return [
      {
        ...entry,
        'native-preproposal': entry['native-preproposal'] === true && proofAffected,
        'package-filters': filters,
        'root-suite': rootSuite,
      },
    ];
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
        commands: ['test:unit', 'test:component']
          .map((script) => `pnpm -r --no-sort --if-present ${filters} run ${script}`)
          .join('\n'),
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
