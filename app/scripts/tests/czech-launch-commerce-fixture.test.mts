import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CZECH_LAUNCH_COMMERCE_FIXTURE,
  validateCzechLaunchActivation,
  validateCzechLaunchFixtureContracts,
} from '../czech-launch-commerce-fixture.mts';

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

    yield* validateCzechLaunchActivation(CZECH_LAUNCH_COMMERCE_FIXTURE.ownerFacts);
  }),
);
