import type { Schema } from 'effect';

import type { ActionRegistration, ActionServiceFactory } from '../actions/definition.ts';
import type { DomainEventContractMap } from '../actions/events.ts';
import type { ActionSuccessContract } from '../actions/proposal-accepted.ts';
import { ActionPreparationObservation, actionPreparationObservation } from '../actions/preparation-observation.ts';
import type { RunActionInput } from '../actions/runtime.ts';

/**
 * Test-only, pull-only probe for the original registered preparation result. Run the returned input
 * through the ordinary runtime, including a native fixture's runtime. A probe cannot prepare,
 * replace or consume services. Denied, unavailable and incomplete preparation publishes nothing.
 */
export const makeActionPreparationProbe = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services,
  Requirements,
>(
  registration: ActionRegistration<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    Requirements
  >,
) => {
  const observation = new ActionPreparationObservation<ActionServiceFactory<Services, Requirements>>(registration);
  return Object.freeze({
    input: <SuccessContract extends ActionSuccessContract = 'result'>(
      input: Omit<
        RunActionInput<
          PayloadSchema,
          ResultSchema,
          DomainErrorSchema,
          DomainEvents,
          Owner,
          Services,
          Requirements,
          SuccessContract
        >,
        'registration' | typeof actionPreparationObservation
      >,
    ): RunActionInput<
      PayloadSchema,
      ResultSchema,
      DomainErrorSchema,
      DomainEvents,
      Owner,
      Services,
      Requirements,
      SuccessContract
    > => ({ ...input, [actionPreparationObservation]: observation, registration }),
    snapshot: () => observation.snapshot(),
  });
};
