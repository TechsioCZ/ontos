import { OperationContextUnavailable, requireModuleOperation } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import type { Crypto } from 'effect';
import { DateTime, Effect } from 'effect';
import type {
  CustomerPriceGroupAssignmentStorePort,
  CustomerPriceGroupProfileValidationPort,
  PriceGroupCatalogPort,
} from '../../shared/domain/price-group-ports.ts';
import { priceGroupCatalogPortFromEnvironment } from '../integrations/price-group-catalog.ts';
import type { PriceGroupCatalogRequirement } from '../integrations/price-group-catalog.ts';
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

export const priceGroupActionServicesForTransaction = (
  invoker: PriceGroupRoutineInvoker,
  scope: OperationalScope,
  catalogRequirement?: PriceGroupCatalogRequirement,
): Effect.Effect<PriceGroupActionServices, OperationContextUnavailable, Crypto.Crypto> => {
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
  return Effect.gen(function* makePriceGroupActionServices() {
    const catalogContext = {
      requestCorrelation: scope.correlationId,
      subject: { _tag: 'Assertion' as const, scope },
    };
    const catalog = yield* priceGroupCatalogPortFromEnvironment(
      catalogRequirement === undefined
        ? catalogContext
        : { ...catalogContext, operationRequirementKey: catalogRequirement },
    );
    return {
      catalog,
      now: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      profileValidation: customerPriceGroupProfileValidationForTransaction(invoker, trustedScope),
      store: customerPriceGroupAssignmentStoreForTransaction(invoker, trustedScope),
    };
  });
};

const withRequiredPriceGroupCatalog = (
  services: PriceGroupActionServices,
  requirement: PriceGroupCatalogRequirement,
): PriceGroupActionServices => ({
  ...services,
  catalog: {
    resolveCurrent: (...args) =>
      requireModuleOperation(requirement).pipe(
        Effect.mapError((cause) =>
          Object.defineProperty(
            new CustomerPriceGroupCatalogUnavailable({
              code: 'customer_price_group_catalog_unavailable',
              reason: 'Required Price Group Catalog operation is unavailable',
            }),
            'cause',
            { configurable: true, value: cause },
          ),
        ),
        Effect.flatMap(() => services.catalog.resolveCurrent(...args)),
      ),
  },
});

export const assignCustomerPriceGroupServicesForTransaction = (
  invoker: PriceGroupRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<PriceGroupAssignmentActionServices, OperationContextUnavailable, Crypto.Crypto> =>
  priceGroupActionServicesForTransaction(
    invoker,
    scope,
    'commerce.customer-context.requirement.assign-customer-price-group-catalog',
  ).pipe(
    Effect.map((services) => ({
      ...withRequiredPriceGroupCatalog(
        services,
        'commerce.customer-context.requirement.assign-customer-price-group-catalog',
      ),
      ...customerPriceGroupAssignmentReceiptCapture(
        invoker,
        scope,
        'commerce.customer-context.assign-customer-price-group',
      ),
    })),
  );

export const assignCounterpartyPriceGroupServicesForTransaction = (
  invoker: PriceGroupRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<PriceGroupAssignmentActionServices, OperationContextUnavailable, Crypto.Crypto> =>
  priceGroupActionServicesForTransaction(
    invoker,
    scope,
    'commerce.customer-context.requirement.assign-counterparty-price-group-catalog',
  ).pipe(
    Effect.map((services) => ({
      ...withRequiredPriceGroupCatalog(
        services,
        'commerce.customer-context.requirement.assign-counterparty-price-group-catalog',
      ),
      ...customerPriceGroupAssignmentReceiptCapture(
        invoker,
        scope,
        'commerce.customer-context.assign-counterparty-price-group',
      ),
    })),
  );

export const migrateCustomerPriceGroupServicesForTransaction = (
  invoker: PriceGroupRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<PriceGroupActionServices, OperationContextUnavailable, Crypto.Crypto> =>
  priceGroupActionServicesForTransaction(
    invoker,
    scope,
    'commerce.customer-context.requirement.migrate-customer-price-group-catalog',
  ).pipe(
    Effect.map((services) =>
      withRequiredPriceGroupCatalog(
        services,
        'commerce.customer-context.requirement.migrate-customer-price-group-catalog',
      ),
    ),
  );

export const migrateCounterpartyPriceGroupServicesForTransaction = (
  invoker: PriceGroupRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<PriceGroupActionServices, OperationContextUnavailable, Crypto.Crypto> =>
  priceGroupActionServicesForTransaction(
    invoker,
    scope,
    'commerce.customer-context.requirement.migrate-counterparty-price-group-catalog',
  ).pipe(
    Effect.map((services) =>
      withRequiredPriceGroupCatalog(
        services,
        'commerce.customer-context.requirement.migrate-counterparty-price-group-catalog',
      ),
    ),
  );
