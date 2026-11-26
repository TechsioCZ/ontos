/// <reference types="node" />
/**
 * Activates modules tenant-wide for one Tenant through Core's own `core.modules.change-tenant-module-state` Action,
 * signed in as that Tenant's operator. For a fresh deployment whose Tenants the stage accounts bootstrap created with
 * one base module.
 *
 *   ONTOS_AGENT_SETUP_EMAIL=… ONTOS_AGENT_SETUP_PASSWORD=… \
 *     node scripts/activate-tenant-modules.mts --tenant-id <uuid> --modules <key,key,…> --mode plan|apply|verify
 *
 * The operator input is the Tenant and its module keys, in activation order. The Tenant must be the operator's own
 * tenant-only session and every key must be published by the active composition. `plan` reads each state. `apply` runs
 * the Action once for each module that is still inactive, re-reading the states before each one, so a module another
 * module installed with it (`installsWith`) is not activated twice. `verify` fails unless every module is active. A
 * module in an explicit state other than inactive or active (a person suspended or retired it) is never replaced.
 * It needs the app host's runtime environment (Shell auth, database, SpiceDB, active composition URL).
 */
import { randomUUID } from 'node:crypto';

import { ActionRuntime, changeTenantModuleStateAction } from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  loadCheckedActiveApplicationComposition,
} from '@app/core-runtime/modules/active-application-composition';
import { NodeServices } from '@effect/platform-node';
import { and, eq, inArray } from 'drizzle-orm';
import { Console, Effect, Exit, Result, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { AuthenticationService } from '../apps/shell-super-app/api/auth/service.ts';
import { tenantModuleStates } from '../packages/core-runtime/src/db/schema.ts';
import { StageMarketOperatorLive } from './demo/activate-market-stage.mts';
import { authenticateAgentProfileOperator } from './demo/agent-profile-operator.mts';
import { retainAgentOperatorSessionCookies } from './demo/agent-operator-session.mts';
import { AgentProfileReadDatabase } from './demo/agent-profile-setup.mts';
import { ProcessDatabasePoolsLive } from './zerops/process-database-pools.mts';

export const activationModes = ['plan', 'apply', 'verify'] as const;
export type ActivationMode = (typeof activationModes)[number];
const activationReason = 'Operator-approved tenant-wide module activation of a fresh deployment';
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;
const MODULE_KEY = /^[a-z][\da-z-]*(?:\.[a-z][\da-z-]*)+$/u;

export class TenantModuleActivationFailure extends Schema.TaggedError<TenantModuleActivationFailure>()(
  'TenantModuleActivationFailure',
  { reason: Schema.String },
) {}
const fail = (reason: string) => new TenantModuleActivationFailure({ reason });

/** The operator input: a Tenant UUID (read lowercase) and unique module keys, in the order given. */
export const parseActivationInput = (
  tenantId: string,
  modules: string,
): Result.Result<{ readonly moduleKeys: readonly string[]; readonly tenantId: string }, string> => {
  const tenant = tenantId.trim().toLowerCase();
  if (!UUID.test(tenant)) {
    return Result.fail('--tenant-id must be a UUID');
  }
  const moduleKeys = modules.split(',').map((key) => key.trim());
  if (moduleKeys.some((key) => !MODULE_KEY.test(key))) {
    return Result.fail('--modules must be a comma-separated list of module keys');
  }
  if (new Set(moduleKeys).size !== moduleKeys.length) {
    return Result.fail('--modules names a module twice');
  }
  return Result.succeed({ moduleKeys, tenantId: tenant });
};

/** The modules a mode still has to activate, from the states read; a held lifecycle state or (verify) a gap refuses. */
export const activationDecision = (
  mode: ActivationMode,
  moduleKeys: readonly string[],
  states: ReadonlyMap<string, string>,
): Result.Result<readonly string[], string> => {
  const stateOf = (moduleKey: string) => states.get(moduleKey) ?? 'inactive';
  const held = moduleKeys.filter((moduleKey) => !['inactive', 'active'].includes(stateOf(moduleKey)));
  if (held.length > 0) {
    const describe = (moduleKey: string) => [moduleKey, 'is', stateOf(moduleKey)].join(' ');
    const named = held.map(describe).join(', ');
    return Result.fail(`${named}; an explicit lifecycle state is never replaced`);
  }
  const inactive = moduleKeys.filter((moduleKey) => stateOf(moduleKey) === 'inactive');
  if (mode === 'verify' && inactive.length > 0) {
    return Result.fail(`not active: ${inactive.join(', ')}`);
  }
  return Result.succeed(inactive);
};

const decisionOf = (
  mode: ActivationMode,
  moduleKeys: readonly string[],
  rows: readonly { readonly moduleKey: string; readonly state: string }[],
) => {
  const decision = activationDecision(
    mode,
    moduleKeys,
    new Map(rows.map(({ moduleKey, state }) => [moduleKey, state])),
  );
  return Result.isFailure(decision) ? Effect.fail(fail(decision.failure)) : Effect.succeed(decision.success);
};

const main = (mode: ActivationMode, tenantIdInput: string, modulesInput: string) =>
  Effect.gen(function* activateTenantModules() {
    const input = parseActivationInput(tenantIdInput, modulesInput);
    if (Result.isFailure(input)) {
      return yield* fail(input.failure);
    }
    const { moduleKeys, tenantId } = input.success;
    const operator = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (session) =>
      session.close.pipe(Effect.ignore),
    );
    // Tenant-wide module state forbids a company scope: leave any selected company through the session itself.
    const authentication = yield* AuthenticationService;
    const switched = yield* authentication.switchToTenantContext(operator.requestHeaders);
    yield* retainAgentOperatorSessionCookies(operator.requestHeaders, switched.setCookieHeaders);
    const context = yield* authentication.resolveTenantContext(operator.requestHeaders);
    yield* retainAgentOperatorSessionCookies(operator.requestHeaders, context.setCookieHeaders);
    if (
      context.state !== 'authenticated' ||
      context.principal.principalId !== operator.principal.principalId ||
      context.principal.authMethod !== 'session' ||
      context.principal.legalEntityId !== undefined ||
      context.principal.tenantId !== tenantId
    ) {
      return yield* fail('Module activation requires a tenant-only operator session of exactly this Tenant');
    }
    const { principal } = context;
    const { catalog } = yield* loadCheckedActiveApplicationComposition(yield* ActiveApplicationCompositionService);
    const unpublished = moduleKeys.filter((moduleKey) => catalog.getByModuleId(moduleKey) === undefined);
    if (unpublished.length > 0) {
      return yield* fail(`The active composition does not publish ${unpublished.join(', ')}`);
    }
    const { executor } = yield* AgentProfileReadDatabase;
    const decide = (decisionMode: ActivationMode) =>
      executor
        .select({ moduleKey: tenantModuleStates.moduleKey, state: tenantModuleStates.state })
        .from(tenantModuleStates)
        .where(and(eq(tenantModuleStates.tenantId, tenantId), inArray(tenantModuleStates.moduleKey, [...moduleKeys])))
        .pipe(Effect.flatMap((rows) => decisionOf(decisionMode, moduleKeys, rows)));
    const pending = yield* decide(mode);
    yield* Console.log({ inactive: pending, mode, moduleKeys, tenantId });
    if (mode !== 'apply') {
      return yield* Effect.void;
    }
    const runtime = yield* ActionRuntime;
    for (const moduleKey of moduleKeys) {
      if (!(yield* decide('plan')).includes(moduleKey)) {
        continue;
      }
      yield* runtime.runAction({
        payload: { expectedState: 'inactive', moduleKey, newState: 'active', reason: activationReason },
        principal,
        registration: changeTenantModuleStateAction,
        transport: { correlationId: randomUUID(), idempotencyKey: `tenant-module-activation:${randomUUID()}` },
      });
      yield* Console.log({ activated: moduleKey, tenantId });
    }
    yield* decide('verify');
    return yield* Console.log({ active: moduleKeys, mode: 'verify', tenantId });
  }).pipe(Effect.scoped);

const command = Command.make(
  'activate-tenant-modules',
  {
    mode: Flag.Literals('mode', activationModes).pipe(Flag.withDefault('plan')),
    modules: Flag.String('modules'),
    tenantId: Flag.String('tenant-id'),
  },
  ({ mode, modules, tenantId }) =>
    main(mode, tenantId, modules).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(TenantModuleActivationFailure)(failure)
            ? `Module activation stopped: ${failure.reason}`
            : `Module activation stopped (${failure._tag}); credentials and provider details withheld`,
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
