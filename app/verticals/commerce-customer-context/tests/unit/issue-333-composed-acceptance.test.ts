import { CurrentPaymentTermsResponseSchema } from '@app/payment-term-catalog-contracts';
import type { PaymentTermDefinition } from '@app/payment-term-catalog-contracts';
import { CurrentSupportedCurrenciesResponseSchema } from '@app/pricing-contracts';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CZECH_LAUNCH_COMMERCE_FIXTURE,
  validateCzechLaunchActivation,
  validateCzechLaunchFixtureContracts,
} from '../../../../scripts/czech-launch-commerce-fixture.mts';
import { CatalogQuantityGatewayCredentialService } from '../../shared/domain/catalog-quantity-gateway-credential.ts';
import { CommerceQuantityCatalogLineRequestSchema } from '../../shared/domain/commerce-quantity-catalog-port.ts';
import {
  CustomerCommercePolicyChangedTagSchema,
  CustomerCommercePolicyTrustedActionContextSchema,
  PaymentTermPolicyAdministrationPayloadSchema,
  PurchaseCurrencyPolicyAdministrationPayloadSchema,
  administerPaymentTermPolicy,
  administerPurchaseCurrencyPolicy,
  currentPaymentTermPolicySet,
  currentPurchaseCurrencyPolicySet,
  emptyCustomerCommercePolicySet,
  toTrustedPaymentTermPolicyAdministrationCommand,
  toTrustedPurchaseCurrencyPolicyAdministrationCommand,
} from '../../shared/domain/customer-commerce-policy-administration.ts';
import type { CustomerCommercePolicySet } from '../../shared/domain/customer-commerce-policy-administration.ts';
import type {
  PaymentTermPolicyRevision,
  PurchaseCurrencyPolicyRevision,
} from '../../shared/domain/customer-commerce-policy.ts';
import { PaymentTermCatalogGatewayCredentialService } from '../../shared/domain/payment-term-catalog-gateway-credential.ts';
import { unavailablePurchaseCurrencyPurchasingContextPort } from '../../shared/domain/purchase-currency-context-port.ts';
import { PurchaseCurrencyDependencyUnavailable } from '../../shared/domain/purchase-currency-dependency.ts';
import { PurchaseCurrencyPricingGatewayCredentialService } from '../../shared/domain/purchase-currency-pricing-gateway-credential.ts';
import { catalogQuantityPortFromEnvironment } from '../../src/integrations/catalog-quantity.ts';
import { customerCommercePaymentTermsPolicyResolver } from '../../src/integrations/customer-commerce-payment-terms-policy.ts';
import { paymentTermCatalogPortFromEnvironment } from '../../src/integrations/payment-term-catalog.ts';
import { purchaseCurrencyPolicyPortForRepository } from '../../src/integrations/purchase-currency-policy.ts';
import { purchaseCurrencyPricingPortFromEnvironment } from '../../src/integrations/purchase-currency-pricing.ts';

const effectiveAt = '2026-10-01T00:00:00.000Z';
const fixtureScope = CZECH_LAUNCH_COMMERCE_FIXTURE.scope;
const [paymentTermDefinition] = CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts.paymentTermCatalog.current;

const requireFixtureOwner = <Value>(value: Value | undefined, owner: string): Value => {
  if (value === undefined) {
    throw new Error(`Czech Launch fixture is missing ${owner} evidence`);
  }
  return value;
};

const currentPaymentTerm = requireFixtureOwner(paymentTermDefinition, 'Payment Term');

const trustedPolicyContext = Schema.decodeUnknownSync(CustomerCommercePolicyTrustedActionContextSchema)({
  actionInvocationId: '71000000-0000-4000-8000-000000000001',
  actorPrincipalId: '71000000-0000-4000-8000-000000000002',
  sellingLegalEntityId: fixtureScope.sellingLegalEntityId,
  tenantId: fixtureScope.tenantId,
});

const persistedCzechLaunchPolicyStates = () => {
  let purchaseCurrency: CustomerCommercePolicySet<PurchaseCurrencyPolicyRevision> =
    emptyCustomerCommercePolicySet('PURCHASE_CURRENCY');
  for (const fixturePayload of CZECH_LAUNCH_COMMERCE_FIXTURE.policies.purchaseCurrency) {
    const payload = Schema.decodeUnknownSync(PurchaseCurrencyPolicyAdministrationPayloadSchema)(fixturePayload);
    const result = administerPurchaseCurrencyPolicy(
      purchaseCurrency,
      toTrustedPurchaseCurrencyPolicyAdministrationCommand(payload, trustedPolicyContext, effectiveAt),
    );
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(result)) {
      throw new Error(`Czech Launch Purchase Currency policy command was rejected: ${result._tag}`);
    }
    purchaseCurrency = result.state;
  }

  let paymentTerm: CustomerCommercePolicySet<PaymentTermPolicyRevision> =
    emptyCustomerCommercePolicySet('PAYMENT_TERM');
  for (const fixturePayload of CZECH_LAUNCH_COMMERCE_FIXTURE.policies.paymentTerm) {
    const payload = Schema.decodeUnknownSync(PaymentTermPolicyAdministrationPayloadSchema)(fixturePayload);
    const result = administerPaymentTermPolicy(
      paymentTerm,
      toTrustedPaymentTermPolicyAdministrationCommand(payload, trustedPolicyContext, effectiveAt),
    );
    if (!Schema.is(CustomerCommercePolicyChangedTagSchema)(result)) {
      throw new Error(`Czech Launch Payment Term policy command was rejected: ${result._tag}`);
    }
    paymentTerm = result.state;
  }

  return { paymentTerm, purchaseCurrency };
};

it.effect('composes the Czech Launch inventory and four policy defaults behind governed contracts', () =>
  Effect.gen(function* composedLaunch() {
    yield* validateCzechLaunchFixtureContracts();
    yield* validateCzechLaunchActivation(CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts);

    const { channelId, marketId, sellingLegalEntityId, storefrontId, tenantId } = CZECH_LAUNCH_COMMERCE_FIXTURE.scope;
    const purchasingContextFailure = yield* unavailablePurchaseCurrencyPurchasingContextPort()
      .resolveCurrent({
        claimedContext: {
          cartId: 'czech-launch-cart',
          channelId,
          marketId,
          sellingLegalEntityId,
          storefrontId,
          tenantId,
        },
        claimedContextRevision: 'commerce.cart.context:czech-launch-v1',
        claimedSubject: {
          guestEvidenceRef: 'commerce.customer-context.guest-evidence:czech-launch',
          guestSessionRef: 'commerce.cart.guest-session:czech-launch',
          kind: 'GUEST',
        },
        observedAt: '2026-10-01T00:00:00.000Z',
        scope: { legalEntityId: sellingLegalEntityId, storefrontId, tenantId },
      })
      .pipe(Effect.flip);
    expect(Schema.is(PurchaseCurrencyDependencyUnavailable)(purchasingContextFailure)).toBe(true);
    if (Schema.is(PurchaseCurrencyDependencyUnavailable)(purchasingContextFailure)) {
      expect(purchasingContextFailure.code).toBe('purchasing_context_unavailable');
      expect(purchasingContextFailure.retryable).toBe(true);
    }

    expect(
      CZECH_LAUNCH_COMMERCE_FIXTURE.policies.purchaseCurrency.map(({ expectedGeneration, revision }) => ({
        expectedGeneration,
        value: revision.value,
      })),
    ).toEqual([
      {
        expectedGeneration: 0,
        value: { currencyCode: 'CZK', kind: 'ALLOWED_CURRENCY_CONSTRAINT' },
      },
      {
        expectedGeneration: 1,
        value: { currencyCode: 'CZK', kind: 'DEFAULT_CURRENCY' },
      },
    ]);
    expect(
      CZECH_LAUNCH_COMMERCE_FIXTURE.policies.paymentTerm.map(({ expectedGeneration, revision }) => ({
        expectedGeneration,
        value: revision.value,
      })),
    ).toEqual([
      {
        expectedGeneration: 0,
        value: {
          kind: 'APPLICABLE_PAYMENT_TERM_CONSTRAINT',
          paymentTermRef: {
            moduleId: 'payment.term-catalog',
            resourceId: '78000000-0000-4000-8000-000000000014',
            resourceType: 'payment.term-catalog.payment-term',
            tenantId: '70000000-0000-4000-8000-000000000010',
          },
        },
      },
      {
        expectedGeneration: 1,
        value: {
          kind: 'FALLBACK_PAYMENT_TERM',
          paymentTermRef: {
            moduleId: 'payment.term-catalog',
            resourceId: '78000000-0000-4000-8000-000000000014',
            resourceType: 'payment.term-catalog.payment-term',
            tenantId: '70000000-0000-4000-8000-000000000010',
          },
        },
      },
    ]);
    expect(CZECH_LAUNCH_COMMERCE_FIXTURE.policies.quantity.revision.value).toEqual({
      basis: {
        targetDivisibilityRevision: 1,
        targetRef: {
          moduleId: 'commerce.catalog',
          resourceId: '76000000-0000-4000-8000-000000000015',
          resourceType: 'commerce.catalog.package-definition',
          tenantId: '70000000-0000-4000-8000-000000000010',
        },
        unitRef: {
          moduleId: 'commerce.catalog',
          resourceId: '76000000-0000-4000-8000-000000000020',
          resourceType: 'commerce.catalog.product-unit',
          tenantId: '70000000-0000-4000-8000-000000000010',
        },
        unitRuleRevision: 1,
      },
      constraintMode: 'REPLACEABLE_ENVELOPE',
      envelope: { kind: 'BOUNDED', maximum: null, minimum: '1', multiple: '1' },
      kind: 'COMMERCE_QUANTITY_RULE',
      selector: {
        kind: 'PACKAGE_OPTION',
        packageOptionRef: {
          moduleId: 'commerce.catalog',
          resourceId: '76000000-0000-4000-8000-000000000015',
          resourceType: 'commerce.catalog.package-definition',
          tenantId: '70000000-0000-4000-8000-000000000010',
        },
      },
    });
  }),
);

it.effect('proves #333 Current Currency and Payment Term owner ports independently of future Cart composition', () =>
  Effect.gen(function* currentPolicyPorts() {
    const states = persistedCzechLaunchPolicyStates();
    const purchasingContext = {
      channelId: fixtureScope.channelId,
      marketId: fixtureScope.marketId,
      sellingLegalEntityId: fixtureScope.sellingLegalEntityId,
      storefrontId: fixtureScope.storefrontId,
    };
    const currencyPort = purchaseCurrencyPolicyPortForRepository({
      loadPurchaseCurrencyPolicyState: Effect.succeed(states.purchaseCurrency),
    });
    const currency = yield* currencyPort.resolveCurrent({
      context: {
        contextRevision: 'commerce.cart.context:czech-launch-v1',
        purchasingContext: { ...purchasingContext, cartId: 'czech-launch-cart', tenantId: fixtureScope.tenantId },
      },
      observedAt: effectiveAt,
      subject: {
        guestEvidenceRef: 'commerce.customer-context.guest-evidence:czech-launch',
        guestSessionRef: 'commerce.cart.guest-session:czech-launch',
        kind: 'GUEST',
      },
    });
    const paymentTermResolver = customerCommercePaymentTermsPolicyResolver(
      'PROFILE',
      { tenantId: fixtureScope.tenantId, trustedStorefrontId: fixtureScope.storefrontId },
      {
        readCurrentPaymentTermPolicy: (at) => Effect.succeed(currentPaymentTermPolicySet(states.paymentTerm, at)),
      },
    );
    const paymentTerm = yield* paymentTermResolver.resolve({ at: effectiveAt, purchasingContext });

    expect(currentPurchaseCurrencyPolicySet(states.purchaseCurrency, effectiveAt)).toEqual(
      CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts.customerCommercePolicies.purchaseCurrency,
    );
    expect(currency).toEqual({
      allowedCurrencies: ['CZK'],
      completeness: CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts.customerCommercePolicies.purchaseCurrency.completeness,
      defaultCurrency: 'CZK',
      policyRevisionIds:
        CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts.customerCommercePolicies.purchaseCurrency.candidates.map(
          ({ policyRevisionId }) => policyRevisionId,
        ),
    });
    expect(currentPaymentTermPolicySet(states.paymentTerm, effectiveAt)).toEqual(
      CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts.customerCommercePolicies.paymentTerm,
    );
    expect(paymentTerm).toEqual({
      eligiblePaymentTermRefs: [currentPaymentTerm.paymentTermRef],
      explicitlyPermittedPaymentTermRefs: [],
      fallbackPaymentTermRefs: [currentPaymentTerm.paymentTermRef],
      policyRevision: 'PAYMENT_TERM:2',
      policySource: 'commerce.customer-context/payment-term-policy-current',
    });
  }),
);

it.effect('uses the Payment Term production adapter with the exact owner reference and semantic revision', () => {
  const gatewayRequests: unknown[] = [];
  const ownerCalls: unknown[] = [];
  const ownerResponse = Schema.decodeUnknownSync(CurrentPaymentTermsResponseSchema)({
    ...CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts.paymentTermCatalog,
    referenceOutcomes: [
      {
        definition: currentPaymentTerm,
        kind: 'USABLE',
        requestedPaymentTermRef: currentPaymentTerm.paymentTermRef,
      },
    ],
  });

  return Effect.gen(function* paymentTermOwnerAdapter() {
    const port = yield* paymentTermCatalogPortFromEnvironment(
      {
        legalEntityId: fixtureScope.sellingLegalEntityId,
        requestCorrelation: 'czech-launch-payment-term',
      },
      (payload, credential, correlation) => {
        ownerCalls.push({ correlation, credential: Redacted.value(credential), payload });
        return Effect.succeed(ownerResponse);
      },
    );
    const definitions = yield* port.resolveDefinitions([
      {
        at: effectiveAt,
        expectedSemanticRevisionId: currentPaymentTerm.semanticRevisionId,
        paymentTermRef: currentPaymentTerm.paymentTermRef,
      },
    ]);

    expect(ownerCalls).toEqual([
      {
        correlation: 'czech-launch-payment-term',
        credential: 'Bearer payment-term-owner-issued',
        payload: {
          at: effectiveAt,
          limit: 1,
          references: [
            {
              expectedConsumerCompatibility: 'customer-payment-terms.v1',
              expectedSemanticRevisionId: currentPaymentTerm.semanticRevisionId,
              paymentTermRef: currentPaymentTerm.paymentTermRef,
            },
          ],
        },
      },
    ]);
    expect(gatewayRequests).toEqual([
      {
        audience: 'payment-term-catalog',
        legalEntityId: fixtureScope.sellingLegalEntityId,
        requestCorrelation: 'czech-launch-payment-term',
      },
    ]);
    expect(definitions).toEqual([currentPaymentTerm satisfies PaymentTermDefinition]);
  }).pipe(
    Effect.provide(
      Layer.succeed(PaymentTermCatalogGatewayCredentialService, {
        issue: (input) =>
          Effect.sync(() => {
            gatewayRequests.push(input);
            return Redacted.make('Bearer payment-term-owner-issued');
          }),
      }),
    ),
  );
});

it.effect('uses the Catalog production adapter and preserves owner quantity evidence and revisions', () => {
  const gatewayRequests: unknown[] = [];
  const ownerCalls: unknown[] = [];

  return Effect.gen(function* catalogQuantityOwnerAdapter() {
    const catalogOwnerResponse = yield* validateCzechLaunchActivation(CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts).pipe(
      Effect.flatMap(({ catalogQuantity }) =>
        catalogQuantity.status === 'READY'
          ? Effect.succeed(catalogQuantity)
          : Effect.die('Validated Czech Launch Catalog Quantity evidence must be READY'),
      ),
    );
    const catalogLine = Schema.decodeUnknownSync(CommerceQuantityCatalogLineRequestSchema)({
      lineId: 'czech-launch-line-1',
      requestedQuantity: catalogOwnerResponse.quantity.requested,
      selection: catalogOwnerResponse.selection,
    });
    const port = yield* catalogQuantityPortFromEnvironment(
      { legalEntityId: fixtureScope.sellingLegalEntityId, requestCorrelation: 'czech-launch-catalog-quantity' },
      (payload, credential, correlation, options) => {
        ownerCalls.push({ correlation, credential: Redacted.value(credential), options, payload });
        return Effect.succeed(catalogOwnerResponse);
      },
    );
    const lines = yield* port.resolveCurrentSelections({
      lines: [catalogLine],
      observedAt: effectiveAt,
      tenantId: fixtureScope.tenantId,
    });

    expect(ownerCalls).toEqual([
      {
        correlation: 'czech-launch-catalog-quantity',
        credential: 'Bearer catalog-owner-issued',
        options: { baseUrl: new URL('https://catalog.example.test') },
        payload: {
          amount: catalogOwnerResponse.quantity.requested,
          purpose: 'PURCHASE_ACCEPTANCE',
          selection: catalogOwnerResponse.selection,
        },
      },
    ]);
    expect(gatewayRequests).toEqual([
      {
        audience: 'catalog',
        legalEntityId: fixtureScope.sellingLegalEntityId,
        requestCorrelation: 'czech-launch-catalog-quantity',
      },
    ]);
    expect(lines).toEqual([
      {
        lineId: 'czech-launch-line-1',
        selection: {
          basis: catalogOwnerResponse.quantityBasis,
          catalogSelection: catalogOwnerResponse.selection,
          completeness: catalogOwnerResponse.completeness,
          divisible: catalogOwnerResponse.divisible,
          equivalentSelectionKey: catalogOwnerResponse.equivalentSelectionKey,
          hierarchyRevision: catalogOwnerResponse.hierarchyRevision,
          normalizedQuantity: catalogOwnerResponse.quantity.resulting,
          ownerRevision: catalogOwnerResponse.ownerRevision,
          physicalMultiple: catalogOwnerResponse.quantity.step,
          requestedQuantity: catalogOwnerResponse.quantity.requested,
        },
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.succeed(CatalogQuantityGatewayCredentialService, {
        issue: (input) =>
          Effect.sync(() => {
            gatewayRequests.push(input);
            return {
              baseUrl: new URL('https://catalog.example.test'),
              credential: Redacted.make('Bearer catalog-owner-issued'),
            };
          }),
      }),
    ),
  );
});

it.effect('uses the Pricing production adapter with the exact purchasing context and owner revision', () => {
  const gatewayRequests: unknown[] = [];
  const ownerCalls: unknown[] = [];
  const pricingOwnerResponse = Schema.decodeUnknownSync(CurrentSupportedCurrenciesResponseSchema)(
    CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts.pricingCurrencies,
  );
  const purchasingContext = {
    cartId: 'czech-launch-cart',
    channelId: fixtureScope.channelId,
    marketId: fixtureScope.marketId,
    sellingLegalEntityId: fixtureScope.sellingLegalEntityId,
    storefrontId: fixtureScope.storefrontId,
    tenantId: fixtureScope.tenantId,
  };
  const subject = {
    guestEvidenceRef: 'commerce.customer-context.guest-evidence:czech-launch',
    guestSessionRef: 'commerce.cart.guest-session:czech-launch',
    kind: 'GUEST' as const,
  };

  return Effect.gen(function* pricingOwnerAdapter() {
    const port = yield* purchaseCurrencyPricingPortFromEnvironment(
      { legalEntityId: fixtureScope.sellingLegalEntityId, requestCorrelation: 'czech-launch-pricing' },
      (payload, credential, correlation, options) => {
        ownerCalls.push({ correlation, credential: Redacted.value(credential), options, payload });
        return Effect.succeed(pricingOwnerResponse);
      },
    );
    const pricing = yield* port.resolveCurrent({
      context: { contextRevision: 'commerce.cart.context:czech-launch-v1', purchasingContext },
      observedAt: effectiveAt,
      subject,
    });

    expect(ownerCalls).toEqual([
      {
        correlation: 'czech-launch-pricing',
        credential: 'Bearer pricing-owner-issued',
        options: { baseUrl: new URL('https://pricing.example.test') },
        payload: {
          cartId: purchasingContext.cartId,
          channelId: purchasingContext.channelId,
          contextRevision: 'commerce.cart.context:czech-launch-v1',
          effectiveAt,
          marketId: purchasingContext.marketId,
          sellingLegalEntityId: purchasingContext.sellingLegalEntityId,
          storefrontId: purchasingContext.storefrontId,
          subject,
          tenantId: purchasingContext.tenantId,
        },
      },
    ]);
    expect(gatewayRequests).toEqual([
      {
        audience: 'pricing',
        legalEntityId: fixtureScope.sellingLegalEntityId,
        requestCorrelation: 'czech-launch-pricing',
      },
    ]);
    expect(pricing).toEqual({
      pricingRevision: CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts.pricingCurrencies.pricingRevision,
      supportedCurrencies: ['CZK'],
    });
  }).pipe(
    Effect.provide(
      Layer.succeed(PurchaseCurrencyPricingGatewayCredentialService, {
        issue: (input) =>
          Effect.sync(() => {
            gatewayRequests.push(input);
            return {
              baseUrl: new URL('https://pricing.example.test'),
              credential: Redacted.make('Bearer pricing-owner-issued'),
            };
          }),
      }),
    ),
  );
});
