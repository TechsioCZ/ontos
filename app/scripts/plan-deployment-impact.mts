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
import { parse as parseYaml } from 'yaml';

import type { ProtectedEntrypointInventory } from './authorization/protected-entrypoint-inventory.mts';
import type { AuthorizationRolloutContract } from './authorization/rollout-contract.mts';
import { validateAuthorizationRolloutContract } from './authorization/rollout-contract.mts';
import type {
  AuthorizationNegativeSmokeEvidence,
  AuthorizationReadinessEvidence,
} from './check-authorization-readiness.mts';
import { hashAuthorizationEvidence } from './check-authorization-readiness.mts';
import { outboxWorkerDelivery } from './outbox-worker-delivery.mjs';
import type { AuthorizationImpactReport } from './report-fail-closed-authorization-impact.mts';

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

/** A delivery unit CI deploys to Cloudflare Workers, in dependency order. */
export interface CloudflareDeployment {
  readonly id: string;
  readonly packageName: string;
  readonly workerName: string;
}

/** A Worker placement retired; the edge deploy reports it, through the Shell's Wrangler, until deleted. */
export interface CloudflareRetirement {
  readonly packageName: string;
  readonly workerName: string;
}

const CloudflareWorkerSchema = Schema.optional(Schema.Struct({ workerName: Schema.optional(Schema.String) }));

const TopologyOwnerSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  package: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
});

const ReferenceTopologySchema = Schema.Struct({
  sharedPackages: Schema.optional(Schema.Array(TopologyOwnerSchema)),
  shell: Schema.optional(
    Schema.Struct({
      cloudflare: CloudflareWorkerSchema,
      id: Schema.optional(Schema.String),
      package: Schema.optional(Schema.String),
      verticalRefs: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  verticals: Schema.optional(
    Schema.Array(
      Schema.Struct({
        cloudflare: CloudflareWorkerSchema,
        id: Schema.optional(Schema.String),
        moduleFederation: Schema.optional(
          Schema.Struct({
            remotes: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.optional(Schema.String) }))),
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

// Which delivery units ship as Cloudflare Workers. The topology names each unit's Worker; placement
// decides which of them CI deploys, so moving a unit to the edge is one reviewed topology change.
// `buildEnvironment` is the non-secret configuration the placed units' Cloudflare builds read
// (public URLs, Worker binding names, the Shell origin). Keeping it in the reviewed document makes
// every change to it a topology change, which replans every unit, so no Worker keeps a stale build.
const CLOUDFLARE_BUILD_VARIABLE_PATTERN = /^(?:MODERN|ULTRAMODERN|VERTICAL)_[A-Z0-9_]+$/u;
// The deploy job sets these from the run itself; reviewed configuration must not override the
// revision or environment a Worker build claims.
// A Worker's name and its service-binding name are topology identity: the Shell binds each provider
// by Worker name, and every consumer (the Shell's discovery, Commerce's routed fetch) calls the
// topology binding name. An override would bind a Worker CI never deploys, or a name no caller uses.
const WORKER_IDENTITY_OVERRIDE_PATTERN = /^VERTICAL_[A-Z0-9_]+_WORKER_(?:NAME|BINDING)$/u;
const RESERVED_CLOUDFLARE_BUILD_VARIABLES: ReadonlySet<string> = new Set([
  'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
  'ULTRAMODERN_SOURCE_REVISION',
]);
const CloudflarePlacementSchema = Schema.Struct({
  buildEnvironment: Schema.Record(Schema.String, Schema.String),
  // Workers an earlier placement deployed and this one no longer names. The planner refuses a
  // placement that drops a Worker without listing it. Retirement is two-phase: the Worker keeps
  // running through the deploy that drops it, so rollbacks still find it, and each later successful
  // edge deploy reports it until an operator deletes it.
  retiredWorkers: Schema.Array(Schema.String),
  schemaVersion: Schema.Literal(1),
  units: Schema.Array(Schema.String),
  // Placed units that call other placed units through Worker service bindings, by consumer. A
  // binding must name a Worker that already exists, so each target deploys before its consumer.
  unitServiceBindings: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
});
type CloudflarePlacement = typeof CloudflarePlacementSchema.Type;
const CLOUDFLARE_PLACEMENT_PATH = 'topology/cloudflare-placement.json';
// Repository-root inputs of the edge deploy itself: a change to how Workers are built or deployed
// replans every placed unit, even when no unit's source changed.
const CLOUDFLARE_DEPLOY_INPUT_PATHS: ReadonlySet<string> = new Set([
  '.github/actions/install-app/action.yml',
  '.github/workflows/ultramodern-workspace-gates.yml',
]);

const AuthorizationEnvironmentSchema = Schema.Literals(['development', 'production', 'stage']);
const AuthorizationModeSchema = Schema.Literals(['enforced', 'report_only']);
const AuthorizationCredentialSchema = Schema.Literals(['api_key', 'session']);
const AuthorizationSurfaceSchema = Schema.Literals(['action', 'capability_issuance', 'route', 'worker']);
const EntrypointKeySchema = Schema.String.pipe(Schema.brand('EntrypointKey'));
const CanonicalTimestampStringSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value
      ? undefined
      : 'timestamp must use canonical UTC ISO 8601 encoding';
  }),
);
const CanonicalTimestampCodec = CanonicalTimestampStringSchema.pipe(Schema.decodeTo(Schema.DateTimeUtcFromString));
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
  };
  readonly phases: readonly DeploymentPhase[];
  readonly schemaVersion: 1;
  readonly units: {
    readonly cloudflare: readonly CloudflareDeployment[];
    readonly cloudflareRetirements: readonly CloudflareRetirement[];
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
  /**
   * The last successful edge deployment, for retirement checks. Defaults to `baseRevision`; a full
   * plan passes it on its own so removals are still reconciled.
   */
  readonly placementBaseRevision?: string;
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
  Schema.Struct({
    kind: Schema.Literal('context_permission'),
    permission: Schema.String,
  }),
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
  businessPermissions: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      owner: Schema.String,
    }),
  ),
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
  schemaVersion: Schema.Literal(2),
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
  }),
  phases: Schema.Array(DeploymentPhaseSchema),
  schemaVersion: Schema.Literal(1),
  units: Schema.Struct({
    cloudflare: Schema.Array(
      Schema.Struct({ id: Schema.String, packageName: Schema.String, workerName: Schema.String }),
    ),
    cloudflareRetirements: Schema.Array(Schema.Struct({ packageName: Schema.String, workerName: Schema.String })),
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
    return fail('enforced authorization promotion requires impact, readiness, and negative-smoke evidence');
  }
  return { impact, negativeSmoke, readiness };
};

type PromotionEvidence = Required<Pick<AuthorizationPromotionGateInput, 'impact' | 'negativeSmoke' | 'readiness'>>;

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

const readinessMatchesPromotion = (input: AuthorizationPromotionGateInput, evidence: PromotionEvidence): boolean => {
  const { impact, negativeSmoke, readiness } = evidence;
  return (
    readiness.status === 'ready' &&
    readiness.environment === input.environment &&
    readiness.impactReportHash === hashAuthorizationEvidence(impact) &&
    readiness.negativeSmokeHash === hashAuthorizationEvidence(negativeSmoke) &&
    readiness.approvalReference === input.rollout.decisionReference
  );
};

const authorizationEvidenceMatches = (input: AuthorizationPromotionGateInput, evidence: PromotionEvidence): boolean =>
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
    return {
      environment: input.environment,
      mode: rollout.mode,
      status: 'observing',
    };
  }
  if (!authorizationEvidenceMatches(input, requireAuthorizationEvidence(input))) {
    fail('authorization promotion evidence is missing, stale, mismatched, or unresolved');
  }
  return {
    environment: input.environment,
    mode: rollout.mode,
    status: 'ready',
  };
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
const PACKAGE_MANIFEST = 'package.json';
const WORKSPACE_MANIFEST = 'pnpm-workspace.yaml';

const readJson = <DocumentSchema extends Schema.ConstraintDecoder<unknown>>(schema: DocumentSchema, filePath: string) =>
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
  for (const match of zeropsSource.matchAll(/^\s*-\s+setup:\s*['"]?(?<setup>[^'"\s]+)['"]?\s*$/gmu)) {
    const setup = match.groups?.setup;
    if (setup !== undefined && setup.length > 0) {
      setups.add(setup);
    }
  }
  return setups;
};

type TopologyOwner = typeof TopologyOwnerSchema.Type;
type ReferenceVertical = NonNullable<ReferenceTopology['verticals']>[number];

const indexOwners = (ownerEntries: readonly TopologyOwner[]): ReadonlyMap<string, TopologyOwner> => {
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
    const packageName = requireString(sharedPackage.package, `reference topology shared package ${id}.package`);
    const ownerPath = requireString(sharedPackage.path, `reference topology shared package ${id}.path`);
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
    ...(vertical.moduleFederation?.remotes ?? []).flatMap((remote) => (remote.id === undefined ? [] : [remote.id])),
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
    const packageName = requireString(vertical.package, `reference topology vertical ${id}.package`);
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

const validateStageSetupCoverage = (units: readonly TopologyUnit[], stageSetups: ReadonlySet<string>): void => {
  for (const phase of [...Object.values(INFRASTRUCTURE_PHASES), ...units]) {
    if (!stageSetups.has(phase.stageSetup)) {
      fail(`topology delivery unit "${phase.id}" has unsupported stage setup "${phase.stageSetup}" in zerops.yaml`);
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

const cloudflareWorkerNames = (topology: ReferenceTopology): ReadonlyMap<string, string> =>
  new Map(
    [topology.shell, ...(topology.verticals ?? [])].flatMap((unit) =>
      unit?.id === undefined || unit.cloudflare?.workerName === undefined
        ? []
        : [[unit.id, unit.cloudflare.workerName] as const],
    ),
  );

// Only build variables reach the Cloudflare builds; credentials stay out of the reviewed document.
const validateCloudflareBuildEnvironment = (buildEnvironment: Readonly<Record<string, string>>): void => {
  for (const key of Object.keys(buildEnvironment)) {
    if (!CLOUDFLARE_BUILD_VARIABLE_PATTERN.test(key)) {
      fail(
        `${CLOUDFLARE_PLACEMENT_PATH} buildEnvironment key "${key}" must be a MODERN_, ULTRAMODERN_ or VERTICAL_ build variable`,
      );
    }
    if (WORKER_IDENTITY_OVERRIDE_PATTERN.test(key)) {
      fail(
        `${CLOUDFLARE_PLACEMENT_PATH} buildEnvironment must not set "${key}"; a Worker's name and service binding are its topology cloudflare.workerName and workerDispatch.serviceBinding`,
      );
    }
    if (RESERVED_CLOUDFLARE_BUILD_VARIABLES.has(key)) {
      fail(`${CLOUDFLARE_PLACEMENT_PATH} buildEnvironment must not set "${key}"; the deploy job sets it from the run`);
    }
  }
};

const placedWorkerNames = (units: readonly string[], topology: ReferenceTopology): ReadonlySet<string> => {
  const workerNames = cloudflareWorkerNames(topology);
  return new Set(units.flatMap((id) => workerNames.get(id) ?? []));
};

/**
 * Workers placement retires. A Worker placed or retired at the last edge deployment and not placed
 * now must be listed in `retiredWorkers`, so a removal or rename never leaves the old Worker
 * serving unreported. The list is a ledger: entries are never removed.
 */
const planCloudflareRetirements = (
  placement: CloudflarePlacement,
  topology: ReferenceTopology,
  basePlacedWorkers: ReadonlySet<string>,
  shellPackageName: string,
): readonly CloudflareRetirement[] => {
  const placedWorkers = placedWorkerNames(placement.units, topology);
  const retired = new Set(placement.retiredWorkers);
  for (const workerName of retired) {
    if (placedWorkers.has(workerName)) {
      fail(`${CLOUDFLARE_PLACEMENT_PATH} retires "${workerName}", which a placed unit still deploys`);
    }
  }
  for (const workerName of basePlacedWorkers) {
    if (!placedWorkers.has(workerName) && !retired.has(workerName)) {
      fail(
        `${CLOUDFLARE_PLACEMENT_PATH} no longer places or retires Worker "${workerName}"; keep it in retiredWorkers`,
      );
    }
  }
  return EffectArray.sort([...retired], Order.String).map((workerName) => ({
    packageName: shellPackageName,
    workerName,
  }));
};

/**
 * Orders placed providers so every service-binding target deploys before the unit that binds it,
 * keeping the topology order otherwise.
 */
const orderByServiceBindings = (
  providers: readonly TopologyUnit[],
  unitServiceBindings: Readonly<Record<string, readonly string[]>>,
): readonly TopologyUnit[] => {
  const byId = new Map(providers.map((unit) => [unit.id, unit]));
  const ordered: TopologyUnit[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (unit: TopologyUnit): void => {
    if (visited.has(unit.id)) {
      return;
    }
    if (visiting.has(unit.id)) {
      fail(`${CLOUDFLARE_PLACEMENT_PATH} unitServiceBindings contain a cycle at "${unit.id}"`);
    }
    visiting.add(unit.id);
    for (const target of unitServiceBindings[unit.id] ?? []) {
      const targetUnit = byId.get(target);
      if (targetUnit !== undefined) {
        visit(targetUnit);
      }
    }
    visiting.delete(unit.id);
    visited.add(unit.id);
    ordered.push(unit);
  };
  for (const unit of providers) {
    visit(unit);
  }
  return ordered;
};

const validateUnitServiceBindings = (
  unitServiceBindings: Readonly<Record<string, readonly string[]>>,
  placed: ReadonlySet<string>,
  orderedUnits: readonly TopologyUnit[],
): void => {
  const kinds = new Map(orderedUnits.map((unit) => [unit.id, unit.kind]));
  for (const [consumer, targets] of Object.entries(unitServiceBindings)) {
    if (!placed.has(consumer) || kinds.get(consumer) !== 'provider') {
      fail(`${CLOUDFLARE_PLACEMENT_PATH} unitServiceBindings names "${consumer}", which is not a placed vertical`);
    }
    for (const target of targets) {
      if (target === consumer || !placed.has(target) || kinds.get(target) !== 'provider') {
        fail(
          `${CLOUDFLARE_PLACEMENT_PATH} unitServiceBindings binds "${consumer}" to "${target}", which is not another placed vertical`,
        );
      }
    }
  }
};

const planCloudflareDeployments = (
  { units: placement, unitServiceBindings = {} }: Pick<CloudflarePlacement, 'unitServiceBindings' | 'units'>,
  workerNames: ReadonlyMap<string, string>,
  orderedUnits: readonly TopologyUnit[],
  impacted: ReadonlySet<string>,
  changedPaths: readonly string[],
): readonly CloudflareDeployment[] => {
  const deployInputChanged = changedPaths.some((changedPath) => CLOUDFLARE_DEPLOY_INPUT_PATHS.has(changedPath));
  const unitIds = new Set(orderedUnits.map((unit) => unit.id));
  const placed = new Set<string>();
  for (const id of placement) {
    if (placed.has(id)) {
      fail(`${CLOUDFLARE_PLACEMENT_PATH} places "${id}" more than once`);
    }
    if (!unitIds.has(id)) {
      fail(`${CLOUDFLARE_PLACEMENT_PATH} places "${id}", which is not a topology delivery unit`);
    }
    if (!workerNames.has(id)) {
      fail(`${CLOUDFLARE_PLACEMENT_PATH} places "${id}", whose topology entry names no Cloudflare workerName`);
    }
    placed.add(id);
  }
  // The Shell Worker binds every vertical Worker as a service, so a placed Shell needs every
  // vertical placed: retiring one would leave the Shell bound to a Worker nobody deploys.
  const shellUnit = orderedUnits.find((unit) => unit.kind === 'shell');
  if (shellUnit !== undefined && placed.has(shellUnit.id)) {
    for (const unit of orderedUnits) {
      if (unit.kind === 'provider' && !placed.has(unit.id)) {
        fail(`${CLOUDFLARE_PLACEMENT_PATH} places the Shell, which binds every vertical, but not "${unit.id}"`);
      }
    }
  }
  // Two placed units under one Worker name would overwrite each other and be proven and restored
  // as one resource.
  const placedByWorker = new Map<string, string>();
  for (const id of placed) {
    const workerName = requireString(workerNames.get(id), `topology ${id} cloudflare.workerName`);
    const other = placedByWorker.get(workerName);
    if (other !== undefined) {
      fail(`${CLOUDFLARE_PLACEMENT_PATH} places "${other}" and "${id}" under the same Worker "${workerName}"`);
    }
    placedByWorker.set(workerName, id);
  }
  validateUnitServiceBindings(unitServiceBindings, placed, orderedUnits);
  // The Shell Worker binds every vertical Worker as a service, beyond its Module Federation
  // remotes, so its targets must exist first: providers deploy before the Shell, and a provider
  // another provider binds deploys before it.
  const planned = orderedUnits.filter((unit) => placed.has(unit.id) && (deployInputChanged || impacted.has(unit.id)));
  return [
    ...orderByServiceBindings(
      planned.filter((unit) => unit.kind === 'provider'),
      unitServiceBindings,
    ),
    ...planned.filter((unit) => unit.kind === 'shell'),
  ].map((unit) => ({
    id: unit.id,
    packageName: unit.packageName,
    workerName: requireString(workerNames.get(unit.id), `topology ${unit.id} cloudflare.workerName`),
  }));
};

const WORKSPACE_GLOB_PATTERN = /^(?<directory>[\w.-]+(?:\/[\w.-]+)*)\/\*$/u;

const WorkspaceManifestSchema = Schema.Struct({ packages: Schema.NonEmptyArray(Schema.String) });

const parseWorkspaceGlobs = (workspaceSource: string) =>
  Schema.decodeUnknownEffect(WorkspaceManifestSchema)(parseYaml(workspaceSource)).pipe(
    Effect.map(({ packages }) => packages),
    Effect.mapError(
      () =>
        new DeploymentImpactPlanningError({
          message: 'Deployment impact planning failed: pnpm-workspace.yaml must declare a non-empty "packages" list',
        }),
    ),
  );

const listWorkspaceProjects = (rootDirectory: string, globs: readonly string[]) =>
  Effect.gen(function* listWorkspaceProjectsEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const projects: string[] = [];
    for (const glob of globs) {
      const directory = WORKSPACE_GLOB_PATTERN.exec(glob)?.groups?.directory;
      if (directory === undefined) {
        return fail(
          `pnpm-workspace.yaml glob "${glob}" is unsupported; declare workspace projects with "<directory>/*" globs`,
        );
      }
      const absoluteDirectory = pathService.join(rootDirectory, directory);
      if (!(yield* fileSystem.exists(absoluteDirectory))) {
        continue;
      }
      for (const entry of yield* fileSystem.readDirectory(absoluteDirectory)) {
        if (yield* fileSystem.exists(pathService.join(absoluteDirectory, entry, PACKAGE_MANIFEST))) {
          projects.push(`${directory}/${entry}`);
        }
      }
    }
    return EffectArray.sort(projects, Order.String);
  });

const validateWorkspaceCompleteness = (
  workspaceProjects: readonly string[],
  units: readonly TopologyUnit[],
  sharedPackages: readonly TopologyOwner[],
): void => {
  const declaredPaths = new Set([
    ...units.map((unit) => unit.path),
    ...sharedPackages.flatMap((sharedPackage) => (sharedPackage.path === undefined ? [] : [sharedPackage.path])),
  ]);
  for (const project of workspaceProjects) {
    if (!declaredPaths.has(project)) {
      fail(
        `workspace project "${project}" is not declared in topology; add it to reference-topology.json sharedPackages and topology/ownership.json owners`,
      );
    }
  }
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

export const FULL_PLAN_SEED_INSTRUCTION =
  'plan the whole topology once instead: dispatch "Ultramodern Workspace Gates and Main-to-Stage Deploy" on main with full=true (gh workflow run ultramodern-workspace-gates.yml --ref main -f full=true)';

const gitSucceeds = (rootDirectory: string, args: readonly string[]) =>
  Effect.gen(function* gitSucceedsEffect() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner
      .exitCode(ChildProcess.make(GIT_EXECUTABLE, args, { cwd: rootDirectory, stderr: 'ignore', stdout: 'ignore' }))
      .pipe(
        Effect.map((exitCode) => exitCode === 0),
        Effect.catch(() => Effect.succeed(false)),
      );
  });

const requireComparableBase = (rootDirectory: string, baseRevision: string, headRevision: string) =>
  Effect.gen(function* requireComparableBaseEffect() {
    if (!(yield* gitSucceeds(rootDirectory, ['cat-file', '-e', `${baseRevision}^{commit}`]))) {
      return fail(`comparison base "${baseRevision}" is not a commit in this checkout; ${FULL_PLAN_SEED_INSTRUCTION}`);
    }
    if (!(yield* gitSucceeds(rootDirectory, ['merge-base', '--is-ancestor', baseRevision, headRevision]))) {
      return fail(
        `comparison base "${baseRevision}" is not an ancestor of "${headRevision}" (history was rewritten); ${FULL_PLAN_SEED_INSTRUCTION}`,
      );
    }
    return yield* Effect.undefined;
  });

/** A JSON document at a revision, or none when the revision has no such file. */
const readJsonAtRevision = <DocumentSchema extends Schema.ConstraintDecoder<unknown>>(
  schema: DocumentSchema,
  rootDirectory: string,
  revision: string,
  relativePath: string,
) =>
  Effect.gen(function* readJsonAtRevisionEffect() {
    const objectName = `${revision}:./${relativePath}`;
    if (!(yield* gitSucceeds(rootDirectory, ['cat-file', '-e', objectName]))) {
      return Option.none();
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const source = yield* spawner.string(
      ChildProcess.make(GIT_EXECUTABLE, ['show', objectName], { cwd: rootDirectory }),
    );
    return Option.some(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(source));
  });

// Only the units, their topology Worker names and the retirement ledger matter for the base; an older
// placement document predating `buildEnvironment` or `retiredWorkers` still names what it deployed.
const BasePlacementSchema = Schema.Struct({
  retiredWorkers: Schema.optional(Schema.Array(Schema.String)),
  units: Schema.Array(Schema.String),
});

const basePlacedWorkerNames = (rootDirectory: string, baseRevision: string | undefined) =>
  Effect.gen(function* basePlacedWorkerNamesEffect() {
    if (baseRevision === undefined) {
      return new Set<string>();
    }
    if (!(yield* gitSucceeds(rootDirectory, ['cat-file', '-e', `${baseRevision}^{commit}`]))) {
      return fail(
        `placement base "${baseRevision}" is not a commit in this checkout; retired Workers cannot be checked`,
      );
    }
    const placement = yield* readJsonAtRevision(
      BasePlacementSchema,
      rootDirectory,
      baseRevision,
      CLOUDFLARE_PLACEMENT_PATH,
    );
    const topology = yield* readJsonAtRevision(
      ReferenceTopologySchema,
      rootDirectory,
      baseRevision,
      'topology/reference-topology.json',
    );
    // A base before edge placement existed deployed no Worker. A placement without its topology
    // cannot name its Workers, so it fails instead of hiding a dropped Worker.
    if (Option.isNone(placement)) {
      return new Set<string>();
    }
    if (Option.isNone(topology)) {
      return fail(`placement base "${baseRevision}" has ${CLOUDFLARE_PLACEMENT_PATH} but no reference topology`);
    }
    // Retired Workers stay in the ledger: CI cannot see an operator's deletion, so dropping an entry
    // would silently stop reporting a Worker that may still run.
    return new Set([
      ...placedWorkerNames(placement.value.units, topology.value),
      ...(placement.value.retiredWorkers ?? []),
    ]);
  });

const changedPathsFromGit = (rootDirectory: string, baseRevision: string, headRevision: string) =>
  Effect.gen(function* changedPathsFromGitEffect() {
    yield* requireComparableBase(rootDirectory, baseRevision, headRevision);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = yield* spawner.string(
      ChildProcess.make(GIT_EXECUTABLE, ['diff', '--name-only', '--no-renames', '-z', baseRevision, headRevision], {
        cwd: rootDirectory,
      }),
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
    relativePath === PACKAGE_MANIFEST ||
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
  changedPath === 'scripts/run-zerops-spicedb.sh' ||
  changedPath === 'scripts/spicedb-datastore-uri.sh';

const isAuthorizationRolloutChange = (changedPath: string): boolean =>
  changedPath.startsWith('packages/core-runtime/src/authorization/') ||
  changedPath.startsWith('packages/core-runtime/src/auth/gateway-assertion-redemption') ||
  changedPath.startsWith('scripts/authorization/') ||
  changedPath === 'scripts/check-authorization-readiness.mts' ||
  changedPath === 'scripts/check-module-entrypoint-boundaries.mts' ||
  changedPath === 'scripts/provision-current-action-authorization.mts' ||
  changedPath === 'scripts/report-fail-closed-authorization-impact.mts' ||
  changedPath === 'topology/authorization-rollout.json';

/**
 * Root-level inputs outside every owned delivery unit whose change reaches every build: the
 * workspace toolchain and lockfile, the Zerops materializers, and the root files unit builds
 * consume (the shared Module Federation config, the base tsconfig, and the module-contract
 * generator with its imports). A guard test derives the build-input closure from the units' build
 * configs so this list cannot fall behind them.
 */
export const CONSERVATIVE_FULL_DEPLOY_PATHS: ReadonlySet<string> = new Set([
  '.mise.toml',
  'module-federation.shared.ts',
  'oxfmt.config.ts',
  PACKAGE_MANIFEST,
  'pnpm-lock.yaml',
  'scripts/generate-ontos-module-contract.mts',
  'scripts/generate-ontos-shell-runtime-contract.mts',
  'scripts/scaffolding-runtime.mts',
  'scripts/scaffolding/shared.mts',
  'tsconfig.base.json',
  WORKSPACE_MANIFEST,
  // The planner decides what every other input impacts: after a repair to one of its rules, the
  // units the old rule skipped must deploy too.
  'scripts/plan-deployment-impact.mts',
  'scripts/install-zerops-node.sh',
  'scripts/verify-zerops-workspace-install.mts',
  'scripts/generate-outbox-worker-deployment.mjs',
  'scripts/materialize-outbox-worker.mjs',
  'scripts/materialize-zerops-runtime.mjs',
  'scripts/locked-registry-overrides.mjs',
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
  baseRevision: string | undefined,
  headRevision: string,
  fullDeploy: boolean,
): DeploymentImpactPlan['comparison'] => {
  const mode = fullDeploy ? 'full' : 'diff';
  return baseRevision === undefined ? { headRevision, mode } : { baseRevision, headRevision, mode };
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

const addWithConsumers = (unitId: string, impacted: Set<string>, orderedUnits: readonly TopologyUnit[]): void => {
  impacted.add(unitId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of orderedUnits) {
      if (!impacted.has(unit.id) && unit.dependencies.some((dependency) => impacted.has(dependency))) {
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
    const { baseRevision } = options;
    if (options.changedPaths === undefined && baseRevision === undefined) {
      return { baseRevision, changedPaths: [], fullDeploy: true, headRevision };
    }
    const comparedPaths =
      options.changedPaths ??
      (yield* changedPathsFromGit(rootDirectory, requireString(baseRevision, 'base revision'), headRevision));
    const changedPaths = EffectArray.sort([...new Set(comparedPaths.map(normalizeChangedPath))], Order.String);
    return { baseRevision, changedPaths, fullDeploy: false, headRevision };
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
    const rootDirectory = options.rootDirectory ?? (yield* Config.String('PWD').pipe(Effect.orElseSucceed(() => '.')));
    const topology = yield* readJson(
      ReferenceTopologySchema,
      pathService.join(rootDirectory, 'topology/reference-topology.json'),
    );
    const ownership = yield* readJson(OwnershipSchema, pathService.join(rootDirectory, 'topology/ownership.json'));
    const cloudflarePlacement = yield* readJson(
      CloudflarePlacementSchema,
      pathService.join(rootDirectory, CLOUDFLARE_PLACEMENT_PATH),
    );
    validateCloudflareBuildEnvironment(cloudflarePlacement.buildEnvironment);
    const stageSetups = parseStageSetups(
      yield* fileSystem.readFileString(pathService.join(rootDirectory, 'zerops.yaml')),
    );
    const orderedUnits = orderUnits(buildTopologyUnits(topology, ownership, stageSetups));
    validateWorkspaceCompleteness(
      yield* listWorkspaceProjects(
        rootDirectory,
        yield* parseWorkspaceGlobs(
          yield* fileSystem.readFileString(pathService.join(rootDirectory, WORKSPACE_MANIFEST)),
        ),
      ),
      orderedUnits,
      topology.sharedPackages ?? [],
    );
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

    const { baseRevision, changedPaths, fullDeploy, headRevision } = yield* deploymentComparison(
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
      comparison: makeComparison(baseRevision, headRevision, fullDeploy),
      phases,
      schemaVersion: 1,
      units: {
        cloudflare: planCloudflareDeployments(
          cloudflarePlacement,
          cloudflareWorkerNames(topology),
          orderedUnits,
          impacted,
          changedPaths,
        ),
        cloudflareRetirements: planCloudflareRetirements(
          cloudflarePlacement,
          topology,
          yield* basePlacedWorkerNames(rootDirectory, options.placementBaseRevision ?? baseRevision),
          shell.packageName,
        ),
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
const CloudflareJsonSchema = Schema.fromJsonString(DeploymentImpactPlanSchema.fields.units.fields.cloudflare);
const CloudflareRetirementsJsonSchema = Schema.fromJsonString(
  DeploymentImpactPlanSchema.fields.units.fields.cloudflareRetirements,
);

const writeGitHubOutputs = (plan: DeploymentImpactPlan, outputPath: string) =>
  Effect.gen(function* writeGitHubOutputsEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const planJson = yield* Schema.encodeEffect(PlanJsonSchema)(plan);
    const providersJson = yield* Schema.encodeEffect(ProvidersJsonSchema)(plan.units.providers);
    const cloudflareJson = yield* Schema.encodeEffect(CloudflareJsonSchema)(plan.units.cloudflare);
    const cloudflareRetirementsJson = yield* Schema.encodeEffect(CloudflareRetirementsJsonSchema)(
      plan.units.cloudflareRetirements,
    );
    const output = [
      `any=${String(plan.any)}`,
      `cloudflare=${cloudflareJson}`,
      `cloudflare_retirements=${cloudflareRetirementsJson}`,
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
  Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(value).pipe(Effect.map(DateTime.toEpochMillis));

const deploymentImpactCommand = Command.make(
  'plan-deployment-impact',
  {
    authorizationEnvironment: Flag.Literals('authorization-environment', ['development', 'production', 'stage']).pipe(
      Flag.optional,
    ),
    authorizationNow: Flag.String('authorization-now').pipe(Flag.optional),
    baseRevision: Flag.String('base').pipe(Flag.optional),
    changedPaths: Flag.String('changed-path').pipe(Flag.atLeast(0)),
    headRevision: Flag.String('head').pipe(Flag.optional),
    placementBaseRevision: Flag.String('placement-base').pipe(Flag.optional),
  },
  ({ authorizationEnvironment, authorizationNow, baseRevision, changedPaths, headRevision, placementBaseRevision }) =>
    Effect.gen(function* deploymentImpactCommandEffect() {
      const rootDirectory = yield* Config.String('PWD').pipe(Effect.orElseSucceed(() => '.'));
      const environment = Option.getOrUndefined(authorizationEnvironment);
      let authorizationPromotion: AuthorizationPromotionGateInput | undefined;
      if (environment !== undefined) {
        const configuredNow = Option.getOrUndefined(authorizationNow);
        const nowEpochMs =
          configuredNow === undefined ? yield* Clock.currentTimeMillis : yield* parseAuthorizationNow(configuredNow);
        authorizationPromotion = yield* loadAuthorizationPromotionGate(rootDirectory, environment, nowEpochMs);
      }
      const options: PlanDeploymentImpactOptions = {
        baseRevision: Option.getOrUndefined(baseRevision),
        changedPaths: changedPaths.length === 0 ? undefined : changedPaths,
        headRevision: Option.getOrUndefined(headRevision),
        placementBaseRevision: Option.getOrUndefined(placementBaseRevision),
        rootDirectory,
      };
      const plan =
        authorizationPromotion === undefined
          ? yield* planDeploymentImpact(options)
          : yield* planDeploymentImpact({ ...options, authorizationPromotion });
      const planJson = yield* Schema.encodeEffect(PlanJsonSchema)(plan);
      yield* Console.log(planJson);
      const outputPath = yield* Config.option(Config.String('GITHUB_OUTPUT'));
      if (Option.isSome(outputPath)) {
        yield* writeGitHubOutputs(plan, outputPath.value);
      }
    }),
);

export const main = Command.run({ version: '1.0.0' })(deploymentImpactCommand);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(NodeServices.layer))).pipe(Effect.scoped),
  );
}
