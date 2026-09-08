import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  Array as EffectArray,
  Clock,
  Console,
  Config,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Result,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { outboxWorkerDelivery } from './outbox-worker-delivery.mjs';
import type { ProtectedEntrypointInventory } from './authorization/protected-entrypoint-inventory.mts';
import type { AuthorizationRolloutContract } from './authorization/rollout-contract.mts';
import { validateAuthorizationRolloutContract } from './authorization/rollout-contract.mts';
import type {
  AuthorizationNegativeSmokeEvidence,
  AuthorizationReadinessEvidence,
} from './check-authorization-readiness.mts';
import { hashAuthorizationEvidence } from './check-authorization-readiness.mts';
import type { AuthorizationImpactReport } from './report-fail-closed-authorization-impact.mts';

declare global {
  interface ImportMeta {
    readonly main?: boolean;
  }
}

export const DeploymentPhaseKindSchema = Schema.Literals(['infrastructure', 'provider', 'shell']);
export type DeploymentPhaseKind = typeof DeploymentPhaseKindSchema.Type;

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

const TopologyOwnerSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  package: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
});

const ReferenceTopologySchema = Schema.Struct({
  sharedPackages: Schema.optional(Schema.Array(TopologyOwnerSchema)),
  shell: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      package: Schema.optional(Schema.String),
      verticalRefs: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  verticals: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        moduleFederation: Schema.optional(
          Schema.Struct({
            remotes: Schema.optional(
              Schema.Array(Schema.Struct({ id: Schema.optional(Schema.String) })),
            ),
            verticalRefs: Schema.optional(Schema.Array(Schema.String)),
          }),
        ),
        package: Schema.optional(Schema.String),
        path: Schema.optional(Schema.String),
      }),
    ),
  ),
});

type ReferenceTopology = typeof ReferenceTopologySchema.Type;

const OwnershipSchema = Schema.Struct({
  owners: Schema.optional(Schema.Array(TopologyOwnerSchema)),
});

type Ownership = typeof OwnershipSchema.Type;

const AuthorizationEnvironmentSchema = Schema.Literals(['development', 'production', 'stage']);
const AuthorizationModeSchema = Schema.Literals(['enforced', 'report_only']);
const AuthorizationCredentialSchema = Schema.Literals(['api_key', 'session']);
const AuthorizationSurfaceSchema = Schema.Literals([
  'action',
  'capability_issuance',
  'route',
  'worker',
]);
const EntrypointKeySchema = Schema.String.pipe(Schema.brand('EntrypointKey'));
const CanonicalTimestampStringSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value
      ? undefined
      : 'timestamp must use canonical UTC ISO 8601 encoding';
  }),
);
const CanonicalTimestampCodec = CanonicalTimestampStringSchema.pipe(
  Schema.decodeTo(Schema.DateTimeUtcFromString),
);
const CanonicalTimestampWireSchema = Schema.toEncoded(CanonicalTimestampCodec);

export interface DeploymentImpactPlan {
  readonly any: boolean;
  readonly authorization?: {
    readonly environment: 'development' | 'production' | 'stage';
    readonly mode: 'enforced' | 'report_only';
    readonly status: 'observing' | 'ready';
  };
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
  readonly authorizationPromotion?: AuthorizationPromotionGateInput;
  readonly baseRevision?: string;
  readonly changedPaths?: readonly string[];
  readonly headRevision?: string;
  readonly rootDirectory?: string;
}

export interface AuthorizationPromotionGateInput {
  readonly environment: 'development' | 'production' | 'stage';
  readonly impact?: AuthorizationImpactReport;
  readonly inventory: ProtectedEntrypointInventory;
  readonly negativeSmoke?: AuthorizationNegativeSmokeEvidence;
  readonly nowEpochMs: number;
  readonly readiness?: AuthorizationReadinessEvidence;
  readonly rollout: AuthorizationRolloutContract;
}

const InventoryAuthorizationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('public') }),
  Schema.Struct({ kind: Schema.Literal('authenticated_principal') }),
  Schema.Struct({ kind: Schema.Literal('owner_local_background') }),
  Schema.Struct({ kind: Schema.Literal('context_permission'), permission: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('action_execution'),
    provisioning: Schema.Literals(['explicit', 'tenant_membership_default']),
  }),
  Schema.Struct({
    credential: AuthorizationCredentialSchema,
    kind: Schema.Literal('capability_issuance'),
  }),
]);

const ProtectedEntrypointInventorySchema = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      authorization: InventoryAuthorizationSchema,
      deployment: Schema.String,
      entrypointKey: EntrypointKeySchema,
      owner: Schema.String,
      surface: AuthorizationSurfaceSchema,
    }),
  ),
  inventoryHash: Schema.String,
  schemaVersion: Schema.Literal(1),
  sourceRevision: Schema.String,
});

const AuthorizationRolloutContractSchema = Schema.Struct({
  activatedAt: CanonicalTimestampWireSchema,
  baselineInventoryHash: Schema.String,
  baselineSourceRevision: Schema.String,
  compatibilityEligibleEntrypoints: Schema.Array(Schema.String),
  decisionReference: Schema.String,
  expiresAt: CanonicalTimestampWireSchema,
  mode: AuthorizationModeSchema,
  schemaVersion: Schema.Literal(1),
});

const AuthorizationImpactReportSchema = Schema.Struct({
  aggregates: Schema.Array(
    Schema.Struct({
      count: Schema.Number,
      denialReason: Schema.Literals([
        'cross_tenant',
        'expired_credential',
        'infrastructure_unavailable',
        'malformed_credential',
        'missing_policy',
        'module_disabled',
        'replayed_credential',
        'wrong_audience',
      ]),
      entrypointKey: EntrypointKeySchema,
      policyClass: Schema.Literals([
        'action_execution',
        'authenticated_principal',
        'capability_issuance',
        'context_permission',
        'owner_local_background',
        'public',
      ]),
      surface: AuthorizationSurfaceSchema,
    }),
  ),
  inventoryHash: Schema.String,
  observation: Schema.Struct({
    endedAt: CanonicalTimestampWireSchema,
    startedAt: CanonicalTimestampWireSchema,
  }),
  schemaVersion: Schema.Literal(1),
  sourceRevision: Schema.String,
  totalWouldDeny: Schema.Number,
});

const AuthorizationNegativeSmokeEvidenceSchema = Schema.Struct({
  environment: AuthorizationEnvironmentSchema,
  inventoryHash: Schema.String,
  scenarios: Schema.Array(
    Schema.Struct({
      credential: AuthorizationCredentialSchema,
      outcome: Schema.Literal('denied'),
      scenario: Schema.String,
    }),
  ),
  schemaVersion: Schema.Literal(1),
  sourceRevision: Schema.String,
});

const AuthorizationReadinessEvidenceSchema = Schema.Struct({
  approvalReference: Schema.String,
  environment: AuthorizationEnvironmentSchema,
  fixedContextHash: Schema.String,
  impactReportHash: Schema.String,
  inventoryHash: Schema.String,
  moduleStateVersion: Schema.String,
  negativeSmokeHash: Schema.String,
  observation: Schema.Struct({
    endedAt: CanonicalTimestampWireSchema,
    startedAt: CanonicalTimestampWireSchema,
  }),
  policyDataVersion: Schema.String,
  replayMigrationHash: Schema.String,
  schemaVersion: Schema.Literal(1),
  sourceRevision: Schema.String,
  spiceDbSchemaHash: Schema.String,
  status: Schema.Literal('ready'),
  workerOwnershipVersion: Schema.String,
});

const DeploymentPhaseSchema = Schema.Struct({
  id: Schema.String,
  kind: DeploymentPhaseKindSchema,
  serviceIdEnv: Schema.String,
  stageSetup: Schema.String,
});

const DeploymentImpactPlanSchema = Schema.Struct({
  any: Schema.Boolean,
  authorization: Schema.optional(
    Schema.Struct({
      environment: AuthorizationEnvironmentSchema,
      mode: AuthorizationModeSchema,
      status: Schema.Literals(['observing', 'ready']),
    }),
  ),
  changedPaths: Schema.Array(Schema.String),
  comparison: Schema.Struct({
    baseRevision: Schema.optional(Schema.String),
    headRevision: Schema.optional(Schema.String),
    mode: Schema.Literals(['diff', 'full']),
    reason: Schema.optional(Schema.String),
  }),
  phases: Schema.Array(DeploymentPhaseSchema),
  schemaVersion: Schema.Literal(1),
  units: Schema.Struct({
    migrator: Schema.Boolean,
    providers: Schema.Array(Schema.String),
    shell: Schema.Boolean,
    spicedb: Schema.Boolean,
  }),
});

class DeploymentImpactPlanningError extends Schema.TaggedError<DeploymentImpactPlanningError>()(
  'DeploymentImpactPlanningError',
  {
    message: Schema.String,
  },
) {}

const fail = (message: string): never =>
  Result.getOrThrow(
    Result.fail(
      new DeploymentImpactPlanningError({
        message: `Deployment impact planning failed: ${message}`,
      }),
    ),
  );

const requireAuthorizationEvidence = (
  input: AuthorizationPromotionGateInput,
): Required<Pick<AuthorizationPromotionGateInput, 'impact' | 'negativeSmoke' | 'readiness'>> => {
  const { impact, negativeSmoke, readiness } = input;
  if (impact === undefined || negativeSmoke === undefined || readiness === undefined) {
    return fail(
      'enforced authorization promotion requires impact, readiness, and negative-smoke evidence',
    );
  }
  return { impact, negativeSmoke, readiness };
};

type PromotionEvidence = Required<
  Pick<AuthorizationPromotionGateInput, 'impact' | 'negativeSmoke' | 'readiness'>
>;

const evidenceHasInventoryIdentity = (
  inventory: ProtectedEntrypointInventory,
  evidence: {
    readonly inventoryHash: string;
    readonly schemaVersion: number;
    readonly sourceRevision: string;
  },
): boolean =>
  evidence.schemaVersion === 1 &&
  evidence.sourceRevision === inventory.sourceRevision &&
  evidence.inventoryHash === inventory.inventoryHash;

const readinessMatchesPromotion = (
  input: AuthorizationPromotionGateInput,
  evidence: PromotionEvidence,
): boolean => {
  const { impact, negativeSmoke, readiness } = evidence;
  return (
    readiness.status === 'ready' &&
    readiness.environment === input.environment &&
    readiness.impactReportHash === hashAuthorizationEvidence(impact) &&
    readiness.negativeSmokeHash === hashAuthorizationEvidence(negativeSmoke) &&
    readiness.approvalReference === input.rollout.decisionReference
  );
};

const authorizationEvidenceMatches = (
  input: AuthorizationPromotionGateInput,
  evidence: PromotionEvidence,
): boolean =>
  [evidence.impact, evidence.negativeSmoke, evidence.readiness].every((item) =>
    evidenceHasInventoryIdentity(input.inventory, item),
  ) &&
  evidence.impact.totalWouldDeny === 0 &&
  evidence.negativeSmoke.environment === input.environment &&
  readinessMatchesPromotion(input, evidence);

export const validateAuthorizationPromotionGate = (
  input: AuthorizationPromotionGateInput,
): NonNullable<DeploymentImpactPlan['authorization']> => {
  const { inventory, rollout } = input;
  validateAuthorizationRolloutContract(rollout, {
    entrypointKeys: new Set(inventory.entries.map(({ entrypointKey }) => entrypointKey)),
    inventoryHash: inventory.inventoryHash,
    nowEpochMs: input.nowEpochMs,
  });
  if (rollout.mode === 'report_only') {
    if (input.environment === 'production') {
      fail('production authorization promotion rejects report-only configuration');
    }
    return { environment: input.environment, mode: rollout.mode, status: 'observing' };
  }
  if (!authorizationEvidenceMatches(input, requireAuthorizationEvidence(input))) {
    fail('authorization promotion evidence is missing, stale, mismatched, or unresolved');
  }
  return { environment: input.environment, mode: rollout.mode, status: 'ready' };
};

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

const GIT_EXECUTABLE = '/usr/bin/git';

const readJson = <DocumentSchema extends Schema.ConstraintDecoder<unknown>>(
  schema: DocumentSchema,
  filePath: string,
) =>
  Effect.gen(function* readJsonEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* fileSystem.readFileString(filePath);
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(source);
  });

const requireString = (value: string | undefined, area: string): string => {
  if (value === undefined || value.length === 0) {
    return fail(`${area} must be a non-empty string`);
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
    const setup = match.groups?.setup;
    if (setup !== undefined && setup.length > 0) {
      setups.add(setup);
    }
  }
  return setups;
};

type TopologyOwner = typeof TopologyOwnerSchema.Type;
type ReferenceVertical = NonNullable<ReferenceTopology['verticals']>[number];

const indexOwners = (
  ownerEntries: readonly TopologyOwner[],
): ReadonlyMap<string, TopologyOwner> => {
  const ownersById = new Map<string, TopologyOwner>();
  for (const owner of ownerEntries) {
    const ownerId = requireString(owner.id, 'ownership owner.id');
    if (ownersById.has(ownerId)) {
      fail(`topology/ownership.json contains duplicate owner identity "${ownerId}"`);
    }
    ownersById.set(ownerId, owner);
  }
  return ownersById;
};

const readShellUnit = (
  topology: ReferenceTopology,
  ownersById: ReadonlyMap<string, TopologyOwner>,
): Omit<TopologyUnit, 'dependencies'> => {
  const shellId = requireString(topology.shell?.id, 'reference topology shell.id');
  const shellPackage = requireString(topology.shell?.package, 'reference topology shell.package');
  const shellOwner = ownersById.get(shellId);
  if (shellOwner === undefined) {
    return fail(`topology delivery unit "${shellId}" is missing from topology/ownership.json`);
  }
  const shellPath = requireString(shellOwner.path, `ownership owner ${shellId}.path`);
  if (shellOwner.package !== shellPackage) {
    fail(
      `topology and ownership disagree for "${shellId}": topology package "${shellPackage}" versus ownership package "${String(shellOwner.package)}"`,
    );
  }
  return {
    id: shellId,
    kind: 'shell',
    packageName: shellPackage,
    path: shellPath,
    serviceIdEnv: 'ZEROPS_SHELL_SERVICE_ID',
    stageSetup: shellId.replaceAll('-', ''),
  };
};

const collectVerticalIds = (verticals: readonly ReferenceVertical[]): ReadonlySet<string> => {
  const verticalIds = new Set<string>();
  for (const vertical of verticals) {
    const verticalId = requireString(vertical.id, 'reference topology vertical.id');
    if (verticalIds.has(verticalId)) {
      fail(`reference topology contains duplicate vertical identity "${verticalId}"`);
    }
    verticalIds.add(verticalId);
  }
  return verticalIds;
};

const validateSharedPackages = (
  sharedPackages: readonly TopologyOwner[],
  ownersById: ReadonlyMap<string, TopologyOwner>,
): ReadonlySet<string> => {
  const sharedPackageIds = new Set<string>();
  for (const sharedPackage of sharedPackages) {
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
    if (owner === undefined) {
      return fail(`topology shared package "${id}" is missing from topology/ownership.json`);
    }
    if (owner.package !== packageName || owner.path !== ownerPath) {
      fail(
        `topology and ownership disagree for shared package "${id}": expected package "${packageName}" at "${ownerPath}", found package "${String(owner.package)}" at "${String(owner.path)}"`,
      );
    }
  }
  return sharedPackageIds;
};

const validateDistinctTopologyIds = (
  shellId: string,
  verticalIds: ReadonlySet<string>,
  sharedPackageIds: ReadonlySet<string>,
): void => {
  for (const id of [shellId, ...verticalIds]) {
    if (sharedPackageIds.has(id)) {
      fail(`reference topology reuses delivery identity "${id}" for a shared package`);
    }
  }
};

const verticalDependencies = (
  vertical: ReferenceVertical,
  id: string,
  verticalIds: ReadonlySet<string>,
): readonly string[] => {
  const dependencies = [
    ...(vertical.moduleFederation?.verticalRefs ?? []),
    ...(vertical.moduleFederation?.remotes ?? []).flatMap((remote) =>
      remote.id === undefined ? [] : [remote.id],
    ),
  ];
  for (const dependency of dependencies) {
    if (!verticalIds.has(dependency)) {
      fail(`topology delivery unit "${id}" references unknown provider "${dependency}"`);
    }
  }
  return dependencies;
};

const buildVerticalUnits = (
  verticals: readonly ReferenceVertical[],
  verticalIds: ReadonlySet<string>,
  ownersById: ReadonlyMap<string, TopologyOwner>,
): readonly TopologyUnit[] => {
  const units: TopologyUnit[] = [];
  for (const vertical of verticals) {
    const id = requireString(vertical.id, 'reference topology vertical.id');
    const packageName = requireString(
      vertical.package,
      `reference topology vertical ${id}.package`,
    );
    const ownerPath = requireString(vertical.path, `reference topology vertical ${id}.path`);
    const owner = ownersById.get(id);
    if (owner === undefined) {
      return fail(`topology delivery unit "${id}" is missing from topology/ownership.json`);
    }
    if (owner.package !== packageName || owner.path !== ownerPath) {
      fail(
        `topology and ownership disagree for "${id}": expected package "${packageName}" at "${ownerPath}", found package "${String(owner.package)}" at "${String(owner.path)}"`,
      );
    }
    const dependencies = verticalDependencies(vertical, id, verticalIds);
    units.push({
      dependencies: EffectArray.sort([...new Set(dependencies)], Order.String),
      id,
      kind: 'provider',
      packageName,
      path: ownerPath,
      serviceIdEnv: `ZEROPS_${toEnvironmentSegment(id)}_SERVICE_ID`,
      stageSetup: id,
    });
  }
  return units;
};

const addShellUnit = (
  units: readonly TopologyUnit[],
  shell: Omit<TopologyUnit, 'dependencies'>,
  shellDependencies: readonly string[],
  verticalIds: ReadonlySet<string>,
): readonly TopologyUnit[] => {
  for (const dependency of shellDependencies) {
    if (!verticalIds.has(dependency)) {
      fail(`topology shell "${shell.id}" references unknown provider "${dependency}"`);
    }
  }
  return [
    ...units,
    {
      dependencies: EffectArray.sort([...new Set(shellDependencies)], Order.String),
      ...shell,
    },
  ];
};

const validateOwnershipCoverage = (
  ownerEntries: readonly TopologyOwner[],
  topologyOwnerIds: ReadonlySet<string>,
): void => {
  for (const owner of ownerEntries) {
    const id = requireString(owner.id, 'ownership owner.id');
    const ownerPath = requireString(owner.path, `ownership owner ${id}.path`);
    if (/^(?:apps|packages|verticals)\//u.test(ownerPath) && !topologyOwnerIds.has(id)) {
      fail(`ownership entry "${id}" at "${ownerPath}" has no matching topology identity`);
    }
  }
};

const validateStageSetupCoverage = (
  units: readonly TopologyUnit[],
  stageSetups: ReadonlySet<string>,
): void => {
  for (const phase of [...Object.values(INFRASTRUCTURE_PHASES), ...units]) {
    if (!stageSetups.has(phase.stageSetup)) {
      fail(
        `topology delivery unit "${phase.id}" has unsupported stage setup "${phase.stageSetup}" in zerops.yaml`,
      );
    }
  }
};

const buildTopologyUnits = (
  topology: ReferenceTopology,
  ownership: Ownership,
  stageSetups: ReadonlySet<string>,
): readonly TopologyUnit[] => {
  const ownerEntries = ownership.owners ?? [];
  const ownersById = indexOwners(ownerEntries);
  const shell = readShellUnit(topology, ownersById);
  const verticals = topology.verticals ?? [];
  const verticalIds = collectVerticalIds(verticals);
  const sharedPackageIds = validateSharedPackages(topology.sharedPackages ?? [], ownersById);
  validateDistinctTopologyIds(shell.id, verticalIds, sharedPackageIds);
  const units = addShellUnit(
    buildVerticalUnits(verticals, verticalIds, ownersById),
    shell,
    topology.shell?.verticalRefs ?? [],
    verticalIds,
  );
  validateOwnershipCoverage(ownerEntries, new Set([shell.id, ...verticalIds, ...sharedPackageIds]));
  validateStageSetupCoverage(units, stageSetups);
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
    if (unit === undefined) {
      return fail(`topology delivery dependencies reference unknown unit "${id}"`);
    }
    visiting.add(id);
    for (const dependency of unit.dependencies) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(unit);
  };
  for (const unit of EffectArray.sortWith(units, (candidate) => candidate.id, Order.String)) {
    visit(unit.id);
  }
  return ordered;
};

const invalidBaseReason = (
  rootDirectory: string,
  baseRevision: string | undefined,
  headRevision: string,
) =>
  Effect.gen(function* invalidBaseReasonEffect() {
    if (baseRevision === undefined || baseRevision.length === 0 || /^0+$/u.test(baseRevision)) {
      return 'comparison base is unavailable or all-zero';
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const revisionExists = yield* spawner
      .exitCode(
        ChildProcess.make(GIT_EXECUTABLE, ['cat-file', '-e', `${baseRevision}^{commit}`], {
          cwd: rootDirectory,
          stderr: 'ignore',
          stdout: 'ignore',
        }),
      )
      .pipe(
        Effect.map((exitCode) => exitCode === 0),
        Effect.catch(() => Effect.succeed(false)),
      );
    if (!revisionExists) {
      return `comparison base "${baseRevision}" is unavailable`;
    }
    const isAncestor = yield* spawner
      .exitCode(
        ChildProcess.make(
          GIT_EXECUTABLE,
          ['merge-base', '--is-ancestor', baseRevision, headRevision],
          { cwd: rootDirectory, stderr: 'ignore', stdout: 'ignore' },
        ),
      )
      .pipe(
        Effect.map((exitCode) => exitCode === 0),
        Effect.catch(() => Effect.succeed(false)),
      );
    if (!isAncestor) {
      return `comparison base "${baseRevision}" is not an ancestor of "${headRevision}"`;
    }
    return yield* Effect.undefined;
  });

const changedPathsFromGit = (rootDirectory: string, baseRevision: string, headRevision: string) =>
  Effect.gen(function* changedPathsFromGitEffect() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = yield* spawner.string(
      ChildProcess.make(
        GIT_EXECUTABLE,
        ['diff', '--name-only', '--no-renames', '-z', baseRevision, headRevision],
        { cwd: rootDirectory },
      ),
    );
    return output.split('\0').filter(Boolean);
  });

const isMigrationChange = (changedPath: string): boolean =>
  /(?:^|\/)(?:drizzle(?:-auth)?\/|drizzle(?:\.auth)?\.config\.ts$|schema\.ts$|prepare-[^/]+-migration\.mts$|verify-(?:auth-)?db-schema\.mts$)/u.test(
    changedPath,
  ) ||
  /^(?:scripts\/run-zerops-migrator\.mjs|scripts\/verify-application-db-schema\.mts|scripts\/postgres\/(?:bootstrap-runtime-role\.mts|bootstrap-spicedb-database\.mts|docker-init-runtime-role\.sh))$/u.test(
    changedPath,
  ) ||
  changedPath === 'packages/core-runtime/src/install/spicedb-database-config.ts';

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
  changedPath === 'packages/core-runtime/src/install/spicedb-database-config.ts' ||
  changedPath === 'scripts/postgres/bootstrap-spicedb-database.mts' ||
  changedPath === 'scripts/run-zerops-spicedb.sh';

const isAuthorizationRolloutChange = (changedPath: string): boolean =>
  changedPath.startsWith('packages/core-runtime/src/authorization/') ||
  changedPath.startsWith('packages/core-runtime/src/auth/gateway-assertion-redemption') ||
  changedPath.startsWith('scripts/authorization/') ||
  changedPath === 'scripts/check-authorization-readiness.mts' ||
  changedPath === 'scripts/check-module-entrypoint-boundaries.mts' ||
  changedPath === 'scripts/provision-current-action-authorization.mts' ||
  changedPath === 'scripts/report-fail-closed-authorization-impact.mts' ||
  changedPath === 'topology/authorization-rollout.json';

const CONSERVATIVE_FULL_DEPLOY_PATHS = new Set([
  '.mise.toml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/install-zerops-node.sh',
  'scripts/generate-outbox-worker-deployment.mjs',
  'scripts/materialize-outbox-worker.mjs',
  'scripts/materialize-zerops-runtime.mjs',
  'scripts/outbox-worker-delivery.mjs',
  'zerops.yaml',
]);
const isConservativeFullDeployChange = (changedPath: string): boolean =>
  CONSERVATIVE_FULL_DEPLOY_PATHS.has(changedPath) || changedPath.startsWith('topology/');

const toPhase = (unit: TopologyUnit): DeploymentPhase => ({
  id: unit.id,
  kind: unit.kind,
  serviceIdEnv: unit.serviceIdEnv,
  stageSetup: unit.stageSetup,
});

const makeComparison = (
  options: PlanDeploymentImpactOptions,
  headRevision: string,
  fallbackReason: string | undefined,
): DeploymentImpactPlan['comparison'] => {
  const mode = fallbackReason === undefined ? 'diff' : 'full';
  if (options.baseRevision === undefined) {
    return fallbackReason === undefined
      ? { headRevision, mode }
      : { headRevision, mode, reason: fallbackReason };
  }
  return fallbackReason === undefined
    ? { baseRevision: options.baseRevision, headRevision, mode }
    : { baseRevision: options.baseRevision, headRevision, mode, reason: fallbackReason };
};

interface DeploymentImpactState {
  readonly impacted: Set<string>;
  migrator: boolean;
  spicedb: boolean;
}

const addAllUnits = (impacted: Set<string>, orderedUnits: readonly TopologyUnit[]): void => {
  for (const unit of orderedUnits) {
    impacted.add(unit.id);
  }
};

const addWithConsumers = (
  unitId: string,
  impacted: Set<string>,
  orderedUnits: readonly TopologyUnit[],
): void => {
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

const applyOwnedPathImpact = (
  changedPath: string,
  ownerEntries: readonly TopologyOwner[],
  unitsById: ReadonlyMap<string, TopologyUnit>,
  orderedUnits: readonly TopologyUnit[],
  impacted: Set<string>,
): void => {
  if (!/^(?:apps|packages|verticals)\//u.test(changedPath)) {
    return;
  }
  const [owner] = EffectArray.sortWith(
    ownerEntries.filter((entry) => entry.path !== undefined && isWithin(changedPath, entry.path)),
    (entry) => String(entry.path).length,
    Order.flip(Order.Number),
  );
  if (owner === undefined) {
    const [area] = changedPath.split('/');
    fail(`unknown changed path "${changedPath}" in application area "${area}"`);
  }
  const ownerId = requireString(owner.id, `owner for changed path ${changedPath}`);
  const topologyUnit = unitsById.get(ownerId);
  if (topologyUnit !== undefined) {
    impacted.add(ownerId);
    if (isPublicContractChange(topologyUnit.path, changedPath)) {
      addWithConsumers(ownerId, impacted, orderedUnits);
    }
  } else if (changedPath.startsWith('packages/')) {
    addAllUnits(impacted, orderedUnits);
  } else {
    fail(`changed path "${changedPath}" maps to non-delivery owner "${ownerId}"`);
  }
};

const applyChangedPathImpact = (
  changedPath: string,
  ownerEntries: readonly TopologyOwner[],
  unitsById: ReadonlyMap<string, TopologyUnit>,
  orderedUnits: readonly TopologyUnit[],
  state: DeploymentImpactState,
): void => {
  applyOwnedPathImpact(changedPath, ownerEntries, unitsById, orderedUnits, state.impacted);
  if (isMigrationChange(changedPath)) {
    state.migrator = true;
  }
  if (isSpiceDbChange(changedPath)) {
    state.spicedb = true;
    addAllUnits(state.impacted, orderedUnits);
  }
  if (isAuthorizationRolloutChange(changedPath)) {
    state.migrator = true;
    state.spicedb = true;
    addAllUnits(state.impacted, orderedUnits);
  }
  if (isConservativeFullDeployChange(changedPath)) {
    state.migrator = true;
    state.spicedb = true;
    addAllUnits(state.impacted, orderedUnits);
  }
};

const deriveDeploymentImpact = (
  changedPaths: readonly string[],
  fullDeploy: boolean,
  ownerEntries: readonly TopologyOwner[],
  orderedUnits: readonly TopologyUnit[],
): DeploymentImpactState => {
  const state: DeploymentImpactState = {
    impacted: new Set<string>(),
    migrator: fullDeploy,
    spicedb: fullDeploy,
  };
  if (fullDeploy) {
    addAllUnits(state.impacted, orderedUnits);
    return state;
  }
  const unitsById = new Map(orderedUnits.map((unit) => [unit.id, unit]));
  for (const changedPath of changedPaths) {
    applyChangedPathImpact(changedPath, ownerEntries, unitsById, orderedUnits, state);
  }
  return state;
};

const deploymentComparison = (options: PlanDeploymentImpactOptions, rootDirectory: string) =>
  Effect.gen(function* deploymentComparisonEffect() {
    const headRevision = options.headRevision ?? 'HEAD';
    const fallbackReason =
      options.changedPaths === undefined
        ? yield* invalidBaseReason(rootDirectory, options.baseRevision, headRevision)
        : undefined;
    const fullDeploy = fallbackReason !== undefined;
    const comparedPaths =
      options.changedPaths ??
      (fullDeploy
        ? []
        : yield* changedPathsFromGit(
            rootDirectory,
            requireString(options.baseRevision, 'base revision'),
            headRevision,
          ));
    const changedPaths = EffectArray.sort(
      [...new Set(comparedPaths.map(normalizeChangedPath))],
      Order.String,
    );
    return { changedPaths, fallbackReason, fullDeploy, headRevision };
  });

const validateWorkerStageSetups = (
  workers: readonly { readonly stageSetup: string }[],
  stageSetups: ReadonlySet<string>,
): void => {
  for (const delivery of workers) {
    if (!stageSetups.has(delivery.stageSetup)) {
      fail(`Missing generated worker setup ${delivery.stageSetup}`);
    }
  }
};

export const planDeploymentImpact = (options: PlanDeploymentImpactOptions = {}) =>
  Effect.gen(function* planDeploymentImpactEffect() {
    const authorization =
      options.authorizationPromotion === undefined
        ? undefined
        : validateAuthorizationPromotionGate(options.authorizationPromotion);
    const pathService = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const rootDirectory =
      options.rootDirectory ?? (yield* Config.string('PWD').pipe(Effect.orElseSucceed(() => '.')));
    const topology = yield* readJson(
      ReferenceTopologySchema,
      pathService.join(rootDirectory, 'topology/reference-topology.json'),
    );
    const ownership = yield* readJson(
      OwnershipSchema,
      pathService.join(rootDirectory, 'topology/ownership.json'),
    );
    const stageSetups = parseStageSetups(
      yield* fileSystem.readFileString(pathService.join(rootDirectory, 'zerops.yaml')),
    );
    const orderedUnits = orderUnits(buildTopologyUnits(topology, ownership, stageSetups));
    const workerDeliveries = yield* Effect.all(
      (topology.verticals ?? []).map((vertical) =>
        outboxWorkerDelivery(rootDirectory, {
          id: requireString(vertical.id, 'vertical id'),
          package: requireString(vertical.package, 'vertical package'),
          path: requireString(vertical.path, 'vertical path'),
        }),
      ),
    );
    const workers = workerDeliveries.filter((delivery) => delivery !== undefined);
    validateWorkerStageSetups(workers, stageSetups);
    const shell = orderedUnits.find((unit) => unit.kind === 'shell');
    if (shell === undefined) {
      return fail('reference topology has no Shell delivery unit');
    }

    const { changedPaths, fallbackReason, fullDeploy, headRevision } = yield* deploymentComparison(
      options,
      rootDirectory,
    );

    const { impacted, migrator, spicedb } = deriveDeploymentImpact(
      changedPaths,
      fullDeploy,
      ownership.owners ?? [],
      orderedUnits,
    );

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
      ...selectedUnits.filter((unit) => unit.kind === 'shell').map(toPhase),
    );

    const plan: DeploymentImpactPlan = {
      any: phases.length > 0,
      changedPaths,
      comparison: makeComparison(options, headRevision, fallbackReason),
      phases,
      schemaVersion: 1,
      units: {
        migrator,
        providers: phases.filter((phase) => phase.kind === 'provider').map((phase) => phase.id),
        shell: impacted.has(shell.id),
        spicedb,
      },
    };
    return authorization === undefined ? plan : { ...plan, authorization };
  });

const loadAuthorizationPromotionGate = (
  rootDirectory: string,
  environment: AuthorizationPromotionGateInput['environment'],
  nowEpochMs: number,
) =>
  Effect.gen(function* loadAuthorizationPromotionGateEffect() {
    const pathService = yield* Path.Path;
    const reportDirectory = pathService.join(rootDirectory, '.codex/reports/authorization');
    const rollout = yield* readJson(
      AuthorizationRolloutContractSchema,
      pathService.join(rootDirectory, 'topology/authorization-rollout.json'),
    );
    const inventory = yield* readJson(
      ProtectedEntrypointInventorySchema,
      pathService.join(reportDirectory, 'protected-entrypoints.json'),
    );
    if (rollout.mode === 'report_only') {
      return { environment, inventory, nowEpochMs, rollout };
    }
    return {
      environment,
      impact: yield* readJson(
        AuthorizationImpactReportSchema,
        pathService.join(reportDirectory, 'fail-closed-impact.json'),
      ),
      inventory,
      negativeSmoke: yield* readJson(
        AuthorizationNegativeSmokeEvidenceSchema,
        pathService.join(reportDirectory, `negative-smoke.${environment}.json`),
      ),
      nowEpochMs,
      readiness: yield* readJson(
        AuthorizationReadinessEvidenceSchema,
        pathService.join(reportDirectory, 'readiness.json'),
      ),
      rollout,
    };
  });

const PlanJsonSchema = Schema.fromJsonString(DeploymentImpactPlanSchema);
const ProvidersJsonSchema = Schema.fromJsonString(Schema.Array(Schema.String));

const writeGitHubOutputs = (plan: DeploymentImpactPlan, outputPath: string) =>
  Effect.gen(function* writeGitHubOutputsEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const planJson = yield* Schema.encodeEffect(PlanJsonSchema)(plan);
    const providersJson = yield* Schema.encodeEffect(ProvidersJsonSchema)(plan.units.providers);
    const output = [
      `any=${String(plan.any)}`,
      `migrator=${String(plan.units.migrator)}`,
      `plan=${planJson}`,
      `providers=${providersJson}`,
      `shell=${String(plan.units.shell)}`,
      `spicedb=${String(plan.units.spicedb)}`,
      '',
    ].join('\n');
    yield* fileSystem.writeFileString(outputPath, output, { flag: 'a' });
  });

const parseAuthorizationNow = (value: string) =>
  Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(value).pipe(
    Effect.map(DateTime.toEpochMillis),
  );

const deploymentImpactCommand = Command.make(
  'plan-deployment-impact',
  {
    authorizationEnvironment: Flag.choice('authorization-environment', [
      'development',
      'production',
      'stage',
    ]).pipe(Flag.optional),
    authorizationNow: Flag.string('authorization-now').pipe(Flag.optional),
    baseRevision: Flag.string('base').pipe(Flag.optional),
    changedPaths: Flag.string('changed-path').pipe(Flag.atLeast(0)),
    headRevision: Flag.string('head').pipe(Flag.optional),
  },
  ({ authorizationEnvironment, authorizationNow, baseRevision, changedPaths, headRevision }) =>
    Effect.gen(function* deploymentImpactCommandEffect() {
      const rootDirectory = yield* Config.string('PWD').pipe(Effect.orElseSucceed(() => '.'));
      const environment = Option.getOrUndefined(authorizationEnvironment);
      let authorizationPromotion: AuthorizationPromotionGateInput | undefined;
      if (environment !== undefined) {
        const configuredNow = Option.getOrUndefined(authorizationNow);
        const nowEpochMs =
          configuredNow === undefined
            ? yield* Clock.currentTimeMillis
            : yield* parseAuthorizationNow(configuredNow);
        authorizationPromotion = yield* loadAuthorizationPromotionGate(
          rootDirectory,
          environment,
          nowEpochMs,
        );
      }
      const options: PlanDeploymentImpactOptions = {
        baseRevision: Option.getOrUndefined(baseRevision),
        changedPaths: changedPaths.length === 0 ? undefined : changedPaths,
        headRevision: Option.getOrUndefined(headRevision),
        rootDirectory,
      };
      const plan =
        authorizationPromotion === undefined
          ? yield* planDeploymentImpact(options)
          : yield* planDeploymentImpact({ ...options, authorizationPromotion });
      const planJson = yield* Schema.encodeEffect(PlanJsonSchema)(plan);
      yield* Console.log(planJson);
      const outputPath = yield* Config.option(Config.string('GITHUB_OUTPUT'));
      if (Option.isSome(outputPath)) {
        yield* writeGitHubOutputs(plan, outputPath.value);
      }
    }),
);

export const main = Command.run({ version: '1.0.0' })(deploymentImpactCommand);

if (import.meta.main === true) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(NodeServices.layer))).pipe(
      Effect.scoped,
    ),
  );
}
