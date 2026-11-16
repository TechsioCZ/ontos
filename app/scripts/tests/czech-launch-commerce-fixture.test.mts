import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CZECH_LAUNCH_COMMERCE_FIXTURE,
  CzechLaunchActivationRejected,
  validateCzechLaunchActivation,
  validateCzechLaunchFixtureContracts,
} from '../czech-launch-commerce-fixture.mts';
import { LOCAL_DEVELOPMENT_CONTEXT } from '../initialize-local-development.mts';

const CATALOG_MODULE_ID = 'commerce.catalog';
const fixturePricingCurrencies = CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts.pricingCurrencies;
const fixturePricingVerificationRef = `commerce.pricing.currency-support-proof:${fixturePricingCurrencies.supportRevisionRef.resourceId}`;
const activationOwnerFacts = {
  ...CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts,
  pricingCurrencies: {
    ...fixturePricingCurrencies,
    factProofs: [
      {
        factRef: fixturePricingCurrencies.supportRootRef.resourceId,
        factRevisionRef: fixturePricingCurrencies.supportRevisionRef.resourceId,
        verificationRef: fixturePricingVerificationRef,
      },
    ],
    verificationRef: fixturePricingVerificationRef,
  },
};

it.effect('publishes the complete active Czech Launch currency policy without an explicit-choice revision', () =>
  Effect.gen(function* czechLaunchCurrencyPolicy() {
    yield* validateCzechLaunchFixtureContracts();

    expect(CZECH_LAUNCH_COMMERCE_FIXTURE.policies.purchaseCurrency).toMatchObject([
      {
        _tag: 'CREATE_REVISION',
        expectedGeneration: 0,
        revision: {
          lifecycle: 'ACTIVE',
          value: { currencyCode: 'CZK', kind: 'ALLOWED_CURRENCY_CONSTRAINT' },
        },
      },
      {
        _tag: 'CREATE_REVISION',
        expectedGeneration: 1,
        revision: {
          lifecycle: 'ACTIVE',
          value: { currencyCode: 'CZK', kind: 'DEFAULT_CURRENCY' },
        },
      },
    ]);
    expect(CZECH_LAUNCH_COMMERCE_FIXTURE.policies.purchaseCurrency.map(({ revision }) => revision.value.kind)).toEqual([
      'ALLOWED_CURRENCY_CONSTRAINT',
      'DEFAULT_CURRENCY',
    ]);
  }),
);

it.effect('publishes complete Payment Term applicability and an independently revisioned accepted fallback', () =>
  Effect.gen(function* czechLaunchPaymentTermPolicy() {
    yield* validateCzechLaunchFixtureContracts();

    expect(CZECH_LAUNCH_COMMERCE_FIXTURE.policies.paymentTerm).toMatchObject([
      {
        _tag: 'CREATE_REVISION',
        expectedGeneration: 0,
        revision: {
          lifecycle: 'ACTIVE',
          value: { kind: 'APPLICABLE_PAYMENT_TERM_CONSTRAINT' },
        },
      },
      {
        _tag: 'CREATE_REVISION',
        expectedGeneration: 1,
        revision: {
          lifecycle: 'ACTIVE',
          value: { kind: 'FALLBACK_PAYMENT_TERM' },
        },
      },
    ]);

    const [applicability, fallback] = CZECH_LAUNCH_COMMERCE_FIXTURE.policies.paymentTerm;
    expect(applicability.revision.revisionId).not.toBe(fallback.revision.revisionId);
    expect(applicability.revision.value.paymentTermRef).toEqual(fallback.revision.value.paymentTermRef);
    expect(applicability.revision.value.paymentTermRef).toEqual({
      moduleId: 'payment.term-catalog',
      resourceId: '78000000-0000-4000-8000-000000000014',
      resourceType: 'payment.term-catalog.payment-term',
      tenantId: CZECH_LAUNCH_COMMERCE_FIXTURE.scope.tenantId,
    });
  }),
);

it.effect('publishes exact Catalog-owner selection, Unit, normalization, and divisibility evidence', () =>
  Effect.gen(function* czechLaunchCatalogQuantity() {
    yield* validateCzechLaunchFixtureContracts();

    const { catalogQuantity } = CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts;
    expect(catalogQuantity).toMatchObject({
      completeness: { ownerRevision: catalogQuantity.ownerRevision },
      divisible: false,
      evidence: {
        purpose: 'PURCHASE_ACCEPTANCE',
        status: 'VALID',
      },
      quantity: {
        requested: '1',
        resulting: '1',
        status: 'VALID',
        step: '1',
      },
      quantityBasis: {
        targetDivisibilityRevision: 1,
        targetRef: catalogQuantity.selection.packageOption?.optionRef,
        unitRef: catalogQuantity.unitRef,
        unitRuleRevision: 1,
      },
      selection: {
        packageOption: {
          contentRevision: { revision: 1 },
        },
        productRef: { resourceType: 'commerce.catalog.product' },
        variantRef: { resourceType: 'commerce.catalog.variant' },
      },
      status: 'READY',
    });
    expect(catalogQuantity.evidence.basis.map(({ role }) => role)).toEqual([
      'PRODUCT',
      'VARIANT',
      'PRODUCT_TYPE_UNTYPED_DECISION',
      'PACKAGE_CONTENT',
      'UNIT_RULE',
      'UNIT_TARGET_DIVISIBILITY',
    ]);
    expect(CZECH_LAUNCH_COMMERCE_FIXTURE.policies.quantity.revision.value).toMatchObject({
      basis: catalogQuantity.quantityBasis,
      selector: { kind: 'PACKAGE_OPTION', packageOptionRef: catalogQuantity.selection.packageOption?.optionRef },
    });
    expect('catalogQuantityBasisCurrent' in CZECH_LAUNCH_COMMERCE_FIXTURE).toBe(false);
  }),
);

it('omits the excluded storefront from the default market tuple', () => {
  expect(CZECH_LAUNCH_COMMERCE_FIXTURE.policies.marketBootstrap.revision.value).toEqual({
    defaultChannelId: 'B2C',
    defaultCommerceMarketId: '74000000-0000-4000-8000-000000000010',
    defaultSellingLegalEntityId: '71000000-0000-4000-8000-000000000010',
    kind: 'DEFAULT_MARKET_TUPLE',
  });
});

it.effect('publishes a schema-valid deterministic Czech Launch operator fixture', () =>
  Effect.gen(function* validateFixture() {
    yield* validateCzechLaunchFixtureContracts();
    expect(CZECH_LAUNCH_COMMERCE_FIXTURE.scope).toMatchObject({
      channelId: 'B2C',
      storefrontId: 'czech-launch-b2c',
      tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
    });
    expect(CZECH_LAUNCH_COMMERCE_FIXTURE.policies.quantity.revision.value).toEqual({
      audience: 'SHARED',
      basis: {
        targetDivisibilityRevision: 1,
        targetRef: {
          moduleId: CATALOG_MODULE_ID,
          resourceId: '76000000-0000-4000-8000-000000000015',
          resourceType: 'commerce.catalog.package-definition',
          tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
        },
        unitRef: {
          moduleId: CATALOG_MODULE_ID,
          resourceId: '76000000-0000-4000-8000-000000000020',
          resourceType: 'commerce.catalog.product-unit',
          tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
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
          tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
        },
      },
    });
  }),
);

it.effect('fails Czech Launch activation closed without every current owner proof', () =>
  Effect.gen(function* validateActivation() {
    expect(
      yield* validateCzechLaunchActivation({
        ...activationOwnerFacts,
        paymentTermCatalog: {
          ...CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts.paymentTermCatalog,
          current: [],
        },
      }).pipe(Effect.flip),
    ).toBeInstanceOf(CzechLaunchActivationRejected);
    const withUndeclaredEvidence = { ...activationOwnerFacts, undeclaredEvidence: true };
    expect(yield* validateCzechLaunchActivation(withUndeclaredEvidence).pipe(Effect.flip)).toBeInstanceOf(
      CzechLaunchActivationRejected,
    );

    expect(yield* validateCzechLaunchActivation(activationOwnerFacts)).toBeDefined();
  }),
);
