import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { outboxWorkerDelivery } from './outbox-worker-delivery.mjs';

type DeploymentPhaseKind = 'infrastructure' | 'provider' | 'shell';

interface TopologyUnit {
  readonly dependencies: readonly string[];
  readonly id: string;
  readonly kind: 'provider' | 'shell';
  readonly packageName: string;
  readonly path: string;
  readonly serviceIdEnv: string;
  readonly stageSetup: string;
}

interface DeploymentPhase {
  readonly id: string;
  readonly kind: DeploymentPhaseKind;
  readonly serviceIdEnv: string;
  readonly stageSetup: string;
}

interface ReferenceTopology {
  readonly shell?: {
    readonly id?: string;
    readonly package?: string;
    readonly verticalRefs?: readonly string[];
  };
  readonly sharedPackages?: readonly {
    readonly id?: string;
    readonly package?: string;
    readonly path?: string;
  }[];
  readonly verticals?: readonly {
    readonly id?: string;
    readonly package?: string;
    readonly path?: string;
    readonly moduleFederation?: {
      readonly remotes?: readonly { readonly id?: string }[];
      readonly verticalRefs?: readonly string[];
    };
  }[];
}

interface Ownership {
  readonly owners?: readonly {
    readonly id?: string;
    readonly package?: string;
    readonly path?: string;
  }[];
}

export interface DeploymentImpactPlan {
  readonly any: boolean;
  readonly changedPaths: readonly string[];
  readonly comparison: {
    readonly baseRevision?: string;
    readonly headRevision?: string;
    readonly mode: 'diff' | 'full';
    readonly reason?: string;
  };
  readonly phases: readonly DeploymentPhase[];
  readonly schemaVersion: 1;
  readonly units: {
    readonly migrator: boolean;
    readonly providers: readonly string[];
    readonly shell: boolean;
    readonly spicedb: boolean;
  };
}

export interface PlanDeploymentImpactOptions {
  readonly baseRevision?: string;
  readonly changedPaths?: readonly string[];
  readonly headRevision?: string;
  readonly rootDirectory?: string;
}

const INFRASTRUCTURE_PHASES = {
  migrator: {
    id: 'migrator',
    kind: 'infrastructure',
    serviceIdEnv: 'ZEROPS_MIGRATOR_SERVICE_ID',
    stageSetup: 'migrator',
  },
  spicedb: {
    id: 'spicedb',
    kind: 'infrastructure',
    serviceIdEnv: 'ZEROPS_SPICEDB_SERVICE_ID',
    stageSetup: 'spicedb',
  },
} as const;

const fail = (message: string): never => {
  throw new Error(`Deployment impact planning failed: ${message}`);
};

const readJson = <Value,>(filePath: string): Value =>
  JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Value;

const requireString = (value: string | undefined, area: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${area} must be a non-empty string`);
  }
  return value;
};

const toEnvironmentSegment = (value: string): string =>
  value
    .replaceAll(/[^A-Za-z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '')
    .toUpperCase();

const normalizeChangedPath = (changedPath: string): string => {
  const normalized = changedPath.replaceAll('\\', '/').replace(/^\.\//u, '');
  return normalized.startsWith('app/') ? normalized.slice('app/'.length) : normalized;
};

const isWithin = (changedPath: string, ownerPath: string): boolean =>
  changedPath === ownerPath || changedPath.startsWith(`${ownerPath}/`);

const parseStageSetups = (zeropsSource: string): ReadonlySet<string> => {
  const setups = new Set<string>();
  for (const match of zeropsSource.matchAll(
    /^\s*-\s+setup:\s*['"]?(?<setup>[^'"\s]+)['"]?\s*$/gmu,
  )) {
    if (match.groups?.setup) {
      setups.add(match.groups.setup);
    }
  }
  return setups;
};

const buildTopologyUnits = (
  topology: ReferenceTopology,
  ownership: Ownership,
  stageSetups: ReadonlySet<string>,
): readonly TopologyUnit[] => {
  const ownerEntries = ownership.owners ?? [];
  const ownersById = new Map<string, (typeof ownerEntries)[number]>();
  for (const owner of ownerEntries) {
    const ownerId = requireString(owner.id, 'ownership owner.id');
    if (ownersById.has(ownerId)) {
      fail(`topology/ownership.json contains duplicate owner identity "${ownerId}"`);
    }
    ownersById.set(ownerId, owner);
  }
  const shellId = requireString(topology.shell?.id, 'reference topology shell.id');
  const shellPackage = requireString(topology.shell?.package, 'reference topology shell.package');
  const shellOwner = ownersById.get(shellId);
  if (!shellOwner) {
    fail(`topology delivery unit "${shellId}" is missing from topology/ownership.json`);
  }
  const shellPath = requireString(shellOwner.path, `ownership owner ${shellId}.path`);
  if (shellOwner.package !== shellPackage) {
    fail(
      `topology and ownership disagree for "${shellId}": topology package "${shellPackage}" versus ownership package "${String(shellOwner.package)}"`,
    );
  }

  const verticals = topology.verticals ?? [];
  const verticalIds = new Set<string>();
  for (const vertical of verticals) {
    const verticalId = requireString(vertical.id, 'reference topology vertical.id');
    if (verticalIds.has(verticalId)) {
      fail(`reference topology contains duplicate vertical identity "${verticalId}"`);
    }
    verticalIds.add(verticalId);
  }
  const sharedPackageIds = new Set<string>();
  for (const sharedPackage of topology.sharedPackages ?? []) {
    const id = requireString(sharedPackage.id, 'reference topology shared package.id');
    const packageName = requireString(
      sharedPackage.package,
      `reference topology shared package ${id}.package`,
    );
    const ownerPath = requireString(
      sharedPackage.path,
      `reference topology shared package ${id}.path`,
    );
    if (sharedPackageIds.has(id)) {
      fail(`reference topology contains duplicate shared package identity "${id}"`);
    }
    sharedPackageIds.add(id);
    const owner = ownersById.get(id);
    if (!owner) {
      fail(`topology shared package "${id}" is missing from topology/ownership.json`);
    }
    if (owner.package !== packageName || owner.path !== ownerPath) {
      fail(
        `topology and ownership disagree for shared package "${id}": expected package "${packageName}" at "${ownerPath}", found package "${String(owner.package)}" at "${String(owner.path)}"`,
      );
    }
  }
  for (const id of [shellId, ...verticalIds]) {
    if (sharedPackageIds.has(id)) {
      fail(`reference topology reuses delivery identity "${id}" for a shared package`);
    }
  }
  const units: TopologyUnit[] = [];
  for (const vertical of verticals) {
    const id = requireString(vertical.id, 'reference topology vertical.id');
    const packageName = requireString(
      vertical.package,
      `reference topology vertical ${id}.package`,
    );
    const ownerPath = requireString(vertical.path, `reference topology vertical ${id}.path`);
    const owner = ownersById.get(id);
    if (!owner) {
      fail(`topology delivery unit "${id}" is missing from topology/ownership.json`);
    }
    if (owner.package !== packageName || owner.path !== ownerPath) {
      fail(
        `topology and ownership disagree for "${id}": expected package "${packageName}" at "${ownerPath}", found package "${String(owner.package)}" at "${String(owner.path)}"`,
      );
    }
    const dependencies = [
      ...(vertical.moduleFederation?.verticalRefs ?? []),
      ...(vertical.moduleFederation?.remotes ?? []).flatMap((remote) =>
        typeof remote.id === 'string' ? [remote.id] : [],
      ),
    ];
    for (const dependency of dependencies) {
      if (!verticalIds.has(dependency)) {
        fail(`topology delivery unit "${id}" references unknown provider "${dependency}"`);
      }
    }
    units.push({
      dependencies: [...new Set(dependencies)].sort(),
      id,
      kind: 'provider',
      packageName,
      path: ownerPath,
      serviceIdEnv: `ZEROPS_${toEnvironmentSegment(id)}_SERVICE_ID`,
      stageSetup: id,
    });
  }

  const shellDependencies = topology.shell?.verticalRefs ?? [];
  for (const dependency of shellDependencies) {
    if (!verticalIds.has(dependency)) {
      fail(`topology shell "${shellId}" references unknown provider "${dependency}"`);
    }
  }
  units.push({
    dependencies: [...new Set(shellDependencies)].sort(),
    id: shellId,
    kind: 'shell',
    packageName: shellPackage,
    path: shellPath,
    serviceIdEnv: 'ZEROPS_SHELL_SERVICE_ID',
    stageSetup: shellId.replaceAll('-', ''),
  });

  const topologyOwnerIds = new Set([shellId, ...verticalIds, ...sharedPackageIds]);
  for (const owner of ownerEntries) {
    const id = requireString(owner.id, 'ownership owner.id');
    const ownerPath = requireString(owner.path, `ownership owner ${id}.path`);
    if (/^(?:apps|packages|verticals)\//u.test(ownerPath) && !topologyOwnerIds.has(id)) {
      fail(`ownership entry "${id}" at "${ownerPath}" has no matching topology identity`);
    }
  }

  for (const phase of [...Object.values(INFRASTRUCTURE_PHASES), ...units]) {
    if (!stageSetups.has(phase.stageSetup)) {
      fail(
        `topology delivery unit "${phase.id}" has unsupported stage setup "${phase.stageSetup}" in zerops.yaml`,
      );
    }
  }
  return units;
};

const orderUnits = (units: readonly TopologyUnit[]): readonly TopologyUnit[] => {
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const ordered: TopologyUnit[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      fail(`topology delivery dependencies contain a cycle at "${id}"`);
    }
    const unit = unitsById.get(id);
    if (!unit) {
      fail(`topology delivery dependencies reference unknown unit "${id}"`);
    }
    visiting.add(id);
    for (const dependency of unit.dependencies) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(unit);
  };
  for (const unit of [...units].sort((left, right) => left.id.localeCompare(right.id))) {
    visit(unit.id);
  }
  return ordered;
};

const invalidBaseReason = (
  rootDirectory: string,
  baseRevision: string | undefined,
  headRevision: string,
): string | undefined => {
  if (!baseRevision || /^0+$/u.test(baseRevision)) {
    return 'comparison base is unavailable or all-zero';
  }
  try {
    execFileSync('git', ['cat-file', '-e', `${baseRevision}^{commit}`], {
      cwd: rootDirectory,
      stdio: 'ignore',
    });
  } catch {
    return `comparison base "${baseRevision}" is unavailable`;
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', baseRevision, headRevision], {
      cwd: rootDirectory,
      stdio: 'ignore',
    });
  } catch {
    return `comparison base "${baseRevision}" is not an ancestor of "${headRevision}"`;
  }
  return undefined;
};

const changedPathsFromGit = (
  rootDirectory: string,
  baseRevision: string,
  headRevision: string,
): readonly string[] => {
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', baseRevision, headRevision],
    { cwd: rootDirectory, encoding: 'utf-8' },
  );
  return output.split('\0').filter(Boolean);
};

const isMigrationChange = (changedPath: string): boolean =>
  /(?:^|\/)(?:drizzle(?:-auth)?\/|drizzle(?:\.auth)?\.config\.ts$|schema\.ts$|prepare-[^/]+-migration\.mts$|verify-(?:auth-)?db-schema\.mts$)/u.test(
    changedPath,
  ) ||
  /^(?:scripts\/run-zerops-migrator\.mjs|scripts\/verify-application-db-schema\.mts|scripts\/postgres\/(?:bootstrap-runtime-role\.mts|bootstrap-spicedb-database\.mts|docker-init-runtime-role\.sh|spicedb-database-config\.mts))$/u.test(
    changedPath,
  );

const isPublicContractChange = (ownerPath: string, changedPath: string): boolean => {
  const relativePath = changedPath.slice(ownerPath.length + 1);
  return (
    relativePath === 'package.json' ||
    relativePath === 'vertical.manifest.ts' ||
    relativePath === 'module-federation.config.ts' ||
    relativePath === 'backend-federation.config.ts' ||
    relativePath.startsWith('shared/')
  );
};

const isSpiceDbChange = (changedPath: string): boolean =>
  changedPath.startsWith('packages/core-runtime/spicedb/') ||
  changedPath.startsWith('packages/core-runtime/src/permissions/') ||
  changedPath === 'scripts/postgres/bootstrap-spicedb-database.mts' ||
  changedPath === 'scripts/postgres/spicedb-database-config.mts' ||
  changedPath === 'scripts/run-zerops-spicedb.sh';

const isConservativeFullDeployChange = (changedPath: string): boolean =>
  changedPath === '.mise.toml' ||
  changedPath === 'package.json' ||
  changedPath === 'pnpm-lock.yaml' ||
  changedPath === 'pnpm-workspace.yaml' ||
  changedPath === 'scripts/install-zerops-node.sh' ||
  changedPath === 'scripts/generate-outbox-worker-deployment.mjs' ||
  changedPath === 'scripts/materialize-outbox-worker.mjs' ||
  changedPath === 'scripts/materialize-zerops-runtime.mjs' ||
  changedPath === 'scripts/outbox-worker-delivery.mjs' ||
  changedPath === 'zerops.yaml' ||
  changedPath.startsWith('topology/');

const toPhase = (unit: TopologyUnit): DeploymentPhase => ({
  id: unit.id,
  kind: unit.kind,
  serviceIdEnv: unit.serviceIdEnv,
  stageSetup: unit.stageSetup,
});

export const planDeploymentImpact = (
  options: PlanDeploymentImpactOptions = {},
): DeploymentImpactPlan => {
  const rootDirectory = options.rootDirectory ?? process.cwd();
  const topology = readJson<ReferenceTopology>(
    path.join(rootDirectory, 'topology/reference-topology.json'),
  );
  const ownership = readJson<Ownership>(path.join(rootDirectory, 'topology/ownership.json'));
  const stageSetups = parseStageSetups(
    fs.readFileSync(path.join(rootDirectory, 'zerops.yaml'), 'utf-8'),
  );
  const orderedUnits = orderUnits(buildTopologyUnits(topology, ownership, stageSetups));
  const workers = (topology.verticals ?? []).flatMap((vertical) => {
    const delivery = outboxWorkerDelivery(rootDirectory, vertical);
    if (!delivery) {
      return [];
    }
    if (!stageSetups.has(delivery.stageSetup)) {
      fail(`Missing generated worker setup ${delivery.stageSetup}`);
    }
    return [delivery];
  });
  const unitsById = new Map(orderedUnits.map((unit) => [unit.id, unit]));
  const shell = orderedUnits.find((unit) => unit.kind === 'shell');
  if (!shell) {
    fail('reference topology has no Shell delivery unit');
  }

  const headRevision = options.headRevision ?? 'HEAD';
  const fallbackReason = options.changedPaths
    ? undefined
    : invalidBaseReason(rootDirectory, options.baseRevision, headRevision);
  const fullDeploy = fallbackReason !== undefined;
  const comparedPaths =
    options.changedPaths ??
    (fullDeploy
      ? []
      : changedPathsFromGit(
          rootDirectory,
          requireString(options.baseRevision, 'base revision'),
          headRevision,
        ));
  const changedPaths = [...new Set(comparedPaths.map(normalizeChangedPath))].sort();

  const ownerEntries = ownership.owners ?? [];
  const impacted = new Set<string>();
  let migrator = fullDeploy;
  let spicedb = fullDeploy;
  const addWithConsumers = (unitId: string): void => {
    impacted.add(unitId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const unit of orderedUnits) {
        if (
          !impacted.has(unit.id) &&
          unit.dependencies.some((dependency) => impacted.has(dependency))
        ) {
          impacted.add(unit.id);
          changed = true;
        }
      }
    }
  };
  const addAllUnits = (): void => {
    for (const unit of orderedUnits) {
      impacted.add(unit.id);
    }
  };

  if (fullDeploy) {
    addAllUnits();
  } else {
    for (const changedPath of changedPaths) {
      if (/^(?:apps|packages|verticals)\//u.test(changedPath)) {
        const owner = ownerEntries
          .filter((entry) => typeof entry.path === 'string' && isWithin(changedPath, entry.path))
          .sort((left, right) => String(right.path).length - String(left.path).length)[0];
        if (!owner) {
          const area = changedPath.split('/')[0];
          fail(`unknown changed path "${changedPath}" in application area "${area}"`);
        }
        const ownerId = requireString(owner.id, `owner for changed path ${changedPath}`);
        const topologyUnit = unitsById.get(ownerId);
        if (topologyUnit) {
          impacted.add(ownerId);
          if (isPublicContractChange(topologyUnit.path, changedPath)) {
            addWithConsumers(ownerId);
          }
        } else if (changedPath.startsWith('packages/')) {
          addAllUnits();
        } else {
          fail(`changed path "${changedPath}" maps to non-delivery owner "${ownerId}"`);
        }
      }

      if (isMigrationChange(changedPath)) {
        migrator = true;
      }
      if (isSpiceDbChange(changedPath)) {
        spicedb = true;
        addAllUnits();
      }
      if (isConservativeFullDeployChange(changedPath)) {
        migrator = true;
        spicedb = true;
        addAllUnits();
      }
    }
  }

  const selectedUnits = orderedUnits.filter((unit) => impacted.has(unit.id));
  const phases: DeploymentPhase[] = [];
  if (migrator) {
    phases.push(INFRASTRUCTURE_PHASES.migrator);
  }
  if (spicedb) {
    phases.push(INFRASTRUCTURE_PHASES.spicedb);
  }
  phases.push(
    ...selectedUnits.filter((unit) => unit.kind === 'provider').map(toPhase),
    ...workers
      .filter((worker) => impacted.has(worker.ownerId))
      .map((worker) => ({
        id: worker.id,
        kind: 'provider' as const,
        serviceIdEnv: worker.serviceIdEnv,
        stageSetup: worker.stageSetup,
      })),
  );
  phases.push(...selectedUnits.filter((unit) => unit.kind === 'shell').map(toPhase));

  return {
    any: phases.length > 0,
    changedPaths,
    comparison: {
      ...(options.baseRevision ? { baseRevision: options.baseRevision } : {}),
      headRevision,
      mode: fullDeploy ? 'full' : 'diff',
      ...(fallbackReason ? { reason: fallbackReason } : {}),
    },
    phases,
    schemaVersion: 1,
    units: {
      migrator,
      providers: phases.filter((phase) => phase.kind === 'provider').map((phase) => phase.id),
      shell: impacted.has(shell.id),
      spicedb,
    },
  };
};

const parseArguments = (argumentsList: readonly string[]): PlanDeploymentImpactOptions => {
  let baseRevision: string | undefined;
  const changedPaths: string[] = [];
  let headRevision: string | undefined;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const value = argumentsList[index + 1];
    if (argument === '--') {
      continue;
    }
    if (argument === '--base' && value) {
      baseRevision = value;
      index += 1;
    } else if (argument === '--head' && value) {
      headRevision = value;
      index += 1;
    } else if (argument === '--changed-path' && value) {
      changedPaths.push(value);
      index += 1;
    } else {
      fail(`unsupported or incomplete argument "${argument}"`);
    }
  }
  return {
    baseRevision,
    ...(changedPaths.length > 0 ? { changedPaths } : {}),
    headRevision,
  };
};

const writeGitHubOutputs = (plan: DeploymentImpactPlan, outputPath: string): void => {
  const planJson = JSON.stringify(plan);
  const providersJson = JSON.stringify(plan.units.providers);
  fs.appendFileSync(
    outputPath,
    [
      `any=${String(plan.any)}`,
      `migrator=${String(plan.units.migrator)}`,
      `plan=${planJson}`,
      `providers=${providersJson}`,
      `shell=${String(plan.units.shell)}`,
      `spicedb=${String(plan.units.spicedb)}`,
      '',
    ].join('\n'),
  );
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isDirectExecution) {
  const plan = planDeploymentImpact(parseArguments(process.argv.slice(2)));
  const planJson = JSON.stringify(plan);
  process.stdout.write(`${planJson}\n`);
  if (process.env.GITHUB_OUTPUT) {
    writeGitHubOutputs(plan, process.env.GITHUB_OUTPUT);
  }
}
