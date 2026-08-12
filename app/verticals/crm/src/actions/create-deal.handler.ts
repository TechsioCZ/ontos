import type { DataAccessEventInput } from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  CreateDealActionHandler,
  CreateDealDomainError,
  CreateDealPayload,
  CreateDealResult,
} from './create-deal.action.ts';

export interface CreateDealServices {
  readonly createDeal: (
    input: CreateDealPayload,
  ) => Effect.Effect<
    { readonly dataAccess: readonly DataAccessEventInput[]; readonly result: CreateDealResult },
    CreateDealDomainError
  >;
}

export const createDealHandler: CreateDealActionHandler<CreateDealServices> = (payload, context) =>
  Effect.gen(function* createDeal() {
    const outcome = yield* context.services.createDeal(payload);
    for (const evidence of outcome.dataAccess) {
      yield* context.recordDataAccess(evidence);
    }
    yield* context.addDomainEvent({
      eventType: 'crm.core.deal.created',
      payloadJson: {
        customerId: outcome.result.customerId,
        dealId: outcome.result.dealId,
      },
      producerModuleKey: 'crm.core',
      subjectModuleKey: 'crm.core',
      subjectResourceId: outcome.result.dealId,
      subjectResourceType: 'crm.core.deal',
    });
    return outcome.result;
  });
