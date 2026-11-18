/**
 * The requirement side of a call: resolving a declared call's manifest requirement in the executing
 * operation's lease, selecting the one caller identity the execution implies, and the definition-time
 * check of every declared call against the calling module's manifest.
 */
import { Effect, Layer, Match } from 'effect';

import {
  declaredCallsIssues,
  isCoreOperationProvider,
  sameOperationProvider,
} from '../modules/module-dependency-contracts.ts';
import { readModuleOperationRequirement } from '../modules/module-operation-execution.ts';
import type { RequirementCaller } from '../sdk/index.ts';
import { CallRequirementUnresolved } from './call-requirement-unresolved.ts';
import { CallRequirements } from './call-requirements.ts';
import type { CallRequirementsService } from './call-requirements.ts';
import { CallerNotPermitted } from './caller-not-permitted.ts';
import type { ResolvedCallRequirement, SelectCaller, SelectedCaller, ValidateDeclaredCalls } from './contract.ts';

/* ------------------------------------------------------------------------------------------------ */
/* Requirement lookup                                                                               */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The lease already proves that the requirement belongs to the executing operation's own manifest
 * entrypoint, and resolves a Core provider without the composition. What remains here is that the
 * reference the module passed names exactly the provider the manifest declares.
 */
const resolve: CallRequirementsService['resolve'] = (requirementKey, operation, source) =>
  readModuleOperationRequirement(requirementKey, source.principal).pipe(
    Effect.mapError(
      ({ code }) =>
        new CallRequirementUnresolved({
          reason: code === 'module_operation_requirement_unsatisfied' ? 'not_declared' : 'lease_mismatch',
        }),
    ),
    Effect.flatMap((fact) => {
      const provider = Object.freeze({
        entrypointKey: fact.providerEntrypointKey,
        moduleId: fact.providerModuleId,
        schemaVersion: fact.providerSchemaVersion,
      });
      if (fact.requirementKey !== requirementKey || !sameOperationProvider(provider, operation.provider)) {
        return Effect.fail(new CallRequirementUnresolved({ reason: 'provider_mismatch' }));
      }
      const resolved: ResolvedCallRequirement = Object.freeze({
        callers: isCoreOperationProvider(provider) ? Object.freeze([]) : (fact.callers ?? Object.freeze([])),
        compositionRevision: fact.compositionRevision,
        provider,
        providerAppId: fact.providerAppId,
        requirementKey: fact.requirementKey,
      });
      return Effect.succeed(resolved);
    }),
  );

export const CallRequirementsLive: Layer.Layer<CallRequirements> = Layer.succeed(
  CallRequirements,
  CallRequirements.of({ resolve }),
);

/* ------------------------------------------------------------------------------------------------ */
/* Caller selection                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

type CallerOfKind<Kind extends RequirementCaller['kind']> = Extract<RequirementCaller, { readonly kind: Kind }>;

const permittedOfKind = <Kind extends RequirementCaller['kind']>(
  permitted: readonly RequirementCaller[],
  kind: Kind,
): Effect.Effect<CallerOfKind<Kind>, CallerNotPermitted> => {
  const found = permitted.find((caller): caller is CallerOfKind<Kind> => caller.kind === kind);
  return found === undefined ? Effect.fail(new CallerNotPermitted({ wanted: kind })) : Effect.succeed(found);
};

const registeredCaller = (
  caller: CallerOfKind<'registered'>,
  facts: Parameters<SelectCaller>[2],
  recovery: boolean,
): Effect.Effect<SelectedCaller, CallerNotPermitted> => {
  const base = {
    declarationKey: caller.declarationKey,
    kind: 'registered' as const,
    legalEntityScope: caller.legalEntityScope,
  };
  const pinned = caller.pinPrincipal ? { ...base, expectedPrincipalId: facts.principalId } : base;
  if (!recovery) {
    return Effect.succeed(Object.freeze(pinned));
  }
  // A recovery is admitted only for the exact call input it names; without the hash there is none.
  return facts.recoveryRequestHash === undefined
    ? Effect.fail(new CallerNotPermitted({ wanted: 'registered' }))
    : Effect.succeed(Object.freeze({ ...pinned, recoveryRequestHash: facts.recoveryRequestHash }));
};

/**
 * The one caller kind the execution identity implies, required among `permitted`; never another kind.
 * A person relays as the person; a verified workload, a recovery and a Core system principal call as
 * the module registered for them; an Action invocation has no caller kind until the Action adapter adds
 * its admission kinds; a worker delivery calls as the registered workload.
 */
export const selectCaller: SelectCaller = (identity, permitted, facts) =>
  Match.value(identity).pipe(
    Match.tagsExhaustive({
      ActionInvocation: () => Effect.fail(new CallerNotPermitted({ wanted: 'none' })),
      Request: ({ via }) =>
        via === 'person'
          ? permittedOfKind(permitted, 'person').pipe(
              Effect.map((caller): SelectedCaller =>
                Object.freeze({ kind: 'person', legalEntityScope: caller.legalEntityScope }),
              ),
            )
          : permittedOfKind(permitted, 'registered').pipe(
              Effect.flatMap((caller) => registeredCaller(caller, facts, via === 'recovery')),
            ),
      WorkerDelivery: () =>
        permittedOfKind(permitted, 'workload').pipe(
          Effect.map((caller): SelectedCaller =>
            Object.freeze({
              declarationKey: caller.declarationKey,
              kind: 'workload',
              legalEntityScope: caller.legalEntityScope,
            }),
          ),
        ),
    }),
  );

/* ------------------------------------------------------------------------------------------------ */
/* Definition-time check                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Every issue of every declared call, in declaration order; empty means valid. The rules live beside
 * the manifest's own requirement rules (`modules/module-dependency-contracts.ts`), where the runtime
 * registration that runs them reads them without importing the execution engine.
 */
export const validateDeclaredCalls: ValidateDeclaredCalls = declaredCallsIssues;
