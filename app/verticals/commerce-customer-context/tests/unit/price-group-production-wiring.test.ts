import { getActionServiceFactory } from '@app/core-runtime/testing/actions';
import { getActionServicePreflight } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { commerceCustomerContextManifest } from '../../vertical.manifest.ts';
import { CustomerPriceGroupCatalogUnavailable } from '../../shared/domain/price-group-errors.ts';
import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { PriceGroupInstantSchema, PriceGroupRefSchema } from '@app/price-group-catalog-contracts';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { getReadServiceFactory } from '@app/core-runtime/testing/reads';

import { assignCounterpartyPriceGroupAction } from '../../src/actions/assign-counterparty-price-group.action.ts';
import { assignCustomerPriceGroupAction } from '../../src/actions/assign-customer-price-group.action.ts';
import { migrateCounterpartyPriceGroupAction } from '../../src/actions/migrate-counterparty-price-group.action.ts';
import { migrateCustomerPriceGroupAction } from '../../src/actions/migrate-customer-price-group.action.ts';
import {
  prepareAssignCounterpartyPriceGroupServices,
  prepareAssignCustomerPriceGroupServices,
  prepareMigrateCounterpartyPriceGroupServices,
  prepareMigrateCustomerPriceGroupServices,
} from '../../src/actions/price-group-action-preparation.ts';
import {
  assignCounterpartyPriceGroupServicesForTransaction,
  assignCustomerPriceGroupServicesForTransaction,
  priceGroupActionServicesForTransaction,
} from '../../src/actions/price-group-action-services.ts';
import { removeCounterpartyPriceGroupAction } from '../../src/actions/remove-counterparty-price-group.action.ts';
import { removeCustomerPriceGroupAction } from '../../src/actions/remove-customer-price-group.action.ts';
import {
  customerPriceGroupResolutionRead,
  customerPriceGroupResolutionServicesForTransaction,
} from '../../src/api/customer-price-group-resolution.read.ts';
import type { PriceGroupRoutineInvoker } from '../../src/persistence/price-group-persistence.ts';
import { CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT } from '../../shared/domain/price-group-ports.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const scopeFields = {
  authBindingId: '30000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:price-group-production-wiring',
  authMethod: 'session',
  correlationId: 'price-group-production-wiring',
  legalEntityId,
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId,
} as const;
// SAFETY: the fixed UUID and session fields satisfy the trusted test-context contract.
const scope = scopeFields as OperationalScope & { readonly legalEntityId: string };

const routineInvoker = {
  invoke: () => Effect.die('production-wiring tests must not invoke persistence'),
};
// SAFETY: Price Group persistence consumes only `invoke`; this fake supplies that exact test seam.
const priceGroupInvoker = routineInvoker as PriceGroupRoutineInvoker;
const scopeWithoutLegalEntity: OperationalScope = {
  authBindingId: scope.authBindingId,
  authContextRef: scope.authContextRef,
  authMethod: scope.authMethod,
  correlationId: scope.correlationId,
  principalId: scope.principalId,
  tenantId: scope.tenantId,
};

const priceGroupRef = Schema.decodeSync(PriceGroupRefSchema)({
  moduleId: 'pricing.price-group-catalog',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
});
const trustedOperationAt = Schema.decodeSync(PriceGroupInstantSchema)('2026-09-23T10:00:00.000Z');

it('attaches every Price Group Action and the governed resolution Read to production catalog wiring', () => {
  // Catalog evidence is prepared before the Action transaction; the transaction services stay owner-local.
  expect(getActionServicePreflight(assignCustomerPriceGroupAction)).toBe(prepareAssignCustomerPriceGroupServices);
  expect(getActionServicePreflight(assignCounterpartyPriceGroupAction)).toBe(
    prepareAssignCounterpartyPriceGroupServices,
  );
  expect(getActionServicePreflight(migrateCustomerPriceGroupAction)).toBe(prepareMigrateCustomerPriceGroupServices);
  expect(getActionServicePreflight(migrateCounterpartyPriceGroupAction)).toBe(
    prepareMigrateCounterpartyPriceGroupServices,
  );
  expect(getActionServiceFactory(assignCustomerPriceGroupAction)).toBe(assignCustomerPriceGroupServicesForTransaction);
  expect(getActionServiceFactory(assignCounterpartyPriceGroupAction)).toBe(
    assignCounterpartyPriceGroupServicesForTransaction,
  );
  expect(getActionServiceFactory(migrateCustomerPriceGroupAction)).toBe(priceGroupActionServicesForTransaction);
  expect(getActionServiceFactory(migrateCounterpartyPriceGroupAction)).toBe(priceGroupActionServicesForTransaction);

  expect(getActionServiceFactory(removeCustomerPriceGroupAction).toString()).toContain(
    'priceGroupActionServicesForTransaction',
  );
  expect(getActionServiceFactory(removeCounterpartyPriceGroupAction).toString()).toContain(
    'priceGroupActionServicesForTransaction',
  );

  expect(getReadServiceFactory(customerPriceGroupResolutionRead)).toBe(
    customerPriceGroupResolutionServicesForTransaction,
  );
  // The Read reaches the Catalog only through Core's call: its owner services build no catalog client.
  const readFactorySource = customerPriceGroupResolutionServicesForTransaction.toString();
  expect(readFactorySource).not.toContain('priceGroupCatalogPortFromEnvironment');
  expect(readFactorySource).not.toContain('acquireDelegatedGatewayContext');
  expect(readFactorySource).not.toContain('unavailablePriceGroupCatalogPort');
});

it('declares the Pricing caller with an identity subject on the customer Price Group resolution Read', () => {
  expect(customerPriceGroupResolutionRead.descriptor.accessActor).toMatchObject({
    callers: ['pricing'],
    subject: 'identity',
  });
});

it.effect('builds no catalog adapter for the Read: its owner services are owner-local', () =>
  Effect.gen(function* readServicesOwnerLocal() {
    const readServices = yield* customerPriceGroupResolutionServicesForTransaction(priceGroupInvoker, scope);

    expect(readServices).toEqual({
      now: expect.anything(),
      profileValidation: expect.anything(),
      store: expect.anything(),
    });
  }),
);

it.effect('keeps the transaction services catalog-free and rejects missing Legal Entity scope before wiring', () =>
  Effect.gen(function* removalBoundary() {
    const services = yield* priceGroupActionServicesForTransaction(priceGroupInvoker, scope);
    // Inside the transaction the Catalog is never reached; only preparation can supply its evidence.
    const inTransaction = yield* Effect.flip(
      services.catalog.resolveCurrent(priceGroupRef, CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, trustedOperationAt),
    );
    expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(inTransaction)).toBe(true);

    const failure = yield* Effect.flip(
      priceGroupActionServicesForTransaction(priceGroupInvoker, scopeWithoutLegalEntity),
    );
    expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
  }),
);

it.effect('rejects a Read scope without a trusted Legal Entity before building owner services', () =>
  Effect.gen(function* missingLegalEntity() {
    const failure = yield* Effect.flip(
      customerPriceGroupResolutionServicesForTransaction(priceGroupInvoker, scopeWithoutLegalEntity),
    );
    expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
  }),
);

it('declares the Catalog call with the caller identities the hand-built delegation used', () => {
  const requirement = commerceCustomerContextManifest.requirements?.operations.find(
    ({ key }) => key === 'commerce.customer-context.requirement.price-group-single-assignment',
  );
  expect(requirement?.entrypointKey).toBe(customerPriceGroupResolutionRead.descriptor.entrypoint.entrypointKey);
  // A person is relayed as itself; any other requester calls as this module under the Catalog's
  // compatibility declaration, which the module's registered workload calls carry.
  expect(requirement?.callers).toEqual([
    { kind: 'person', legalEntityScope: 'tenant' },
    {
      declarationKey: 'pricing.price-group-catalog.price-group.read.compatibility',
      kind: 'registered',
      legalEntityScope: 'tenant',
      pinPrincipal: false,
    },
  ]);
  expect(
    commerceCustomerContextManifest.registeredWorkloadCalls?.some(
      ({ declarationKey, entrypointKey }) =>
        declarationKey === 'pricing.price-group-catalog.price-group.read.compatibility' &&
        entrypointKey === requirement?.provider.entrypointKey,
    ),
  ).toBe(true);
});
