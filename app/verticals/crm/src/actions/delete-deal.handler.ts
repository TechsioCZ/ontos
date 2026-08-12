import type { DataAccessEventInput } from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  DeleteDealActionHandler,
  DeleteDealDomainError,
  DeleteDealPayload,
  DeleteDealResult,
} from './delete-deal.action.ts';

export interface DeleteDealServices {
  readonly deleteDeal: (
    input: DeleteDealPayload,
  ) => Effect.Effect<
    { readonly dataAccess: readonly DataAccessEventInput[]; readonly result: DeleteDealResult },
    DeleteDealDomainError
  >;
}

export const deleteDealHandler: DeleteDealActionHandler<DeleteDealServices> = (payload, context) =>
  Effect.gen(function* deleteDeal() {
    const outcome = yield* context.services.deleteDeal(payload);
    for (const evidence of outcome.dataAccess) {
      yield* context.recordDataAccess(evidence);
    }
    yield* context.addDomainEvent({
      eventType: 'crm.core.deal.deleted',
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
