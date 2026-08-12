import { Effect } from 'effect';
import { createDealHandler } from '../actions/create-deal.handler.ts';
import { bindCreateDealAction } from '../actions/create-deal.registration.ts';
import { deleteDealHandler } from '../actions/delete-deal.handler.ts';
import { bindDeleteDealAction } from '../actions/delete-deal.registration.ts';
import { editDealHandler } from '../actions/edit-deal.handler.ts';
import { bindEditDealAction } from '../actions/edit-deal.registration.ts';
import { makeDealService } from './deal-service.ts';

const dealServiceFactory = (
  transaction: Parameters<typeof makeDealService>[0],
  scope: { readonly legalEntityId?: string; readonly tenantId: string },
) =>
  scope.legalEntityId === undefined
    ? Effect.die('Deal Actions require validated Legal Entity scope')
    : Effect.succeed(makeDealService(transaction, scope.tenantId, scope.legalEntityId));

export const boundCreateDealAction = bindCreateDealAction(createDealHandler, dealServiceFactory);
export const boundEditDealAction = bindEditDealAction(editDealHandler, dealServiceFactory);
export const boundDeleteDealAction = bindDeleteDealAction(deleteDealHandler, dealServiceFactory);
