#!/usr/bin/env node
/// <reference types="node" />
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  Clock,
  Config,
  Console,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schema,
} from 'effect';
import { Argument, Command } from 'effect/unstable/cli';
import type { ProtectedEntrypointInventory } from './authorization/protected-entrypoint-inventory.mts';
import type { AuthorizationRolloutContract } from './authorization/rollout-contract.mts';
import { validateAuthorizationRolloutContract } from './authorization/rollout-contract.mts';
import type { AuthorizationImpactReport } from './report-fail-closed-authorization-impact.mts';

export const AuthorizationEnvironmentSchema = Schema.Literals([
  'development',
  'production',
  'stage',
]);
export type AuthorizationEnvironment = typeof AuthorizationEnvironmentSchema.Type;
export const CredentialSchema = Schema.Literals(['api_key', 'session']);
export type Credential = typeof CredentialSchema.Type;

export interface FixedAuthorizationContext {
  readonly approvalReference: string;
  readonly approvalStatus: 'approved' | 'pending';
  readonly environment: AuthorizationEnvironment;
  readonly gatewayAudiences: readonly string[];
  readonly minimumObservationSeconds: number;
  readonly moduleStateVersion: string;
  readonly negativeSmokeScenarios: readonly string[];
  readonly policyDataVersion: string;
  readonly replayMigrationPath: string;
  readonly schemaVersion: 1;
  readonly spiceDbSchemaPath: string;
  readonly workerOwnershipVersion: string;
}

export interface AuthorizationNegativeSmokeEvidence {
  readonly environment: AuthorizationEnvironment;
  readonly inventoryHash: string;
  readonly scenarios: readonly {
    readonly credential: Credential;
    readonly outcome: 'denied';
    readonly scenario: string;
  }[];
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
}

export interface AuthorizationReadinessObservation {
  readonly approvalReference: string;
  readonly environment: AuthorizationEnvironment;
  readonly gatewayAudiences: readonly string[];
  readonly gatewayIssuer: string;
  readonly inventoryHash: string;
  readonly moduleStateVersion: string;
  readonly negativeSmokeHash: string;
  readonly policyDataVersion: string;
  readonly replayMigrationHash: string;
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
  readonly spiceDbSchemaHash: string;
  readonly verifiedActionEntrypoints: readonly string[];
  readonly verifiedActiveModuleEntrypoints: readonly string[];
  readonly verifiedContextPermissionEntrypoints: readonly string[];
  readonly verifiedWorkerEntrypoints: readonly string[];
  readonly workerOwnershipVersion: string;
}

export interface AuthorizationReadinessInput {
  readonly context: FixedAuthorizationContext;
  readonly contextHash: string;
  readonly impact: AuthorizationImpactReport;
  readonly impactReportHash: string;
  readonly inventory: ProtectedEntrypointInventory;
  readonly negativeSmoke: AuthorizationNegativeSmokeEvidence;
  readonly negativeSmokeHash: string;
  readonly nowEpochMs: number;
  readonly observation: AuthorizationReadinessObservation;
  readonly replayMigrationHash: string;
  readonly rollout: AuthorizationRolloutContract;
  readonly spiceDbSchemaHash: string;
}

const AuthorizationReadinessEvidenceSchema = Schema.Struct({
  approvalReference: Schema.String,
  environment: AuthorizationEnvironmentSchema,
  fixedContextHash: Schema.String,
  impactReportHash: Schema.String,
  inventoryHash: Schema.String,
  moduleStateVersion: Schema.String,
  negativeSmokeHash: Schema.String,
  observation: Schema.Struct({
    endedAt: Schema.DateTimeUtcFromString,
    startedAt: Schema.DateTimeUtcFromString,
  }),
  policyDataVersion: Schema.String,
  replayMigrationHash: Schema.String,
  schemaVersion: Schema.Literal(1),
  sourceRevision: Schema.String,
  spiceDbSchemaHash: Schema.String,
  status: Schema.Literal('ready'),
  workerOwnershipVersion: Schema.String,
});

export type AuthorizationReadinessEvidence = typeof AuthorizationReadinessEvidenceSchema.Encoded;

type AuthorizationHashEvidence =
  | AuthorizationImpactReport
  | AuthorizationNegativeSmokeEvidence
  | AuthorizationReadinessEvidence;

export class AuthorizationReadinessError extends Schema.TaggedError<AuthorizationReadinessError>()(
  'AuthorizationReadinessError',
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const sameList = (left: readonly string[], right: readonly string[]): boolean => {
  const leftValues = new Set(left);
  const rightValues = new Set(right);
  if (leftValues.size !== rightValues.size) {
    return false;
  }
  for (const value of leftValues) {
    if (!rightValues.has(value)) {
      return false;
    }
  }
  return true;
};
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const AuthorizationEvidenceJsonSchema = Schema.fromJsonString(Schema.Unknown);
const FormattedAuthorizationEvidenceJsonSchema = Schema.fromJsonString(Schema.Unknown, {
  space: 2,
});
const encodeAuthorizationEvidence = (value: AuthorizationHashEvidence): string =>
  Result.getOrThrow(Schema.encodeResult(AuthorizationEvidenceJsonSchema)(value));
const encodeFormattedAuthorizationEvidence = (value: AuthorizationReadinessEvidence): string =>
  Result.getOrThrow(Schema.encodeResult(FormattedAuthorizationEvidenceJsonSchema)(value));
export const hashAuthorizationEvidence = (value: AuthorizationHashEvidence): string =>
  sha256(encodeAuthorizationEvidence(value));
const validHash = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value);
const validRevision = (value: string): boolean => /^[a-zA-Z0-9._-]{1,100}$/u.test(value);

const fail = (message: string): never =>
  Option.getOrThrowWith(
    Option.none(),
    () => new AuthorizationReadinessError({ reason: `authorization readiness failed: ${message}` }),
  );

const requiredEntrypoints = (inventory: ProtectedEntrypointInventory) => {
  const actions = inventory.entries
    .filter(
      ({ authorization, surface }) =>
        surface === 'action' && authorization.kind === 'action_execution',
    )
    .map(({ entrypointKey }) => entrypointKey);
  const contextPermissions = inventory.entries
    .filter(({ authorization }) => authorization.kind === 'context_permission')
    .map(({ entrypointKey }) => entrypointKey);
  const workers = inventory.entries
    .filter(
      ({ authorization, surface }) =>
        surface === 'worker' && authorization.kind === 'owner_local_background',
    )
    .map(({ entrypointKey }) => entrypointKey);
  const activeModules = inventory.entries
    .filter(
      ({ authorization, owner, surface }) =>
        owner !== 'shell-super-app' &&
        surface !== 'capability_issuance' &&
        authorization.kind !== 'public',
    )
    .map(({ entrypointKey }) => entrypointKey);
  return { actions, activeModules, contextPermissions, workers };
};

const validateFixedContext = (input: AuthorizationReadinessInput): void => {
  const { context, negativeSmoke, observation } = input;
  if (context.schemaVersion !== 1 || context.approvalStatus !== 'approved') {
    fail('the fixed deployment context is absent or unapproved');
  }
  if (
    context.environment !== observation.environment ||
    context.environment !== negativeSmoke.environment
  ) {
    fail('evidence does not match the fixed deployment environment');
  }
  if (
    context.approvalReference !== observation.approvalReference ||
    context.approvalReference !== input.rollout.decisionReference
  ) {
    fail('approval reference is missing or mismatched');
  }
};

const validateEvidenceIdentity = (input: AuthorizationReadinessInput): void => {
  const { impact, inventory, negativeSmoke, observation } = input;
  if (
    !validRevision(inventory.sourceRevision) ||
    !validHash(inventory.inventoryHash) ||
    ![
      input.contextHash,
      input.impactReportHash,
      input.negativeSmokeHash,
      input.replayMigrationHash,
      input.spiceDbSchemaHash,
    ].every(validHash)
  ) {
    fail('build or evidence identity is malformed');
  }
  validateAuthorizationRolloutContract(input.rollout, {
    entrypointKeys: new Set(inventory.entries.map(({ entrypointKey }) => entrypointKey)),
    inventoryHash: inventory.inventoryHash,
    nowEpochMs: input.nowEpochMs,
  });
  if (
    impact.schemaVersion !== 1 ||
    impact.inventoryHash !== inventory.inventoryHash ||
    impact.sourceRevision !== inventory.sourceRevision ||
    impact.totalWouldDeny !== 0 ||
    observation.inventoryHash !== inventory.inventoryHash ||
    observation.sourceRevision !== inventory.sourceRevision ||
    negativeSmoke.inventoryHash !== inventory.inventoryHash ||
    negativeSmoke.sourceRevision !== inventory.sourceRevision
  ) {
    fail('inventory, impact, observation, or smoke evidence is stale or unresolved');
  }
};

const timestampMillis = (value: string): number =>
  Option.match(DateTime.make(value), {
    onNone: () => Number.NaN,
    onSome: DateTime.toEpochMillis,
  });

const validateObservationWindow = (input: AuthorizationReadinessInput): void => {
  const observationStarted = timestampMillis(input.impact.observation.startedAt);
  const observationEnded = timestampMillis(input.impact.observation.endedAt);
  const rolloutStarted = timestampMillis(input.rollout.activatedAt);
  const rolloutEnded = timestampMillis(input.rollout.expiresAt);
  if (
    ![observationStarted, observationEnded, rolloutStarted, rolloutEnded].every(Number.isFinite) ||
    observationStarted < rolloutStarted ||
    observationEnded > rolloutEnded ||
    observationEnded - observationStarted <
      Duration.toMillis(Duration.seconds(input.context.minimumObservationSeconds))
  ) {
    fail('compatibility observation is outside the approved bounds');
  }
};

const validateObservedVersions = (input: AuthorizationReadinessInput): void => {
  const { context, observation } = input;
  if (
    observation.spiceDbSchemaHash !== input.spiceDbSchemaHash ||
    observation.replayMigrationHash !== input.replayMigrationHash ||
    observation.negativeSmokeHash !== input.negativeSmokeHash ||
    observation.policyDataVersion !== context.policyDataVersion ||
    observation.moduleStateVersion !== context.moduleStateVersion ||
    observation.workerOwnershipVersion !== context.workerOwnershipVersion
  ) {
    fail('policy, schema, module, worker, replay, or smoke evidence is stale');
  }
};

const validateEntrypointCoverage = (input: AuthorizationReadinessInput): void => {
  const required = requiredEntrypoints(input.inventory);
  const { observation } = input;
  if (
    !sameList(observation.verifiedActionEntrypoints, required.actions) ||
    !sameList(observation.verifiedContextPermissionEntrypoints, required.contextPermissions) ||
    !sameList(observation.verifiedWorkerEntrypoints, required.workers) ||
    !sameList(observation.verifiedActiveModuleEntrypoints, required.activeModules)
  ) {
    fail(
      'required relationships, route permissions, module state, or worker ownership are incomplete',
    );
  }
};

const validateGatewayAndSmokeEvidence = (input: AuthorizationReadinessInput): void => {
  const { context, negativeSmoke, observation } = input;
  let issuer: URL;
  try {
    issuer = new URL(observation.gatewayIssuer);
  } catch {
    return fail('gateway issuer configuration is malformed');
  }
  if (
    issuer.protocol !== 'https:' ||
    !sameList(observation.gatewayAudiences, context.gatewayAudiences)
  ) {
    fail('gateway issuer or audience topology is incorrect');
  }
  const requiredSmoke = context.negativeSmokeScenarios.flatMap((scenario) =>
    (['api_key', 'session'] as const).map((credential) => `${credential}:${scenario}:denied`),
  );
  const observedSmoke = negativeSmoke.scenarios.map(
    ({ credential, outcome, scenario }) => `${credential}:${scenario}:${outcome}`,
  );
  if (!sameList(observedSmoke, requiredSmoke)) {
    fail('negative authorization smoke evidence is incomplete');
  }
};

export const checkAuthorizationReadiness = (
  input: AuthorizationReadinessInput,
): AuthorizationReadinessEvidence => {
  validateFixedContext(input);
  validateEvidenceIdentity(input);
  validateObservationWindow(input);
  validateObservedVersions(input);
  validateEntrypointCoverage(input);
  validateGatewayAndSmokeEvidence(input);
  const { context, impact, inventory } = input;
  return {
    approvalReference: context.approvalReference,
    environment: context.environment,
    fixedContextHash: input.contextHash,
    impactReportHash: input.impactReportHash,
    inventoryHash: inventory.inventoryHash,
    moduleStateVersion: context.moduleStateVersion,
    negativeSmokeHash: input.negativeSmokeHash,
    observation: { ...impact.observation },
    policyDataVersion: context.policyDataVersion,
    replayMigrationHash: input.replayMigrationHash,
    schemaVersion: 1,
    sourceRevision: inventory.sourceRevision,
    spiceDbSchemaHash: input.spiceDbSchemaHash,
    status: 'ready',
    workerOwnershipVersion: context.workerOwnershipVersion,
  };
};

const EntrypointKeySchema = Schema.String.pipe(Schema.brand('EntrypointKey'));
const ProtectedEntrypointSurfaceSchema = Schema.Literals([
  'action',
  'capability_issuance',
  'route',
  'worker',
]);

const InventoryAuthorizationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('public') }),
  Schema.Struct({ kind: Schema.Literal('authenticated_principal') }),
  Schema.Struct({ kind: Schema.Literal('context_permission'), permission: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('action_execution'),
    provisioning: Schema.Literals(['explicit', 'tenant_membership_default']),
  }),
  Schema.Struct({ kind: Schema.Literal('owner_local_background') }),
  Schema.Struct({ credential: CredentialSchema, kind: Schema.Literal('capability_issuance') }),
]);

const ProtectedEntrypointInventorySchema = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      authorization: InventoryAuthorizationSchema,
      deployment: Schema.String,
      entrypointKey: EntrypointKeySchema,
      owner: Schema.String,
      surface: ProtectedEntrypointSurfaceSchema,
    }),
  ),
  inventoryHash: Schema.String,
  schemaVersion: Schema.Literal(1),
  sourceRevision: Schema.String,
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
      surface: ProtectedEntrypointSurfaceSchema,
    }),
  ),
  inventoryHash: Schema.String,
  observation: Schema.Struct({
    endedAt: Schema.DateTimeUtcFromString,
    startedAt: Schema.DateTimeUtcFromString,
  }),
  schemaVersion: Schema.Literal(1),
  sourceRevision: Schema.String,
  totalWouldDeny: Schema.Number,
});

const FixedAuthorizationContextSchema = Schema.Struct({
  approvalReference: Schema.String,
  approvalStatus: Schema.Literals(['approved', 'pending']),
  environment: AuthorizationEnvironmentSchema,
  gatewayAudiences: Schema.Array(Schema.String),
  minimumObservationSeconds: Schema.Number,
  moduleStateVersion: Schema.String,
  negativeSmokeScenarios: Schema.Array(Schema.String),
  policyDataVersion: Schema.String,
  replayMigrationPath: Schema.String,
  schemaVersion: Schema.Literal(1),
  spiceDbSchemaPath: Schema.String,
  workerOwnershipVersion: Schema.String,
});

const AuthorizationReadinessObservationSchema = Schema.Struct({
  approvalReference: Schema.String,
  environment: AuthorizationEnvironmentSchema,
  gatewayAudiences: Schema.Array(Schema.String),
  gatewayIssuer: Schema.String,
  inventoryHash: Schema.String,
  moduleStateVersion: Schema.String,
  negativeSmokeHash: Schema.String,
  policyDataVersion: Schema.String,
  replayMigrationHash: Schema.String,
  schemaVersion: Schema.Literal(1),
  sourceRevision: Schema.String,
  spiceDbSchemaHash: Schema.String,
  verifiedActionEntrypoints: Schema.Array(Schema.String),
  verifiedActiveModuleEntrypoints: Schema.Array(Schema.String),
  verifiedContextPermissionEntrypoints: Schema.Array(Schema.String),
  verifiedWorkerEntrypoints: Schema.Array(Schema.String),
  workerOwnershipVersion: Schema.String,
});

const AuthorizationNegativeSmokeEvidenceSchema = Schema.Struct({
  environment: AuthorizationEnvironmentSchema,
  inventoryHash: Schema.String,
  scenarios: Schema.Array(
    Schema.Struct({
      credential: CredentialSchema,
      outcome: Schema.Literal('denied'),
      scenario: Schema.String,
    }),
  ),
  schemaVersion: Schema.Literal(1),
  sourceRevision: Schema.String,
});

const AuthorizationRolloutContractSchema = Schema.Struct({
  activatedAt: Schema.DateTimeUtcFromString,
  baselineInventoryHash: Schema.String,
  baselineSourceRevision: Schema.String,
  compatibilityEligibleEntrypoints: Schema.Array(Schema.String),
  decisionReference: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
  mode: Schema.Literals(['enforced', 'report_only']),
  schemaVersion: Schema.Literal(1),
});

const readJson = <S extends Schema.Top>(schema: S, file: string) =>
  Effect.gen(function* readJsonEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* fileSystem.readFileString(file);
    const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema), {
      onExcessProperty: 'error',
    })(source);
    return yield* Schema.encodeEffect(schema)(decoded);
  }).pipe(
    Effect.mapError(
      () =>
        new AuthorizationReadinessError({ reason: `authorization evidence is invalid: ${file}` }),
    ),
  );

const insideWorkspace = (pathService: Path.Path, root: string, relativeFile: string): string => {
  const target = pathService.resolve(root, relativeFile);
  const relative = pathService.relative(root, target);
  if (
    relative === '' ||
    relative.startsWith(`..${pathService.sep}`) ||
    pathService.isAbsolute(relative)
  ) {
    fail('fixed context references a path outside the workspace');
  }
  return target;
};

const authorizationReadinessCommand = Command.make(
  'authorization-readiness',
  {
    environment: Argument.choice('environment', ['development', 'production', 'stage']),
  },
  ({ environment }) =>
    Effect.gen(function* authorizationReadinessProgram() {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const defaultRoot = yield* pathService.fromFileUrl(new URL('..', import.meta.url));
      const root = yield* Config.string('ULTRAMODERN_WORKSPACE_ROOT').pipe(
        Config.withDefault(defaultRoot),
      );
      const reportDirectory = pathService.join(root, '.codex/reports/authorization');
      const contextPath = pathService.join(
        root,
        'topology/authorization-contexts',
        `${environment}.json`,
      );
      const context = yield* readJson(FixedAuthorizationContextSchema, contextPath).pipe(
        Effect.mapError(
          () =>
            new AuthorizationReadinessError({
              reason: `no approved fixed ${environment} deployment context exists`,
            }),
        ),
      );
      if (context.environment !== environment || context.approvalStatus !== 'approved') {
        yield* new AuthorizationReadinessError({
          reason: `no approved fixed ${environment} deployment context exists`,
        });
      }
      const [inventory, impact, observation, negativeSmoke, rollout] = yield* Effect.all(
        [
          readJson(
            ProtectedEntrypointInventorySchema,
            pathService.join(reportDirectory, 'protected-entrypoints.json'),
          ),
          readJson(
            AuthorizationImpactReportSchema,
            pathService.join(reportDirectory, 'fail-closed-impact.json'),
          ),
          readJson(
            AuthorizationReadinessObservationSchema,
            pathService.join(reportDirectory, `fixed-context-observation.${environment}.json`),
          ),
          readJson(
            AuthorizationNegativeSmokeEvidenceSchema,
            pathService.join(reportDirectory, `negative-smoke.${environment}.json`),
          ),
          readJson(
            AuthorizationRolloutContractSchema,
            pathService.join(root, 'topology/authorization-rollout.json'),
          ),
        ],
        { concurrency: 'unbounded' },
      );
      const [contextSource, spiceDbSchemaSource, replayMigrationSource] = yield* Effect.all(
        [
          fileSystem.readFileString(contextPath),
          fileSystem.readFileString(insideWorkspace(pathService, root, context.spiceDbSchemaPath)),
          fileSystem.readFileString(
            insideWorkspace(pathService, root, context.replayMigrationPath),
          ),
        ],
        { concurrency: 'unbounded' },
      );
      const nowEpochMs = yield* Clock.currentTimeMillis;
      const evidence = yield* Effect.try({
        catch: (error) =>
          error instanceof AuthorizationReadinessError
            ? error
            : new AuthorizationReadinessError({ reason: 'authorization evidence is invalid' }),
        try: () =>
          checkAuthorizationReadiness({
            context,
            contextHash: sha256(contextSource),
            impact,
            impactReportHash: hashAuthorizationEvidence(impact),
            inventory,
            negativeSmoke,
            negativeSmokeHash: hashAuthorizationEvidence(negativeSmoke),
            nowEpochMs,
            observation,
            replayMigrationHash: sha256(replayMigrationSource),
            rollout,
            spiceDbSchemaHash: sha256(spiceDbSchemaSource),
          }),
      });
      const outputPath = pathService.join(reportDirectory, 'readiness.json');
      yield* fileSystem.makeDirectory(reportDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        outputPath,
        `${encodeFormattedAuthorizationEvidence(evidence)}\n`,
      );
      yield* Console.log(`${outputPath} ${hashAuthorizationEvidence(evidence)}`);
    }),
);

const [, invokedModule] = process.argv;
const isMain = invokedModule !== undefined && import.meta.url.endsWith(invokedModule);
if (isMain) {
  const loadFromCoreRuntime = createRequire(
    new URL('../packages/core-runtime/package.json', import.meta.url),
  );
  const nodePlatform: unknown = loadFromCoreRuntime('@effect/platform-node');
  const AnyLayerSchema = Schema.declare(Layer.isLayer);
  const NodeServicesLayerSchema = Schema.declare<Layer.Layer<Command.Environment>>(
    (value): value is Layer.Layer<Command.Environment> => Schema.is(AnyLayerSchema)(value),
  );
  const NodePlatformSchema = Schema.Struct({
    NodeServices: Schema.Struct({ layer: NodeServicesLayerSchema }),
  });
  const { NodeServices } = Result.getOrThrow(
    Schema.decodeUnknownResult(NodePlatformSchema)(nodePlatform),
  );
  await Effect.runPromise(
    Command.run(authorizationReadinessCommand, { version: '1.0.0' }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
}
