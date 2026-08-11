import { Effect } from 'effect';
import { createCustomerHandler } from '../actions/create-customer.handler.ts';
import { bindCreateCustomerAction } from '../actions/create-customer.registration.ts';
import { deleteCustomerHandler } from '../actions/delete-customer.handler.ts';
import { bindDeleteCustomerAction } from '../actions/delete-customer.registration.ts';
import { editCustomerHandler } from '../actions/edit-customer.handler.ts';
import { bindEditCustomerAction } from '../actions/edit-customer.registration.ts';
import { makeCustomerService } from './customer-service.ts';

const customerServiceFactory = (
  transaction: Parameters<typeof makeCustomerService>[0],
  scope: { readonly tenantId: string },
) => Effect.succeed(makeCustomerService(transaction, scope.tenantId));

export const boundCreateCustomerAction = bindCreateCustomerAction(
  createCustomerHandler,
  customerServiceFactory,
);
export const boundEditCustomerAction = bindEditCustomerAction(
  editCustomerHandler,
  customerServiceFactory,
);
export const boundDeleteCustomerAction = bindDeleteCustomerAction(
  deleteCustomerHandler,
  customerServiceFactory,
);
