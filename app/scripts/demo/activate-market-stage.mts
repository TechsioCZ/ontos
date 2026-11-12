/// <reference types="node" />
import { createHash, randomUUID } from 'node:crypto';

import {
  ActionRuntime,
  changeTenantModuleStateAction,
  InstalledModuleCatalogService,
  OntosModuleDeploymentContractSchema,
} from '@app/core-runtime';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { NodeServices } from '@effect/platform-node';
import { and, eq, inArray } from 'drizzle-orm';
import { Config, Console, Effect, Exit, FileSystem, Layer, Option, Result, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { tenantModuleStates } from '../../packages/core-runtime/src/db/schema.ts';
import { buildApplicationCompositionCatalog } from '../../packages/core-runtime/src/modules/application-composition-catalog.ts';
import { TenantModuleStateValidationUnavailableError } from '../../packages/core-runtime/src/modules/tenant-module-state-validation-unavailable-error.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { ProcessDatabasePoolsLive } from '../zerops/process-database-pools.mts';
import { AgentProfileOperatorLive, authenticateAgentProfileOperator } from './agent-profile-operator.mts';
import { AgentProfileReadDatabase } from './agent-profile-setup.mts';
import {
  activationSellingEvidence,
  sellingModuleKeys,
  stageActivationScopes,
  stageActivationTenantIds,
  stageMarketModuleKeys,
} from './stage-tenant-modules.mts';
import type { StageMarketModuleKey } from './stage-tenant-modules.mts';

export {
  activationSellingEvidence,
  AKROS_PLAYGROUND_TENANT_ID,
  sellingModuleKeys,
  stageActivationScopes,
  stageActivationTenantIds,
  stageMarketModuleKeys,
} from './stage-tenant-modules.mts';
export type { StageMarketModuleKey } from './stage-tenant-modules.mts';
const activationReason = 'Operator-approved tenant-wide module activation for the sales demo';
const modes = ['dry-run', 'apply', 'verify'] as const;
const sameContracts = Schema.toEquivalence(Schema.Array(OntosModuleDeploymentContractSchema));

export class StageMarketActivationFailure extends Schema.TaggedError<StageMarketActivationFailure>()(
  'StageMarketActivationFailure',
  { reason: Schema.String },
) {}
const fail = (reason: string) => new StageMarketActivationFailure({ reason });

export const marketActivationScopeAllowed = (
  tenantId: string,
  moduleKey: StageMarketModuleKey,
  authMethod: string,
  legalEntityId?: string,
) =>
  authMethod === 'session' &&
  legalEntityId === undefined &&
  stageActivationScopes.some((scope) => scope.tenantId === tenantId && scope.moduleKeys.includes(moduleKey));

export const ReviewedMarketActivationPlanSchema = Schema.Struct({
  actionKey: Schema.Literal('core.modules.change-tenant-module-state'),
  compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  moduleKey: Schema.Literals(stageMarketModuleKeys),
  operatorPrincipalId: Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand('MarketActivationOperatorPrincipalId'),
    Schema.decodeTo(Schema.String.check(Schema.isUUID())),
  ),
  /** The active selling modules that justify a module needing a selling Tenant; empty for every other module. */
  sellingModules: Schema.Array(Schema.Literals(sellingModuleKeys)),
  tenantId: Schema.Literals(stageActivationTenantIds),
});
export const marketActivationPlanFingerprint = (text: string) => createHash('sha256').update(text).digest('hex');

const main = (
  mode: (typeof modes)[number],
  stageMarketModuleKey: StageMarketModuleKey,
  planPath: string,
  reviewed: Option.Option<string>,
) =>
  Effect.gen(function* activateStageMarket() {
    const environment = yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    const configuration = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
    if (environment !== 'stage' || configuration.endpoint !== 'spicedb:50051') {
      return yield* fail('Market activation requires the actual stage environment and stage-private SpiceDB');
    }
    const operator = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (session) =>
      session.close.pipe(Effect.ignore),
    );
    const { tenantId } = operator.principal;
    if (
      !marketActivationScopeAllowed(
        tenantId,
        stageMarketModuleKey,
        operator.principal.authMethod,
        operator.principal.legalEntityId,
      )
    ) {
      return yield* fail('Module activation requires a tenant-only operator session of a Tenant allowed this module');
    }
    const snapshot = yield* (yield* ActiveApplicationCompositionService).load;
    const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);
    const preparedCatalog = yield* (yield* InstalledModuleCatalogService).loadForRevision(
      snapshot.composition.revision,
    );
    if (!sameContracts(preparedCatalog.contracts, catalog.contracts)) {
      return yield* fail('The approved composition changed after operator preparation; restart with a fresh plan');
    }
    if (catalog.getByModuleId(stageMarketModuleKey) === undefined) {
      return yield* fail('The active composition does not publish the requested module');
    }
    const { executor } = yield* AgentProfileReadDatabase;
    const activeSellingModules = yield* executor
      .select({ moduleKey: tenantModuleStates.moduleKey })
      .from(tenantModuleStates)
      .where(
        and(
          eq(tenantModuleStates.tenantId, tenantId),
          eq(tenantModuleStates.state, 'active'),
          inArray(tenantModuleStates.moduleKey, [...sellingModuleKeys]),
        ),
      );
    const sellingModules = activationSellingEvidence(
      stageMarketModuleKey,
      activeSellingModules.map(({ moduleKey }) => moduleKey),
    );
    if (Result.isFailure(sellingModules)) {
      return yield* fail(sellingModules.failure);
    }
    const plan = yield* Schema.decodeUnknownEffect(ReviewedMarketActivationPlanSchema)({
      actionKey: changeTenantModuleStateAction.descriptor.actionKey,
      compositionRevision: snapshot.composition.revision,
      moduleKey: stageMarketModuleKey,
      operatorPrincipalId: operator.principal.principalId,
      sellingModules: sellingModules.success,
      tenantId,
    });
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(ReviewedMarketActivationPlanSchema))(plan);
    const fingerprint = marketActivationPlanFingerprint(text);
    const filesystem = yield* FileSystem.FileSystem;
    const readState = executor
      .select({ state: tenantModuleStates.state })
      .from(tenantModuleStates)
      .where(and(eq(tenantModuleStates.tenantId, tenantId), eq(tenantModuleStates.moduleKey, stageMarketModuleKey)))
      .limit(1)
      .pipe(Effect.map((rows) => rows.at(0)?.state ?? 'inactive'));
    const state = yield* readState;
    if (state !== 'inactive' && state !== 'active') {
      return yield* fail('The module has an explicit non-active lifecycle state; this installer will not replace it');
    }
    if (mode === 'dry-run') {
      yield* filesystem.writeFileString(planPath, text, { flag: 'wx', mode: 0o600 });
      return yield* Console.log({
        fingerprint,
        mode,
        moduleKey: stageMarketModuleKey,
        sellingModules: sellingModules.success,
        state,
        tenantId,
      });
    }
    const stat = yield* filesystem.stat(planPath);
    const saved = yield* filesystem.readFileString(planPath);
    yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewedMarketActivationPlanSchema), {
      onExcessProperty: 'error',
    })(saved);
    if (
      stat.type !== 'File' ||
      stat.mode % 0o100 !== 0 ||
      Option.isNone(reviewed) ||
      reviewed.value !== marketActivationPlanFingerprint(saved) ||
      saved !== text
    ) {
      return yield* fail('The exact owner-only activation plan and its reviewed fingerprint are required');
    }
    if (mode === 'verify' && state !== 'active') {
      return yield* fail('The module is not activated');
    }
    if (mode === 'apply' && state !== 'active') {
      const runtime = yield* ActionRuntime;
      yield* runtime.runAction({
        payload: {
          expectedState: 'inactive',
          moduleKey: stageMarketModuleKey,
          newState: 'active',
          reason: activationReason,
        },
        principal: operator.principal,
        registration: changeTenantModuleStateAction,
        transport: {
          correlationId: randomUUID(),
          idempotencyKey: `stage-market-activation:${fingerprint}`,
        },
      });
    }
    if ((yield* readState) !== 'active') {
      return yield* fail('The governed activation did not persist an active module state');
    }
    return yield* Console.log({ mode, moduleKey: stageMarketModuleKey, state: 'active', tenantId });
  }).pipe(Effect.scoped);

export const StageMarketOperatorLive = Layer.effect(
  InstalledModuleCatalogService,
  Effect.gen(function* marketOperatorCatalog() {
    const composition = yield* ActiveApplicationCompositionService;
    // The Core handler consumes this service inside guarded SQL. Materialize the genuine
    // composition before entering the Action, never an HTTP-backed catalog loader.
    const { catalog, revision } = yield* composition.load.pipe(
      Effect.flatMap((snapshot) =>
        buildApplicationCompositionCatalog(snapshot.composition).pipe(
          Effect.map((prepared) => ({ catalog: prepared, revision: snapshot.composition.revision })),
        ),
      ),
      Effect.mapError(
        () =>
          new TenantModuleStateValidationUnavailableError({
            code: 'tenant_module_state_validation_unavailable',
            reason: 'The approved installed catalog is unavailable',
          }),
      ),
    );
    return {
      loadForRevision: (requestedRevision: string) =>
        requestedRevision === revision
          ? Effect.succeed(catalog)
          : Effect.fail(
              new TenantModuleStateValidationUnavailableError({
                code: 'tenant_module_state_validation_unavailable',
                reason: 'The requested composition revision differs from the prepared installed catalog',
              }),
            ),
    };
  }),
).pipe(Layer.provideMerge(AgentProfileOperatorLive));

const command = Command.make(
  'activate-market-stage',
  {
    mode: Flag.Literals('mode', modes).pipe(Flag.withDefault('dry-run')),
    module: Flag.Literals('module', stageMarketModuleKeys),
    plan: Flag.String('plan'),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
  },
  ({ mode, module, plan, reviewed }) =>
    main(mode, module, plan, reviewed).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(StageMarketActivationFailure)(failure)
            ? `Market activation stopped: ${failure.reason}`
            : `Market activation stopped (${failure._tag}); credentials and provider details withheld`,
        ),
      ),
    ),
).pipe(Command.provide(StageMarketOperatorLive));

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      // Operator processes own their database pool registry like every Node host (Core pools are host-scoped).
      Effect.provide(ProcessDatabasePoolsLive),
      Effect.provide(NodeServices.layer),
    ),
  );
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
