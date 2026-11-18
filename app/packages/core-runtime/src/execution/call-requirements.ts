import { Context } from 'effect';
import type { Effect } from 'effect';

import type { AnyOperationRef } from '../sdk/index.ts';
import type { CallRequirementUnresolved } from './call-requirement-unresolved.ts';
import type { CallerSource, ResolvedCallRequirement } from './contract.ts';

/**
 * Resolves one requirement of the executing operation (`execution/requirements.ts`). Obligations: runs
 * inside the module operation execution lease the adapter keeps open (as for handlers today); uses
 * `readModuleOperationRequirement(requirementKey, source.principal)`, extended to return the
 * requirement's `callers`; requires the requirement's `entrypointKey` to be the executing operation's
 * entrypoint and its `provider` to equal the reference's provider. A provider whose `moduleId` starts
 * with `core.` is satisfied by Core itself (`providerAppId` is the Core module id, `callers` empty) and
 * is not looked up in the composition.
 */
export interface CallRequirementsService {
  readonly resolve: (
    requirementKey: string,
    operation: AnyOperationRef,
    source: CallerSource,
  ) => Effect.Effect<ResolvedCallRequirement, CallRequirementUnresolved>;
}

export class CallRequirements extends Context.Service<CallRequirements, CallRequirementsService>()(
  '@app/core-runtime/execution/call-requirements/CallRequirements',
) {}
