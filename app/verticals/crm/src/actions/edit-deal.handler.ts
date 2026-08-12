import type { DataAccessEventInput } from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  EditDealActionHandler,
  EditDealDomainError,
  EditDealPayload,
  EditDealResult,
} from './edit-deal.action.ts';

export interface EditDealServices {
  readonly editDeal: (
    input: EditDealPayload,
  ) => Effect.Effect<
    { readonly dataAccess: readonly DataAccessEventInput[]; readonly result: EditDealResult },
    EditDealDomainError
  >;
}

export const editDealHandler: EditDealActionHandler<EditDealServices> = (payload, context) =>
  Effect.gen(function* editDeal() {
    const outcome = yield* context.services.editDeal(payload);
    for (const evidence of outcome.dataAccess) {
      yield* context.recordDataAccess(evidence);
    }
    return outcome.result;
  });
