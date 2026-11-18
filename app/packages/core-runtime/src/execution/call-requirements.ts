import { Context } from 'effect';
import type { Effect } from 'effect';

import type { AnyOperationRef } from '../sdk/index.ts';
import type { CallRequirementUnresolved } from './call-requirement-unresolved.ts';
import type { CallerSource, ResolvedCallRequirement } from './contract.ts';

/** Resolves one requirement of the executing operation; implemented in `execution/requirements.ts`. */
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
