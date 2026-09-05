#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProtectedEntrypointInventory } from './authorization/protected-entrypoint-inventory.mts';
import type { AuthorizationRolloutContract } from './authorization/rollout-contract.mts';
import { validateAuthorizationRolloutContract } from './authorization/rollout-contract.mts';
import type { AuthorizationImpactReport } from './report-fail-closed-authorization-impact.mts';

type AuthorizationEnvironment = 'development' | 'production' | 'stage';
type Credential = 'api_key' | 'session';

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

export interface AuthorizationReadinessEvidence {
  readonly approvalReference: string;
  readonly environment: AuthorizationEnvironment;
  readonly fixedContextHash: string;
  readonly impactReportHash: string;
  readonly inventoryHash: string;
  readonly moduleStateVersion: string;
  readonly negativeSmokeHash: string;
  readonly observation: { readonly endedAt: string; readonly startedAt: string };
  readonly policyDataVersion: string;
  readonly replayMigrationHash: string;
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
  readonly spiceDbSchemaHash: string;
  readonly status: 'ready';
  readonly workerOwnershipVersion: string;
}

const stableList = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].toSorted();
const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  JSON.stringify(stableList(left)) === JSON.stringify(stableList(right));
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const hashAuthorizationEvidence = (value: unknown): string => sha256(JSON.stringify(value));
const validHash = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value);
const validRevision = (value: string): boolean => /^[a-zA-Z0-9._-]{1,100}$/u.test(value);

const fail = (message: string): never => {
  throw new TypeError(`authorization readiness failed: ${message}`);
};

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

export const checkAuthorizationReadiness = (
  input: AuthorizationReadinessInput,
): AuthorizationReadinessEvidence => {
  const { context, impact, inventory, negativeSmoke, observation } = input;
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
  const observationStarted = Date.parse(impact.observation.startedAt);
  const observationEnded = Date.parse(impact.observation.endedAt);
  const rolloutStarted = Date.parse(input.rollout.activatedAt);
  const rolloutEnded = Date.parse(input.rollout.expiresAt);
  if (
    ![observationStarted, observationEnded, rolloutStarted, rolloutEnded].every(Number.isFinite) ||
    observationStarted < rolloutStarted ||
    observationEnded > rolloutEnded ||
    observationEnded - observationStarted < context.minimumObservationSeconds * 1000
  ) {
    fail('compatibility observation is outside the approved bounds');
  }
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
  const required = requiredEntrypoints(inventory);
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

const readJson = async <Value,>(file: string): Promise<Value> =>
  JSON.parse(await readFile(file, 'utf-8')) as Value;

const insideWorkspace = (root: string, relativeFile: string): string => {
  const target = path.resolve(root, relativeFile);
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('fixed context references a path outside the workspace');
  }
  return target;
};

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === import.meta.filename) {
  const argumentsList = process.argv.slice(2).filter((argument) => argument !== '--');
  if (
    argumentsList.length !== 1 ||
    !/^(?:development|production|stage)$/u.test(argumentsList[0]!)
  ) {
    throw new TypeError('authorization readiness accepts exactly one fixed environment name');
  }
  const environment = argumentsList[0]!;
  const root = process.env.ULTRAMODERN_WORKSPACE_ROOT ?? path.resolve(import.meta.dirname, '..');
  const reportDirectory = path.join(root, '.codex/reports/authorization');
  const contextPath = path.join(root, 'topology/authorization-contexts', `${environment}.json`);
  const context = await readJson<FixedAuthorizationContext>(contextPath).catch(() =>
    fail(`no approved fixed ${environment} deployment context exists`),
  );
  if (context.environment !== environment || context.approvalStatus !== 'approved') {
    fail(`no approved fixed ${environment} deployment context exists`);
  }
  const [inventory, impact, observation, negativeSmoke, rollout] = await Promise.all([
    readJson<ProtectedEntrypointInventory>(
      path.join(reportDirectory, 'protected-entrypoints.json'),
    ),
    readJson<AuthorizationImpactReport>(path.join(reportDirectory, 'fail-closed-impact.json')),
    readJson<AuthorizationReadinessObservation>(
      path.join(reportDirectory, `fixed-context-observation.${environment}.json`),
    ),
    readJson<AuthorizationNegativeSmokeEvidence>(
      path.join(reportDirectory, `negative-smoke.${environment}.json`),
    ),
    readJson<AuthorizationRolloutContract>(path.join(root, 'topology/authorization-rollout.json')),
  ]);
  const [contextSource, spiceDbSchemaSource, replayMigrationSource] = await Promise.all([
    readFile(contextPath, 'utf-8'),
    readFile(insideWorkspace(root, context.spiceDbSchemaPath), 'utf-8'),
    readFile(insideWorkspace(root, context.replayMigrationPath), 'utf-8'),
  ]);
  const evidence = checkAuthorizationReadiness({
    context,
    contextHash: sha256(contextSource),
    impact,
    impactReportHash: hashAuthorizationEvidence(impact),
    inventory,
    negativeSmoke,
    negativeSmokeHash: hashAuthorizationEvidence(negativeSmoke),
    nowEpochMs: Date.now(),
    observation,
    replayMigrationHash: sha256(replayMigrationSource),
    rollout,
    spiceDbSchemaHash: sha256(spiceDbSchemaSource),
  });
  const outputPath = path.join(reportDirectory, 'readiness.json');
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, undefined, 2)}\n`, 'utf-8');
  process.stdout.write(`${outputPath} ${hashAuthorizationEvidence(evidence)}\n`);
}
