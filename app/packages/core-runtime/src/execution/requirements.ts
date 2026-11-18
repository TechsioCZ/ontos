/**
 * The requirement side of a call: resolving a declared call's manifest requirement in the executing
 * operation's lease and selecting the one caller identity the execution implies. The definition-time
 * check of declared calls is `declaredCallsIssues` in `modules/module-dependency-contracts.ts`.
 */
import { Effect, Layer, Match } from 'effect';

import { isCoreOperationProvider, sameOperationProvider } from '../modules/module-dependency-contracts.ts';
import { readModuleOperationRequirement } from '../modules/module-operation-execution.ts';
import type { ExecutionIdentity, RequirementCaller } from '../sdk/index.ts';
import { CallRequirementUnresolved } from './call-requirement-unresolved.ts';
import { CallRequirements } from './call-requirements.ts';
import type { CallRequirementsService } from './call-requirements.ts';
import { CallerNotPermitted } from './caller-not-permitted.ts';
import type { ResolvedCallRequirement, SelectedCaller } from './contract.ts';

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

/** What selection reads of the execution beyond its identity. */
interface CallerFacts {
  readonly principalId: string;
  readonly recoveryRequestHash: string | undefined;
}

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
  facts: CallerFacts,
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

const relayedCaller = (permitted: readonly RequirementCaller[]): Effect.Effect<SelectedCaller, CallerNotPermitted> =>
  permittedOfKind(permitted, 'person').pipe(
    Effect.map((caller): SelectedCaller =>
      Object.freeze({ kind: 'person', legalEntityScope: caller.legalEntityScope }),
    ),
  );

/**
 * For a vertical provider only (a Core provider is `in_process` without selection). The caller identity
 * is decided by the request's verified identity kind, as the hand-built delegations did: a request
 * relays its verified scope as an `Assertion` (`person`), except a verified workload or a recovery,
 * which calls as the `registered` declaration of its requirement when the requirement declares one
 * (with `recoveryRequestHash` for a recovery and `expectedPrincipalId` when the caller pins the
 * principal; the gateway attests a workload only through a registration, and a provider that declares
 * none was always sent the relayed scope). A Core system principal has no verified workload, so it
 * relays. The chosen kind must be in `permitted`, else `CallerNotPermitted`. An Action invocation has
 * no caller kind until the Action adapter adds its admission kinds; a worker delivery calls as the
 * registered workload.
 */
export const selectCaller = (
  identity: ExecutionIdentity,
  permitted: readonly RequirementCaller[],
  facts: CallerFacts,
): Effect.Effect<SelectedCaller, CallerNotPermitted> =>
  Match.value(identity).pipe(
    Match.tagsExhaustive({
      ActionInvocation: () => Effect.fail(new CallerNotPermitted({ wanted: 'none' })),
      Request: ({ via }) => {
        const registered = permitted.find(
          (caller): caller is CallerOfKind<'registered'> => caller.kind === 'registered',
        );
        return (via === 'workload' || via === 'recovery') && registered !== undefined
          ? registeredCaller(registered, facts, via === 'recovery')
          : relayedCaller(permitted);
      },
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
