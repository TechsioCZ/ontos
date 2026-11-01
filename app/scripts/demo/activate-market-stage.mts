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
import { and, eq } from 'drizzle-orm';
import { Config, Console, Effect, Exit, FileSystem, Layer, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { tenantModuleStates } from '../../packages/core-runtime/src/db/schema.ts';
import { buildApplicationCompositionCatalog } from '../../packages/core-runtime/src/modules/application-composition-catalog.ts';
import { TenantModuleStateValidationUnavailableError } from '../../packages/core-runtime/src/modules/tenant-module-state-validation-unavailable-error.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { AgentProfileOperatorLive, authenticateAgentProfileOperator } from './agent-profile-operator.mts';
import { AgentProfileReadDatabase } from './agent-profile-setup.mts';
import { demoTenantId } from './fixture-ids.mts';

/** The e-shop market modules this operator may activate tenant-wide; nothing else. */
export const stageMarketModuleKeys = ['commerce.market-catalog', 'commerce.storefront-registry'] as const;
export type StageMarketModuleKey = (typeof stageMarketModuleKeys)[number];
const activationReason = 'Operator-approved tenant-wide e-shop market activation for the sales demo';
const modes = ['dry-run', 'apply', 'verify'] as const;
const sameContracts = Schema.toEquivalence(Schema.Array(OntosModuleDeploymentContractSchema));

export class StageMarketActivationFailure extends Schema.TaggedError<StageMarketActivationFailure>()(
  'StageMarketActivationFailure',
  { reason: Schema.String },
) {}
const fail = (reason: string) => new StageMarketActivationFailure({ reason });

export const marketActivationScopeAllowed = (tenantId: string, authMethod: string, legalEntityId?: string) =>
  tenantId === demoTenantId && authMethod === 'session' && legalEntityId === undefined;

export const ReviewedMarketActivationPlanSchema = Schema.Struct({
  actionKey: Schema.Literal('core.modules.change-tenant-module-state'),
  compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  moduleKey: Schema.Literals(stageMarketModuleKeys),
  operatorPrincipalId: Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand('MarketActivationOperatorPrincipalId'),
    Schema.decodeTo(Schema.String.check(Schema.isUUID())),
  ),
  tenantId: Schema.Literal(demoTenantId),
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
    if (
      !marketActivationScopeAllowed(
        operator.principal.tenantId,
        operator.principal.authMethod,
        operator.principal.legalEntityId,
      )
    ) {
      return yield* fail('Market activation requires a genuine tenant-only demo operator session');
    }
    const snapshot = yield* (yield* ActiveApplicationCompositionService).load;
    const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);
    const preparedCatalog = yield* (yield* InstalledModuleCatalogService).load;
    if (!sameContracts(preparedCatalog.contracts, catalog.contracts)) {
      return yield* fail('The approved composition changed after operator preparation; restart with a fresh plan');
    }
    if (catalog.getByModuleId(stageMarketModuleKey) === undefined) {
      return yield* fail('The active composition does not publish the requested module');
    }
    const plan = yield* Schema.decodeUnknownEffect(ReviewedMarketActivationPlanSchema)({
      actionKey: changeTenantModuleStateAction.descriptor.actionKey,
      compositionRevision: snapshot.composition.revision,
      moduleKey: stageMarketModuleKey,
      operatorPrincipalId: operator.principal.principalId,
      tenantId: demoTenantId,
    });
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(ReviewedMarketActivationPlanSchema))(plan);
    const fingerprint = marketActivationPlanFingerprint(text);
    const filesystem = yield* FileSystem.FileSystem;
    const { executor } = yield* AgentProfileReadDatabase;
    const readState = executor
      .select({ state: tenantModuleStates.state })
      .from(tenantModuleStates)
      .where(and(eq(tenantModuleStates.tenantId, demoTenantId), eq(tenantModuleStates.moduleKey, stageMarketModuleKey)))
      .limit(1)
      .pipe(Effect.map((rows) => rows.at(0)?.state ?? 'inactive'));
    const state = yield* readState;
    if (state !== 'inactive' && state !== 'active') {
      return yield* fail('The module has an explicit non-active lifecycle state; this installer will not replace it');
    }
    if (mode === 'dry-run') {
      yield* filesystem.writeFileString(planPath, text, { flag: 'wx', mode: 0o600 });
      return yield* Console.log({ fingerprint, mode, moduleKey: stageMarketModuleKey, state, tenantId: demoTenantId });
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
    return yield* Console.log({ mode, moduleKey: stageMarketModuleKey, state: 'active', tenantId: demoTenantId });
  }).pipe(Effect.scoped);

export const StageMarketOperatorLive = Layer.effect(
  InstalledModuleCatalogService,
  Effect.gen(function* marketOperatorCatalog() {
    const composition = yield* ActiveApplicationCompositionService;
    // The Core handler consumes this service inside guarded SQL. Materialize the genuine
    // composition before entering the Action, never an HTTP-backed catalog loader.
    const catalog = yield* composition.load.pipe(
      Effect.flatMap((snapshot) => buildApplicationCompositionCatalog(snapshot.composition)),
      Effect.mapError(
        () =>
          new TenantModuleStateValidationUnavailableError({
            code: 'tenant_module_state_validation_unavailable',
            reason: 'The approved installed catalog is unavailable',
          }),
      ),
    );
    return {
      load: Effect.succeed(catalog),
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
        Console.error(`Market activation stopped (${failure._tag}); credentials and provider details withheld`),
      ),
    ),
).pipe(Command.provide(StageMarketOperatorLive));

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)),
  );
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
