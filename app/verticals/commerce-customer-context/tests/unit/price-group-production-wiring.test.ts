import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { getActionServiceFactory } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { getReadServiceFactory } from '../../../../packages/core-runtime/src/reads/definition.ts';

import { PriceGroupCatalogGatewayCredentialService } from '../../shared/domain/price-group-catalog-gateway-credential.ts';
import { assignCounterpartyPriceGroupAction } from '../../src/actions/assign-counterparty-price-group.action.ts';
import { assignCustomerPriceGroupAction } from '../../src/actions/assign-customer-price-group.action.ts';
import { migrateCounterpartyPriceGroupAction } from '../../src/actions/migrate-counterparty-price-group.action.ts';
import { migrateCustomerPriceGroupAction } from '../../src/actions/migrate-customer-price-group.action.ts';
import { priceGroupActionServicesForTransaction } from '../../src/actions/price-group-action-services.ts';
import { removeCounterpartyPriceGroupAction } from '../../src/actions/remove-counterparty-price-group.action.ts';
import { removeCustomerPriceGroupAction } from '../../src/actions/remove-customer-price-group.action.ts';
import {
  customerPriceGroupResolutionRead,
  customerPriceGroupResolutionServicesForTransaction,
} from '../../src/api/customer-price-group-resolution.read.ts';
import type { PriceGroupRoutineInvoker } from '../../src/persistence/price-group-persistence.ts';

interface CapturedCompositionContext {
  readonly revision?: string;
}

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

it('attaches every Price Group Action and the governed resolution Read to production catalog wiring', () => {
  expect(getActionServiceFactory(assignCustomerPriceGroupAction)).toBe(priceGroupActionServicesForTransaction);
  expect(getActionServiceFactory(assignCounterpartyPriceGroupAction)).toBe(priceGroupActionServicesForTransaction);
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
  expect(readFactorySource).toContain('priceGroupCatalogPortFromEnvironment');
  expect(readFactorySource).not.toContain('unavailablePriceGroupCatalogPort');
});

it.effect(
  'creates a fresh catalog adapter for every governed Action and Read attempt without eager credential issuance',
  () =>
    Effect.gen(function* freshPerAttempt() {
      let credentialIssues = 0;
      const credentialLayer = Layer.succeed(PriceGroupCatalogGatewayCredentialService, {
        issue: () =>
          Effect.sync(() => {
            credentialIssues += 1;
            return {
              baseUrl: new URL('https://shell.example.test/owner-api'),
              credential: Redacted.make(`Bearer production-wiring-${credentialIssues}`),
            };
          }),
      });

      const firstActionServices = yield* priceGroupActionServicesForTransaction(
        priceGroupInvoker,
        scope,
        'a'.repeat(64),
      ).pipe(Effect.provide(credentialLayer));
      const secondActionServices = yield* priceGroupActionServicesForTransaction(
        priceGroupInvoker,
        scope,
        'a'.repeat(64),
      ).pipe(Effect.provide(credentialLayer));
      const readServices = yield* customerPriceGroupResolutionServicesForTransaction(
        priceGroupInvoker,
        scope,
        'a'.repeat(64),
      ).pipe(Effect.provide(credentialLayer));

      expect(firstActionServices.catalog).not.toBe(secondActionServices.catalog);
      expect(readServices.catalog).not.toBe(firstActionServices.catalog);
      expect(credentialIssues).toBe(0);
    }),
);

it.effect('keeps both remove Actions catalog-free and rejects missing Legal Entity scope before wiring', () =>
  Effect.gen(function* removalBoundary() {
    let credentialIssues = 0;
    const credentialLayer = Layer.succeed(PriceGroupCatalogGatewayCredentialService, {
      issue: () =>
        Effect.sync(() => {
          credentialIssues += 1;
          return {
            baseUrl: new URL('https://shell.example.test/owner-api'),
            credential: Redacted.make('Bearer must-not-be-issued'),
          };
        }),
    });

    yield* priceGroupActionServicesForTransaction(priceGroupInvoker, scope, 'a'.repeat(64)).pipe(
      Effect.provide(credentialLayer),
    );
    expect(credentialIssues).toBe(0);

    const failure = yield* Effect.flip(
      priceGroupActionServicesForTransaction(priceGroupInvoker, scopeWithoutLegalEntity, 'a'.repeat(64)).pipe(
        Effect.provide(credentialLayer),
      ),
    );
    expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
    expect(credentialIssues).toBe(0);
  }),
);

it.effect(
  'rejects a cross-owner Read without its captured verified composition revision before issuing credentials',
  () =>
    Effect.gen(function* missingCompositionRevision() {
      let credentialIssues = 0;
      const missingComposition: CapturedCompositionContext = {};
      const failure = yield* customerPriceGroupResolutionServicesForTransaction(
        priceGroupInvoker,
        scope,
        missingComposition.revision,
      ).pipe(
        Effect.provide(
          Layer.succeed(PriceGroupCatalogGatewayCredentialService, {
            issue: () =>
              Effect.sync(() => {
                credentialIssues += 1;
                return {
                  baseUrl: new URL('https://shell.example.test/owner-api'),
                  credential: Redacted.make('Bearer must-not-be-issued'),
                };
              }),
          }),
        ),
        Effect.flip,
      );
      expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
      expect(credentialIssues).toBe(0);
    }),
);
