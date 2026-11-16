import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { DateTime, Effect } from 'effect';
import type {
  CustomerPriceGroupAssignmentStorePort,
  CustomerPriceGroupProfileValidationPort,
  PriceGroupCatalogPort,
} from '../../shared/domain/price-group-ports.ts';
import {
  customerPriceGroupAssignmentStoreForTransaction,
  customerPriceGroupProfileValidationForTransaction,
} from '../persistence/price-group-persistence.ts';
import type { PriceGroupRoutineInvoker } from '../persistence/price-group-persistence.ts';
import { CustomerPriceGroupCatalogUnavailable } from '../../shared/domain/price-group-errors.ts';
import { customerPriceGroupAssignmentReceiptCapture } from '../services/customer-price-group-assignment-receipt.service.ts';
import type { CustomerPriceGroupAssignmentReceiptCapture } from '../services/customer-price-group-assignment-receipt.service.ts';

export interface PriceGroupActionServices {
  readonly catalog: PriceGroupCatalogPort;
  readonly now: Effect.Effect<string>;
  readonly profileValidation: CustomerPriceGroupProfileValidationPort;
  readonly store: CustomerPriceGroupAssignmentStorePort;
}
export type PriceGroupAssignmentActionServices = PriceGroupActionServices & CustomerPriceGroupAssignmentReceiptCapture;

/**
 * The Price Group Catalog is another owner reached over HTTP, so it is never called from inside the Action
 * transaction. Assign and Migrate read it in their preparation (price-group-action-preparation.ts); Remove
 * needs no Catalog evidence at all.
 */
const catalogOutsidePreparation: PriceGroupCatalogPort = {
  resolveCurrent: () =>
    Effect.fail(
      new CustomerPriceGroupCatalogUnavailable({
        code: 'customer_price_group_catalog_unavailable',
        reason: 'Price Group Catalog evidence is read only during Action preparation',
      }),
    ),
};

/** Owner-local services bound to the Action transaction. */
export const priceGroupActionServicesForTransaction = (
  invoker: PriceGroupRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<PriceGroupActionServices, OperationContextUnavailable> => {
  const { legalEntityId } = scope;
  if (legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Customer PriceGroup mutations require a trusted Legal Entity scope',
      }),
    );
  }
  const trustedScope = { ...scope, legalEntityId };
  return Effect.succeed({
    catalog: catalogOutsidePreparation,
    now: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    profileValidation: customerPriceGroupProfileValidationForTransaction(invoker, trustedScope),
    store: customerPriceGroupAssignmentStoreForTransaction(invoker, trustedScope),
  });
};

const assignmentServicesForTransaction =
  (actionKey: Parameters<typeof customerPriceGroupAssignmentReceiptCapture>[2]) =>
  (
    invoker: PriceGroupRoutineInvoker,
    scope: OperationalScope,
  ): Effect.Effect<PriceGroupAssignmentActionServices, OperationContextUnavailable> =>
    priceGroupActionServicesForTransaction(invoker, scope).pipe(
      Effect.map((services) => ({
        ...services,
        ...customerPriceGroupAssignmentReceiptCapture(invoker, scope, actionKey),
      })),
    );

/** Assignments also capture their exact original-command receipt in the same owner transaction. */
export const assignCustomerPriceGroupServicesForTransaction = assignmentServicesForTransaction(
  'commerce.customer-context.assign-customer-price-group',
);
export const assignCounterpartyPriceGroupServicesForTransaction = assignmentServicesForTransaction(
  'commerce.customer-context.assign-counterparty-price-group',
);
