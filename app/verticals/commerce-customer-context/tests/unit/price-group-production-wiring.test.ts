import { readFile } from 'node:fs/promises';
import { getActionServiceFactory } from '@app/core-runtime/testing/actions';
import { getActionServicePreflight } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { CustomerPriceGroupCatalogUnavailable } from '../../shared/domain/price-group-errors.ts';
import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { PriceGroupInstantSchema, PriceGroupRefSchema } from '@app/price-group-catalog-contracts';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
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
import { delegatedGatewayConfiguration, holdDelegatedCallerKey } from '../support/delegated-gateway-shell.fixture.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const compositionRevision = 'a'.repeat(64);
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
// No verified composition revision: the cross-owner Read must refuse before wiring the catalog.
const absentCompositionRevision: string | undefined = new Map<string, string>().get('composition-revision');

// Construction must not acquire delegated context: with no delegated configuration at all, wiring still succeeds.
const constructionWithoutDelegation = Layer.mergeAll(
  nodeCryptoLayer,
  ConfigProvider.layer(ConfigProvider.fromUnknown({})),
);
const shellOrigin = new URL('https://shell.example.test');
const delegatedCallerConfiguration = Layer.merge(
  ConfigProvider.layer(delegatedGatewayConfiguration(shellOrigin)),
  Layer.effectDiscard(holdDelegatedCallerKey),
);
const priceGroupRef = Schema.decodeSync(PriceGroupRefSchema)({
  moduleId: 'pricing.price-group-catalog',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
});
const trustedOperationAt = Schema.decodeSync(PriceGroupInstantSchema)('2026-09-23T10:00:00.000Z');

const readResolutionSource = Effect.promise(() =>
  readFile(new URL('../../src/api/customer-price-group-resolution.read.ts', import.meta.url), 'utf-8'),
);

it.effect('attaches every Price Group Action and the governed resolution Read to production catalog wiring', () =>
  Effect.gen(function* readProductionWiring() {
    // Catalog evidence is prepared before the Action transaction; the transaction services stay owner-local.
    expect(getActionServicePreflight(assignCustomerPriceGroupAction)).toBe(prepareAssignCustomerPriceGroupServices);
    expect(getActionServicePreflight(assignCounterpartyPriceGroupAction)).toBe(
      prepareAssignCounterpartyPriceGroupServices,
    );
    expect(getActionServicePreflight(migrateCustomerPriceGroupAction)).toBe(prepareMigrateCustomerPriceGroupServices);
    expect(getActionServicePreflight(migrateCounterpartyPriceGroupAction)).toBe(
      prepareMigrateCounterpartyPriceGroupServices,
    );
    expect(getActionServiceFactory(assignCustomerPriceGroupAction)).toBe(
      assignCustomerPriceGroupServicesForTransaction,
    );
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
    const readFactorySource = customerPriceGroupResolutionServicesForTransaction.toString();
    expect(readFactorySource).toContain('customerPriceGroupCatalogForScope');
    expect(yield* readResolutionSource).toContain('priceGroupCatalogPortFromEnvironment');
    expect(readFactorySource).not.toContain('unavailablePriceGroupCatalogPort');
  }),
);

it('declares the Pricing caller with an identity subject on the customer Price Group resolution Read', () => {
  expect(customerPriceGroupResolutionRead.descriptor.accessActor).toMatchObject({
    callers: ['pricing'],
    subject: 'identity',
  });
});

it.effect('creates a fresh catalog adapter for every governed Read attempt', () =>
  Effect.gen(function* freshPerAttempt() {
    const firstReadServices = yield* customerPriceGroupResolutionServicesForTransaction(
      priceGroupInvoker,
      scope,
      compositionRevision,
    ).pipe(Effect.provide(constructionWithoutDelegation));
    const secondReadServices = yield* customerPriceGroupResolutionServicesForTransaction(
      priceGroupInvoker,
      scope,
      compositionRevision,
    ).pipe(Effect.provide(constructionWithoutDelegation));

    expect(firstReadServices.catalog).not.toBe(secondReadServices.catalog);
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

it.effect('rejects a cross-owner Read without a verified composition revision before wiring the catalog', () =>
  Effect.gen(function* missingCompositionRevision() {
    const failure = yield* Effect.flip(
      customerPriceGroupResolutionServicesForTransaction(priceGroupInvoker, scope, absentCompositionRevision).pipe(
        Effect.provide(constructionWithoutDelegation),
      ),
    );
    expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
  }),
);

it.effect('sends the verified request scope to the catalog as an Assertion subject, not an Originator', () =>
  Effect.gen(function* assertionCallSite() {
    // Action preparation delegates the same Assertion subject (price-group-action-preparation.test.ts).
    // The Read gates its catalog behind the module operation requirement, which only a genuine Read execution
    // satisfies; its port is built with the same Assertion subject.
    const readServices = yield* customerPriceGroupResolutionServicesForTransaction(
      priceGroupInvoker,
      scope,
      compositionRevision,
    ).pipe(Effect.provide(Layer.mergeAll(nodeCryptoLayer, delegatedCallerConfiguration)));
    const readFailure = yield* Effect.flip(
      readServices.catalog
        .resolveCurrent(priceGroupRef, CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, trustedOperationAt)
        .pipe(Effect.provide(delegatedCallerConfiguration)),
    );
    expect(readFailure).toMatchObject({ cause: { code: 'module_operation_requirement_unavailable' } });
    expect(yield* readResolutionSource).toMatch(/_tag:\s*["']Assertion["']/u);
  }),
);
