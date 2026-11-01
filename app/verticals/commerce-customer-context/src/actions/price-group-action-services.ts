import { OperationContextUnavailable, requireModuleOperation } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import type {
  CustomerPriceGroupAssignmentStorePort,
  CustomerPriceGroupProfileValidationPort,
  PriceGroupCatalogPort,
} from '../../shared/domain/price-group-ports.ts';
import { priceGroupCatalogPortFromEnvironment } from '../integrations/price-group-catalog.ts';
import {
  customerPriceGroupAssignmentStoreForTransaction,
  customerPriceGroupProfileValidationForTransaction,
} from '../persistence/price-group-persistence.ts';
import type { PriceGroupRoutineInvoker } from '../persistence/price-group-persistence.ts';
import { CustomerPriceGroupCatalogUnavailable } from '../../shared/domain/price-group-errors.ts';

export interface PriceGroupActionServices {
  readonly catalog: PriceGroupCatalogPort;
  readonly now: Effect.Effect<string>;
  readonly profileValidation: CustomerPriceGroupProfileValidationPort;
  readonly store: CustomerPriceGroupAssignmentStorePort;
}

export const priceGroupActionServicesForTransaction = (
  invoker: PriceGroupRoutineInvoker,
  scope: OperationalScope,
  compositionRevision: string,
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
  return Effect.gen(function* makePriceGroupActionServices() {
    const catalog = yield* priceGroupCatalogPortFromEnvironment({
      compositionRevision,
      requestCorrelation: scope.correlationId,
      scope,
    });
    return {
      catalog,
      now: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      profileValidation: customerPriceGroupProfileValidationForTransaction(invoker, trustedScope),
      store: customerPriceGroupAssignmentStoreForTransaction(invoker, trustedScope),
    };
  });
};

const PriceGroupActionRequirementSchema = Schema.Literals([
  'commerce.customer-context.requirement.assign-customer-price-group-catalog',
  'commerce.customer-context.requirement.assign-counterparty-price-group-catalog',
  'commerce.customer-context.requirement.migrate-customer-price-group-catalog',
  'commerce.customer-context.requirement.migrate-counterparty-price-group-catalog',
]);
type PriceGroupActionRequirement = typeof PriceGroupActionRequirementSchema.Type;

const withRequiredPriceGroupCatalog = (
  services: PriceGroupActionServices,
  requirement: PriceGroupActionRequirement,
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
  compositionRevision: string,
): Effect.Effect<PriceGroupActionServices, OperationContextUnavailable> =>
  priceGroupActionServicesForTransaction(invoker, scope, compositionRevision).pipe(
    Effect.map((services) =>
      withRequiredPriceGroupCatalog(
        services,
        'commerce.customer-context.requirement.assign-customer-price-group-catalog',
      ),
    ),
  );

export const assignCounterpartyPriceGroupServicesForTransaction = (
  invoker: PriceGroupRoutineInvoker,
  scope: OperationalScope,
  compositionRevision: string,
): Effect.Effect<PriceGroupActionServices, OperationContextUnavailable> =>
  priceGroupActionServicesForTransaction(invoker, scope, compositionRevision).pipe(
    Effect.map((services) =>
      withRequiredPriceGroupCatalog(
        services,
        'commerce.customer-context.requirement.assign-counterparty-price-group-catalog',
      ),
    ),
  );

export const migrateCustomerPriceGroupServicesForTransaction = (
  invoker: PriceGroupRoutineInvoker,
  scope: OperationalScope,
  compositionRevision: string,
): Effect.Effect<PriceGroupActionServices, OperationContextUnavailable> =>
  priceGroupActionServicesForTransaction(invoker, scope, compositionRevision).pipe(
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
  compositionRevision: string,
): Effect.Effect<PriceGroupActionServices, OperationContextUnavailable> =>
  priceGroupActionServicesForTransaction(invoker, scope, compositionRevision).pipe(
    Effect.map((services) =>
      withRequiredPriceGroupCatalog(
        services,
        'commerce.customer-context.requirement.migrate-counterparty-price-group-catalog',
      ),
    ),
  );
