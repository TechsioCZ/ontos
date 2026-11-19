/// <reference types="node" />
/**
 * Symmy C14 on the AKROS playground: the one reviewed path that activates its modules tenant-wide.
 *
 *   node scripts/demo/symmy-akros-activate.mts --plan <file>                                   # dry-run
 *   node scripts/demo/symmy-akros-activate.mts --plan <file> --mode apply
 *   node scripts/demo/symmy-akros-activate.mts --plan <file> --mode verify
 *
 * The modules are `symmyAkrosModuleKeys` (`stage-tenant-modules.mts`): `integration.symmy` and the native owners the
 * agreed seven POST routes, four GET routes and job polling call, never `commerce.tax` or `commerce.assortment`. Each
 * one is activated through Core's own `core.modules.change-tenant-module-state` Action, signed in as a tenant-only
 * operator of the AKROS playground Tenant, exactly as `activate-market-stage.mts` does for one module; the operator
 * session, the stage guard and the prepared catalog are that script's (`StageMarketOperatorLive`).
 *
 * The plan pins the Tenant, the operator, the composition revision and the module list, never a state, so a partial
 * apply is finished by applying the same reviewed plan again: an active module is left alone and an inactive one is
 * activated under the same idempotency key. It refuses a module the active composition does not publish and any
 * explicit lifecycle state other than inactive/active (a state a person set). It writes no route, principal, key,
 * workload binding or business record: those are the provisioning plan's (`symmy-akros-provision.mts`).
 * Module state is tenant-wide; the AKROS seller is pinned by the routes, not here.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  ActionRuntime,
  changeTenantModuleStateAction,
  InstalledModuleCatalogService,
  OntosModuleDeploymentContractSchema,
} from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  loadCheckedActiveApplicationComposition,
} from '@app/core-runtime/modules/active-application-composition';
import { NodeServices } from '@effect/platform-node';
import { and, eq, inArray } from 'drizzle-orm';
import { Config, Console, Effect, Exit, FileSystem, Result, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { PrincipalIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import { tenantModuleStates } from '../../packages/core-runtime/src/db/schema.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { ProcessDatabasePoolsLive } from '../zerops/process-database-pools.mts';
import { StageMarketOperatorLive } from './activate-market-stage.mts';
import { authenticateAgentProfileOperator } from './agent-profile-operator.mts';
import { AgentProfileReadDatabase } from './agent-profile-setup.mts';
import { AKROS_PLAYGROUND_TENANT_ID, stageActivationScopes, symmyAkrosModuleKeys } from './stage-tenant-modules.mts';
import type { SymmyAkrosModuleKey } from './stage-tenant-modules.mts';

const ACTIVE = 'active';
const INACTIVE = 'inactive';
const activationReason = 'Operator-approved Symmy C14 module activation for the AKROS playground';
const modes = ['dry-run', 'apply', 'verify'] as const;
const sameContracts = Schema.toEquivalence(Schema.Array(OntosModuleDeploymentContractSchema));

export class SymmyAkrosActivationFailure extends Schema.TaggedError<SymmyAkrosActivationFailure>()(
  'SymmyAkrosActivationFailure',
  { reasons: Schema.Array(Schema.String) },
) {}
const fail = (...reasons: readonly string[]) => new SymmyAkrosActivationFailure({ reasons });

/** The reviewed plan: who activates which modules in which Tenant against which composition. No state is pinned. */
export const SymmyAkrosActivationPlanSchema = Schema.Struct({
  actionKey: Schema.Literal('core.modules.change-tenant-module-state'),
  compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  moduleKeys: Schema.Array(Schema.Literals(symmyAkrosModuleKeys)),
  operatorPrincipalId: PrincipalIdSchema,
  tenantId: Schema.Literal(AKROS_PLAYGROUND_TENANT_ID),
});
export type SymmyAkrosActivationPlan = typeof SymmyAkrosActivationPlanSchema.Type;
const planJson = Schema.fromJsonString(SymmyAkrosActivationPlanSchema);
const samePlan = Schema.toEquivalence(SymmyAkrosActivationPlanSchema);
export const symmyAkrosActivationFingerprint = (text: string) => createHash('sha256').update(text).digest('hex');
/** One key per module of one reviewed plan, so applying the same plan again never activates twice. */
export const symmyAkrosActivationIdempotencyKey = (fingerprint: string, moduleKey: SymmyAkrosModuleKey) =>
  ['symmy-akros-activation', fingerprint, moduleKey].join(':');

/** A tenant-only session of the AKROS playground Tenant, whose stage scope approves every module. */
export const symmyAkrosOperatorRefusals = (principal: {
  readonly authMethod: string;
  readonly legalEntityId?: string | undefined;
  readonly tenantId: string;
}): readonly string[] => {
  const approved: ReadonlySet<string> = new Set(
    stageActivationScopes
      .filter(({ tenantId }) => tenantId === principal.tenantId)
      .flatMap(({ moduleKeys }) => moduleKeys),
  );
  return [
    ...(principal.tenantId === AKROS_PLAYGROUND_TENANT_ID
      ? []
      : ['The operator is not signed in to the AKROS playground Tenant']),
    ...(principal.authMethod === 'session' && principal.legalEntityId === undefined
      ? []
      : ['Module activation requires a tenant-only operator session, not a company-scoped or machine one']),
    ...symmyAkrosModuleKeys
      .filter((moduleKey) => !approved.has(moduleKey))
      .map((moduleKey) => `stageActivationScopes does not approve ${moduleKey} for this Tenant`),
  ];
};

export interface SymmyAkrosActivationSteps {
  /** Inactive (or never installed) modules, in activation order: the owners before `integration.symmy`. */
  readonly activate: readonly SymmyAkrosModuleKey[];
  readonly alreadyActive: readonly SymmyAkrosModuleKey[];
}

/** What applying the plan does to the observed states; a missing row is inactive, like Core's own default. */
export const symmyAkrosActivationSteps = (
  rows: readonly { readonly moduleKey: string; readonly state: string }[],
): Result.Result<SymmyAkrosActivationSteps, readonly string[]> => {
  const refusals: string[] = [];
  const activate: SymmyAkrosModuleKey[] = [];
  const alreadyActive: SymmyAkrosModuleKey[] = [];
  for (const moduleKey of symmyAkrosModuleKeys) {
    const states = rows.filter((row) => row.moduleKey === moduleKey).map(({ state }) => state);
    const [state = INACTIVE] = states;
    if (states.length > 1) {
      refusals.push(`${moduleKey} has contradictory state rows`);
    } else if (state === ACTIVE) {
      alreadyActive.push(moduleKey);
    } else if (state === INACTIVE) {
      activate.push(moduleKey);
    } else {
      refusals.push(`${moduleKey} is ${state}, a state a person set; this activation never replaces it`);
    }
  }
  return refusals.length > 0 ? Result.fail(refusals) : Result.succeed({ activate, alreadyActive });
};

const fromResult = <A,>(result: Result.Result<A, readonly string[]>) =>
  Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(fail(...result.failure));

const main = (mode: (typeof modes)[number], planPath: string) =>
  Effect.gen(function* activateSymmyAkros() {
    const environment = yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    const configuration = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
    if (environment !== 'stage' || configuration.endpoint !== 'spicedb:50051') {
      return yield* fail('Symmy AKROS activation requires the actual stage environment and stage-private SpiceDB');
    }
    const operator = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (session) =>
      session.close.pipe(Effect.ignore),
    );
    const { principal } = operator;
    const operatorRefusals = symmyAkrosOperatorRefusals(principal);
    if (operatorRefusals.length > 0) {
      return yield* fail(...operatorRefusals);
    }
    const { catalog, snapshot } = yield* loadCheckedActiveApplicationComposition(
      yield* ActiveApplicationCompositionService,
    );
    const preparedCatalog = yield* (yield* InstalledModuleCatalogService).loadForRevision(
      snapshot.composition.revision,
    );
    if (!sameContracts(preparedCatalog.contracts, catalog.contracts)) {
      return yield* fail('The approved composition changed after operator preparation; restart with a fresh plan');
    }
    const unpublished = symmyAkrosModuleKeys.filter((moduleKey) => catalog.getByModuleId(moduleKey) === undefined);
    if (unpublished.length > 0) {
      return yield* fail(...unpublished.map((moduleKey) => `The active composition does not publish ${moduleKey}`));
    }
    const plan = yield* Schema.decodeUnknownEffect(SymmyAkrosActivationPlanSchema)({
      actionKey: changeTenantModuleStateAction.descriptor.actionKey,
      compositionRevision: snapshot.composition.revision,
      moduleKeys: [...symmyAkrosModuleKeys],
      operatorPrincipalId: principal.principalId,
      tenantId: principal.tenantId,
    });
    const text = yield* Schema.encodeEffect(planJson)(plan);
    const fingerprint = symmyAkrosActivationFingerprint(text);
    const { executor } = yield* AgentProfileReadDatabase;
    const readSteps = executor
      .select({ moduleKey: tenantModuleStates.moduleKey, state: tenantModuleStates.state })
      .from(tenantModuleStates)
      .where(
        and(
          eq(tenantModuleStates.tenantId, plan.tenantId),
          inArray(tenantModuleStates.moduleKey, [...symmyAkrosModuleKeys]),
        ),
      )
      .pipe(Effect.flatMap((rows) => fromResult(symmyAkrosActivationSteps(rows))));
    const steps = yield* readSteps;
    const filesystem = yield* FileSystem.FileSystem;
    if (mode === 'dry-run') {
      yield* filesystem.writeFileString(planPath, text, { flag: 'wx', mode: 0o600 });
      return yield* Console.log({ fingerprint, mode, tenantId: plan.tenantId, ...steps });
    }
    const stat = yield* filesystem.stat(planPath);
    const saved = yield* filesystem.readFileString(planPath);
    const savedPlan = yield* Schema.decodeUnknownEffect(planJson, { onExcessProperty: 'error' })(saved);
    if (stat.type !== 'File' || stat.mode % 0o100 !== 0 || !samePlan(savedPlan, plan)) {
      return yield* fail(
        'The owner-only activation plan must match the current operator, Tenant, modules and composition',
      );
    }
    if (mode === 'apply') {
      const runtime = yield* ActionRuntime;
      for (const moduleKey of steps.activate) {
        yield* runtime.runAction({
          payload: { expectedState: INACTIVE, moduleKey, newState: ACTIVE, reason: activationReason },
          principal,
          registration: changeTenantModuleStateAction,
          transport: {
            correlationId: randomUUID(),
            idempotencyKey: symmyAkrosActivationIdempotencyKey(fingerprint, moduleKey),
          },
        });
        yield* Console.log({ moduleKey, state: ACTIVE, tenantId: plan.tenantId });
      }
    }
    const after = yield* readSteps;
    if (after.activate.length > 0) {
      return yield* fail(...after.activate.map((moduleKey) => `${moduleKey} is not active`));
    }
    return yield* Console.log({
      fingerprint,
      mode,
      modules: after.alreadyActive,
      state: ACTIVE,
      tenantId: plan.tenantId,
    });
  }).pipe(Effect.scoped);

const command = Command.make(
  'symmy-akros-activate',
  {
    mode: Flag.Literals('mode', modes).pipe(Flag.withDefault('dry-run')),
    plan: Flag.String('plan'),
  },
  ({ mode, plan }) =>
    main(mode, plan).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(SymmyAkrosActivationFailure)(failure)
            ? ['Symmy AKROS activation stopped:', ...failure.reasons].join('\n- ')
            : `Symmy AKROS activation stopped (${failure._tag}); credentials and provider details withheld`,
        ),
      ),
    ),
).pipe(Command.provide(StageMarketOperatorLive));

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(ProcessDatabasePoolsLive),
      Effect.provide(NodeServices.layer),
    ),
  );
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
