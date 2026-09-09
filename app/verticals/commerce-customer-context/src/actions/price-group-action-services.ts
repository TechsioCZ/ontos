import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { DateTime, Effect } from 'effect';
import type {
  CustomerPriceGroupAssignmentStorePort,
  CustomerPriceGroupProfileValidationPort,
  PriceGroupCatalogPort,
} from '../../shared/domain/price-group-ports.ts';
import { unavailablePriceGroupCatalogPort } from '../../shared/domain/price-group-resolution.ts';
import {
  customerPriceGroupAssignmentStoreForTransaction,
  customerPriceGroupProfileValidationForTransaction,
} from '../persistence/price-group-persistence.ts';
import type { PriceGroupRoutineInvoker } from '../persistence/price-group-persistence.ts';

export interface PriceGroupActionServices {
  readonly catalog: PriceGroupCatalogPort;
  readonly now: Effect.Effect<string>;
  readonly profileValidation: CustomerPriceGroupProfileValidationPort;
  readonly store: CustomerPriceGroupAssignmentStorePort;
}

export const priceGroupActionServicesForTransaction = (
  invoker: PriceGroupRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<PriceGroupActionServices, OperationContextUnavailable> => {
  if (scope.legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Customer PriceGroup mutations require a trusted Legal Entity scope',
      }),
    );
  }
  const trustedScope = { ...scope, legalEntityId: scope.legalEntityId };
  return Effect.succeed({
    catalog: unavailablePriceGroupCatalogPort,
    now: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    profileValidation: customerPriceGroupProfileValidationForTransaction(invoker, trustedScope),
    store: customerPriceGroupAssignmentStoreForTransaction(invoker, trustedScope),
  });
};
