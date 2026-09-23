import { Effect, Schema } from 'effect';

import { CurrentSupportedCurrenciesSuccessSchema } from '../packages/pricing-contracts/src/apis/current-supported-currencies.ts';

import { CurrentPaymentTermsResponseSchema } from '../packages/payment-term-catalog-contracts/src/apis/current-payment-terms.ts';
import {
  AssociateStorefrontPayloadSchema,
  CreateMarketPayloadSchema,
} from '../verticals/commerce-market-catalog/shared/action-contracts.ts';
import { MarketDefinitionRevisionRefSchema } from '../verticals/commerce-market-catalog/shared/resources/market-definition-revision.ts';
import type { MarketDefinitionRevisionRef } from '../verticals/commerce-market-catalog/shared/resources/market-definition-revision.ts';
import {
  CommerceQuantityRuleAdministrationPayloadSchema,
  CurrentCommerceQuantityPolicySetSchema,
  CurrentPaymentTermPolicySetSchema,
  CurrentPurchaseCurrencyPolicySetSchema,
  MarketBootstrapPolicyAdministrationPayloadSchema,
  MarketBootstrapPolicyBatchCurrentResponseSchema,
  PaymentTermPolicyAdministrationPayloadSchema,
  PurchaseCurrencyPolicyAdministrationPayloadSchema,
} from '../verticals/commerce-customer-context/shared/domain/customer-commerce-policy-administration.ts';
import { CurrentMarketCatalogResponseSchema } from '../verticals/commerce-market-catalog/shared/apis/current-market-catalog.ts';
import { QuantityPreparationResponseSchema } from '../verticals/catalog/shared/apis/quantity-preparation.ts';

const tenantId = '70000000-0000-4000-8000-000000000010';
const sellingLegalEntityId = '71000000-0000-4000-8000-000000000010';
const marketId = '74000000-0000-4000-8000-000000000010';
const storefrontId = 'czech-launch-b2c';
const effectiveFrom = '2026-10-01T00:00:00.000Z';
const reason = 'Deterministic Czech Launch development fixture';
const marketCatalogModuleId = 'commerce.market-catalog';
const catalogModuleId = 'commerce.catalog';
const pricingCurrencyOwnerRevision = 'commerce.pricing.supported-currencies:czech-launch-v1';
const marketBootstrapPolicyRevisionId = '75000000-0000-4000-8000-000000000010';
const allowedCurrencyPolicyRevisionId = '75000000-0000-4000-8000-000000000020';
const defaultCurrencyPolicyRevisionId = '75000000-0000-4000-8000-000000000021';
const applicablePaymentTermPolicyRevisionId = '75000000-0000-4000-8000-000000000030';
const fallbackPaymentTermPolicyRevisionId = '75000000-0000-4000-8000-000000000031';
const quantityPolicyRevisionId = '75000000-0000-4000-8000-000000000040';

const sellingLegalEntityRef = {
  moduleId: 'core.identity',
  resourceId: sellingLegalEntityId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const marketRef = {
  moduleId: marketCatalogModuleId,
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const storefrontRef = { appId: storefrontId, tenantId } as const;
const catalogProductRef = {
  moduleId: catalogModuleId,
  resourceId: '76000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const catalogVariantRef = {
  moduleId: catalogModuleId,
  resourceId: '76000000-0000-4000-8000-000000000010',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const catalogPackageOptionRef = {
  moduleId: catalogModuleId,
  resourceId: '76000000-0000-4000-8000-000000000015',
  resourceType: 'commerce.catalog.package-definition',
  tenantId,
} as const;
const catalogProductUnitRef = {
  moduleId: catalogModuleId,
  resourceId: '76000000-0000-4000-8000-000000000020',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const catalogSelection = {
  packageOption: {
    contentRevision: { resourceRef: catalogPackageOptionRef, revision: 1 },
    optionRef: catalogPackageOptionRef,
  },
  productRef: catalogProductRef,
  variantRef: catalogVariantRef,
} as const;
const catalogQuantityOwnerRevision = 'commerce.catalog.quantity:czech-launch-v1';
const catalogQuantityEvidence = {
  completeness: {
    observedAt: effectiveFrom,
    ownerRevision: catalogQuantityOwnerRevision,
    scope: {
      kind: 'EXACT_PREDICATE',
      predicateRef: 'commerce.catalog.quantity-preparation:czech-launch-package:purchase-acceptance:1',
    },
  },
  divisible: false,
  equivalentSelectionKey: 'commerce.catalog.selection:czech-launch-package',
  evidence: {
    assessedAt: effectiveFrom,
    basis: [
      { role: 'PRODUCT', source: { resourceRef: catalogProductRef, revision: 1 } },
      { role: 'VARIANT', source: { resourceRef: catalogVariantRef, revision: 1 } },
      {
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
        role: 'PRODUCT_TYPE_UNTYPED_DECISION',
        source: { resourceRef: catalogProductRef, revision: 1 },
      },
      { role: 'PACKAGE_CONTENT', source: { resourceRef: catalogPackageOptionRef, revision: 1 } },
      { role: 'UNIT_RULE', source: { resourceRef: catalogProductUnitRef, revision: 1 } },
      { role: 'UNIT_TARGET_DIVISIBILITY', source: { resourceRef: catalogPackageOptionRef, revision: 1 } },
    ],
    membership: {
      attestationId: 'czech-launch-catalog-membership-v1',
      observedAt: effectiveFrom,
      productRef: catalogProductRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: { resourceRef: catalogVariantRef, revision: 1 },
    },
    purpose: 'PURCHASE_ACCEPTANCE',
    selection: catalogSelection,
    status: 'VALID',
  },
  hierarchyRevision: 'commerce.catalog.hierarchy:czech-launch-v1',
  ownerRevision: catalogQuantityOwnerRevision,
  packageContent: {
    amount: '10',
    path: [{ resourceRef: catalogPackageOptionRef, revision: 1 }],
    status: 'VALID',
    unitRef: catalogProductUnitRef,
  },
  packageRevision: {
    amount: '10',
    form: { productRef: catalogProductRef, variantRef: catalogVariantRef },
    reference: { resourceRef: catalogPackageOptionRef, revision: 1 },
    unitRef: catalogProductUnitRef,
  },
  quantity: {
    changed: false,
    notice: null,
    requested: '1',
    resulting: '1',
    rounding: 'UP',
    status: 'VALID',
    step: '1',
    targetId: catalogPackageOptionRef.resourceId,
    tenantId,
    unitId: catalogProductUnitRef.resourceId,
    unitRuleRevision: 1,
  },
  quantityBasis: {
    targetDivisibilityRevision: 1,
    targetRef: catalogPackageOptionRef,
    unitRef: catalogProductUnitRef,
    unitRuleRevision: 1,
  },
  selection: catalogSelection,
  status: 'READY',
  unitRef: catalogProductUnitRef,
} as const;
const paymentTermRef = {
  moduleId: 'payment.term-catalog',
  resourceId: '78000000-0000-4000-8000-000000000014',
  resourceType: 'payment.term-catalog.payment-term',
  tenantId,
} as const;

const marketDefinitionRevisionRef = {
  moduleId: marketCatalogModuleId,
  resourceId: '74000000-0000-4000-8000-000000000011',
  resourceType: 'commerce.market-catalog.market-definition-revision',
  tenantId,
} as const;
const storefrontAssociationRef = {
  moduleId: marketCatalogModuleId,
  resourceId: '74000000-0000-4000-8000-000000000020',
  resourceType: 'commerce.market-catalog.storefront-association',
  tenantId,
} as const;
const ownerCompleteness = (ownerRevision: string, predicateRef: string) => ({
  observedAt: effectiveFrom,
  ownerRevision,
  scope: { kind: 'EXACT_PREDICATE' as const, predicateRef },
});

const marketCatalogOwnerEvidence = {
  associations: [
    {
      associationRef: storefrontAssociationRef,
      channel: 'B2C',
      effectivePeriod: { startsAt: effectiveFrom },
      marketDefinitionRevisionRef,
      marketRef,
      provenance: { kind: 'CONFIGURATION_ACTION', reference: 'czech-launch-fixture-v1' },
      revision: 1,
      sellingLegalEntityRef,
      storefrontRef,
    },
  ],
  completenessEvidence: ownerCompleteness(
    'commerce.market-catalog.current:czech-launch-v1',
    'commerce.market-catalog.current:czech-launch',
  ),
  markets: [
    {
      channels: ['B2C'],
      definitionRevisionRef: marketDefinitionRevisionRef,
      effectivePeriod: { startsAt: effectiveFrom },
      jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
      lifecycle: 'ACTIVE',
      marketCode: 'CZ_B2C',
      marketRef,
      purpose: 'Czech Launch B2C commerce',
      revision: 1,
      sellingLegalEntityRef,
      supportedLocales: ['cs-CZ'],
    },
  ],
  observedAt: effectiveFrom,
} as const;

const paymentTermCatalogOwnerEvidence = {
  current: [
    {
      code: 'NET_14',
      compatibilityId: 'net_days.invoice_issued_at.calendar_days_utc.v1',
      compatibleWith: ['customer-payment-terms.v1'],
      created: {
        actionInvocationId: 'czech-launch-payment-term-v1',
        actorPrincipalId: 'czech-launch-fixture',
        at: effectiveFrom,
        reason,
      },
      definitionRevisionId: '78000000-0000-4000-8000-000000000114',
      description: 'Payment is due fourteen UTC calendar days after invoice issue.',
      lifecycle: { effectiveFrom, effectiveTo: null, state: 'ACTIVE' },
      metadataRevision: 1,
      name: 'Net 14',
      paymentTermRef,
      retired: null,
      semanticFingerprint: 'c'.repeat(64),
      semanticRevisionId: '78000000-0000-4000-8000-000000000214',
      semantics: {
        calculationRuleVersion: 1,
        calendarRule: 'CALENDAR_DAYS_UTC',
        days: 14,
        dueDateAnchor: 'INVOICE_ISSUED_AT',
        kind: 'NET_DAYS',
      },
      updated: {
        actionInvocationId: 'czech-launch-payment-term-v1',
        actorPrincipalId: 'czech-launch-fixture',
        at: effectiveFrom,
        reason,
      },
    },
  ],
  effectiveAt: effectiveFrom,
  observedAt: effectiveFrom,
  referenceOutcomes: [],
  truncated: false,
} as const;

const pricingCurrencyOwnerEvidence = {
  completenessEvidence: ownerCompleteness(
    pricingCurrencyOwnerRevision,
    'commerce.pricing.supported-currencies.current:czech-launch',
  ),
  effectiveAt: effectiveFrom,
  observedAt: effectiveFrom,
  outcome: 'SUPPORTED_CURRENCIES_CURRENT',
  pricingRevision: pricingCurrencyOwnerRevision,
  supportedCurrencies: ['CZK'],
} as const;

const customerCommercePolicyOwnerEvidence = {
  marketBootstrap: {
    sellers: [
      {
        candidates: [
          {
            defaultTuple: {
              channelId: 'B2C',
              commerceMarketId: marketId,
              sellingLegalEntityId,
            },
            policyRevisionId: marketBootstrapPolicyRevisionId,
            scope: { channelId: 'B2C', kind: 'CHANNEL_SELLER', sellingLegalEntityId },
          },
        ],
        completeness: ownerCompleteness(
          `MARKET_BOOTSTRAP:${tenantId}:${sellingLegalEntityId}:1`,
          `commerce.customer-context.policy.market_bootstrap.current:${sellingLegalEntityId}`,
        ),
        sellingLegalEntityId,
      },
    ],
  },
  paymentTerm: {
    candidates: [
      {
        effectiveFrom,
        effectiveTo: null,
        policyRevisionId: applicablePaymentTermPolicyRevisionId,
        scope: { kind: 'SELLER', sellingLegalEntityId },
        value: { kind: 'APPLICABLE_PAYMENT_TERM_CONSTRAINT', paymentTermRef },
      },
      {
        effectiveFrom,
        effectiveTo: null,
        policyRevisionId: fallbackPaymentTermPolicyRevisionId,
        scope: { kind: 'SELLER', sellingLegalEntityId },
        value: { kind: 'FALLBACK_PAYMENT_TERM', paymentTermRef },
      },
    ],
    completeness: ownerCompleteness('PAYMENT_TERM:2', 'commerce.customer-context.policy.payment_term.current'),
  },
  purchaseCurrency: {
    candidates: [
      {
        effectiveFrom,
        effectiveTo: null,
        policyRevisionId: allowedCurrencyPolicyRevisionId,
        scope: { kind: 'SELLER', sellingLegalEntityId },
        value: { currencyCode: 'CZK', kind: 'ALLOWED_CURRENCY_CONSTRAINT' },
      },
      {
        effectiveFrom,
        effectiveTo: null,
        policyRevisionId: defaultCurrencyPolicyRevisionId,
        scope: { kind: 'SELLER', sellingLegalEntityId },
        value: { currencyCode: 'CZK', kind: 'DEFAULT_CURRENCY' },
      },
    ],
    completeness: ownerCompleteness(
      'PURCHASE_CURRENCY:2',
      'commerce.customer-context.policy.purchase_currency.current',
    ),
  },
  quantity: {
    assignmentSet: {
      assignments: [],
      completeness: ownerCompleteness(
        'COMMERCE_QUANTITY_ASSIGNMENT:0',
        'commerce.customer-context.policy.commerce_quantity_assignment.current',
      ),
    },
    ruleSet: {
      candidates: [
        {
          effectiveFrom,
          effectiveTo: null,
          policyRevisionId: quantityPolicyRevisionId,
          scope: { channelId: 'B2C', kind: 'CHANNEL_SELLER', sellingLegalEntityId },
          value: {
            basis: {
              targetDivisibilityRevision: 1,
              targetRef: catalogPackageOptionRef,
              unitRef: catalogProductUnitRef,
              unitRuleRevision: 1,
            },
            constraintMode: 'REPLACEABLE_ENVELOPE',
            envelope: { kind: 'BOUNDED', maximum: null, minimum: '1', multiple: '1' },
            kind: 'COMMERCE_QUANTITY_RULE',
            selector: { kind: 'PACKAGE_OPTION', packageOptionRef: catalogPackageOptionRef },
          },
        },
      ],
      completeness: ownerCompleteness(
        'COMMERCE_QUANTITY_RULE:1',
        'commerce.customer-context.policy.commerce_quantity_rule.current',
      ),
    },
  },
} as const;

export const CZECH_LAUNCH_COMMERCE_FIXTURE = Object.freeze({
  actionKeys: Object.freeze({
    associateStorefront: 'commerce.market-catalog.associate-storefront',
    createMarket: 'commerce.market-catalog.create-market',
    marketBootstrap: 'commerce.customer-context.administer-market-bootstrap-policy',
    paymentTerm: 'commerce.customer-context.administer-payment-term-policy',
    purchaseCurrency: 'commerce.customer-context.administer-purchase-currency-policy',
    quantity: 'commerce.customer-context.administer-commerce-quantity-rule',
  }),
  market: {
    channels: ['B2C'],
    effectivePeriod: { startsAt: effectiveFrom },
    jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
    lifecycle: 'ACTIVE',
    marketCode: 'CZ_B2C',
    marketId,
    purpose: 'Czech Launch B2C commerce',
    reason,
    sellingLegalEntityRef,
    supportedLocales: ['cs-CZ'],
  },
  ownerFacts: {
    catalogQuantity: catalogQuantityEvidence,
    customerCommercePolicies: customerCommercePolicyOwnerEvidence,
    marketCatalog: marketCatalogOwnerEvidence,
    paymentTermCatalog: paymentTermCatalogOwnerEvidence,
    pricingCurrencies: pricingCurrencyOwnerEvidence,
  },
  policies: {
    marketBootstrap: {
      _tag: 'CREATE_REVISION',
      expectedGeneration: 0,
      revision: {
        effectiveFrom,
        effectiveTo: null,
        field: 'MARKET_BOOTSTRAP',
        idempotencyKey: 'czech-launch-market-bootstrap-v1',
        lifecycle: 'ACTIVE',
        reason,
        revisionId: marketBootstrapPolicyRevisionId,
        scope: { channelId: 'B2C', kind: 'CHANNEL_SELLER', sellingLegalEntityId },
        value: {
          defaultChannelId: 'B2C',
          defaultCommerceMarketId: marketId,
          defaultSellingLegalEntityId: sellingLegalEntityId,
          kind: 'DEFAULT_MARKET_TUPLE',
        },
      },
    },
    paymentTerm: [
      {
        _tag: 'CREATE_REVISION',
        expectedGeneration: 0,
        revision: {
          effectiveFrom,
          effectiveTo: null,
          field: 'PAYMENT_TERM',
          idempotencyKey: 'czech-launch-applicable-payment-term-v1',
          lifecycle: 'ACTIVE',
          reason,
          revisionId: applicablePaymentTermPolicyRevisionId,
          scope: { kind: 'SELLER', sellingLegalEntityId },
          value: { kind: 'APPLICABLE_PAYMENT_TERM_CONSTRAINT', paymentTermRef },
        },
      },
      {
        _tag: 'CREATE_REVISION',
        expectedGeneration: 1,
        revision: {
          effectiveFrom,
          effectiveTo: null,
          field: 'PAYMENT_TERM',
          idempotencyKey: 'czech-launch-fallback-payment-term-v1',
          lifecycle: 'ACTIVE',
          reason,
          revisionId: fallbackPaymentTermPolicyRevisionId,
          scope: { kind: 'SELLER', sellingLegalEntityId },
          value: {
            kind: 'FALLBACK_PAYMENT_TERM',
            paymentTermRef,
          },
        },
      },
    ],
    purchaseCurrency: [
      {
        _tag: 'CREATE_REVISION',
        expectedGeneration: 0,
        revision: {
          effectiveFrom,
          effectiveTo: null,
          field: 'PURCHASE_CURRENCY',
          idempotencyKey: 'czech-launch-allowed-currency-v1',
          lifecycle: 'ACTIVE',
          reason,
          revisionId: allowedCurrencyPolicyRevisionId,
          scope: { kind: 'SELLER', sellingLegalEntityId },
          value: { currencyCode: 'CZK', kind: 'ALLOWED_CURRENCY_CONSTRAINT' },
        },
      },
      {
        _tag: 'CREATE_REVISION',
        expectedGeneration: 1,
        revision: {
          effectiveFrom,
          effectiveTo: null,
          field: 'PURCHASE_CURRENCY',
          idempotencyKey: 'czech-launch-default-currency-v1',
          lifecycle: 'ACTIVE',
          reason,
          revisionId: defaultCurrencyPolicyRevisionId,
          scope: { kind: 'SELLER', sellingLegalEntityId },
          value: { currencyCode: 'CZK', kind: 'DEFAULT_CURRENCY' },
        },
      },
    ],
    quantity: {
      _tag: 'CREATE_REVISION',
      expectedGeneration: 0,
      revision: {
        effectiveFrom,
        effectiveTo: null,
        field: 'COMMERCE_QUANTITY_RULE',
        idempotencyKey: 'czech-launch-quantity-v1',
        lifecycle: 'ACTIVE',
        reason,
        revisionId: quantityPolicyRevisionId,
        scope: { channelId: 'B2C', kind: 'CHANNEL_SELLER', sellingLegalEntityId },
        value: {
          basis: {
            targetDivisibilityRevision: 1,
            targetRef: catalogPackageOptionRef,
            unitRef: catalogProductUnitRef,
            unitRuleRevision: 1,
          },
          constraintMode: 'REPLACEABLE_ENVELOPE',
          envelope: { kind: 'BOUNDED', maximum: null, minimum: '1', multiple: '1' },
          kind: 'COMMERCE_QUANTITY_RULE',
          selector: { kind: 'PACKAGE_OPTION', packageOptionRef: catalogPackageOptionRef },
        },
      },
    },
  },
  scope: { channelId: 'B2C', marketId, sellingLegalEntityId, storefrontId, tenantId },
});

const buildCzechLaunchStorefrontAssociation = (definitionRevisionRef: MarketDefinitionRevisionRef) => ({
  associationId: '74000000-0000-4000-8000-000000000020',
  channel: 'B2C',
  effectivePeriod: { startsAt: effectiveFrom },
  expectedMarketDefinitionRevisionRef: definitionRevisionRef,
  marketRef,
  provenance: { kind: 'CONFIGURATION_ACTION', reference: 'czech-launch-fixture-v1' },
  reason,
  sellingLegalEntityRef,
  storefrontRef,
});

const CurrentCatalogQuantityEvidenceSchema = QuantityPreparationResponseSchema.check(
  Schema.makeFilter((evidence) =>
    evidence.status === 'READY' ? undefined : 'Czech Launch activation requires READY Catalog quantity evidence',
  ),
);

const currentCzechLaunchOwnerEvidenceFields = {
  customerCommercePolicies: Schema.Struct({
    marketBootstrap: MarketBootstrapPolicyBatchCurrentResponseSchema,
    paymentTerm: CurrentPaymentTermPolicySetSchema,
    purchaseCurrency: CurrentPurchaseCurrencyPolicySetSchema,
    quantity: CurrentCommerceQuantityPolicySetSchema,
  }),
  marketCatalog: CurrentMarketCatalogResponseSchema,
  paymentTermCatalog: CurrentPaymentTermsResponseSchema,
  pricingCurrencies: CurrentSupportedCurrenciesSuccessSchema,
} as const;

const CzechLaunchActivationEvidenceSchema = Schema.Struct({
  catalogQuantity: CurrentCatalogQuantityEvidenceSchema,
  ...currentCzechLaunchOwnerEvidenceFields,
})
  .check(
    Schema.makeFilter(({ customerCommercePolicies, marketCatalog, paymentTermCatalog, pricingCurrencies }) => {
      const market = marketCatalog.markets.find(({ marketRef: candidate }) => candidate.resourceId === marketId);
      const association = marketCatalog.associations.find(
        ({ marketRef: candidate, storefrontRef: candidateStorefront }) =>
          candidate.resourceId === marketId && candidateStorefront.appId === storefrontId,
      );
      const paymentTerm = paymentTermCatalog.current.find(
        ({ paymentTermRef: candidate }) => candidate.resourceId === paymentTermRef.resourceId,
      );
      const bootstrapPartition = customerCommercePolicies.marketBootstrap.sellers.find(
        ({ sellingLegalEntityId: candidate }) => candidate === sellingLegalEntityId,
      );
      const currencyRevisionIds = new Set(
        customerCommercePolicies.purchaseCurrency.candidates.map(({ policyRevisionId }) => policyRevisionId),
      );
      const paymentRevisionIds = new Set(
        customerCommercePolicies.paymentTerm.candidates.map(({ policyRevisionId }) => policyRevisionId),
      );
      const quantityRevisionIds = new Set(
        customerCommercePolicies.quantity.ruleSet.candidates.map(({ policyRevisionId }) => policyRevisionId),
      );
      return market?.definitionRevisionRef.resourceId === marketDefinitionRevisionRef.resourceId &&
        market.lifecycle === 'ACTIVE' &&
        association?.marketDefinitionRevisionRef.resourceId === marketDefinitionRevisionRef.resourceId &&
        paymentTerm?.lifecycle.state === 'ACTIVE' &&
        pricingCurrencies.pricingRevision === pricingCurrencyOwnerRevision &&
        pricingCurrencies.supportedCurrencies.length === 1 &&
        pricingCurrencies.supportedCurrencies[0] === 'CZK' &&
        bootstrapPartition?.candidates.some(
          ({ policyRevisionId }) => policyRevisionId === marketBootstrapPolicyRevisionId,
        ) === true &&
        currencyRevisionIds.has(allowedCurrencyPolicyRevisionId) &&
        currencyRevisionIds.has(defaultCurrencyPolicyRevisionId) &&
        paymentRevisionIds.has(applicablePaymentTermPolicyRevisionId) &&
        paymentRevisionIds.has(fallbackPaymentTermPolicyRevisionId) &&
        quantityRevisionIds.has(quantityPolicyRevisionId)
        ? undefined
        : 'Czech Launch activation requires the exact Current owner revisions for Market, Payment Term, Pricing, and Customer Commerce Policy';
    }),
  )
  .annotate({ parseOptions: { onExcessProperty: 'error' } });

export class CzechLaunchActivationRejected extends Schema.TaggedError<CzechLaunchActivationRejected>()(
  'CzechLaunchActivationRejected',
  { reason: Schema.String },
) {}

export type CzechLaunchActivationCandidate = typeof CzechLaunchActivationEvidenceSchema.Encoded;

/**
 * Operator-only activation guard. The fixture is never applied from application startup: callers must first obtain
 * schema-valid Current owner evidence for the Market tuple, Payment Term, Pricing currencies, Catalog quantity basis,
 * and every complete Customer Commerce policy set.
 */
export const validateCzechLaunchActivation = (evidence: CzechLaunchActivationCandidate) =>
  Schema.decodeUnknownEffect(CzechLaunchActivationEvidenceSchema)(evidence).pipe(
    Effect.mapError(
      (cause) =>
        new CzechLaunchActivationRejected({
          reason: `Czech Launch activation requires schema-valid Current owner inventory and policy revisions: ${String(cause)}`,
        }),
    ),
  );

export const validateCzechLaunchFixtureContracts = () =>
  Effect.gen(function* validateFixtureContracts() {
    const definitionRevisionRef = yield* Schema.decodeUnknownEffect(MarketDefinitionRevisionRefSchema)({
      moduleId: 'commerce.market-catalog',
      resourceId: '74000000-0000-4000-8000-000000000011',
      resourceType: 'commerce.market-catalog.market-definition-revision',
      tenantId,
    });
    return yield* Effect.all(
      [
        Schema.decodeUnknownEffect(CreateMarketPayloadSchema)(CZECH_LAUNCH_COMMERCE_FIXTURE.market),
        Schema.decodeUnknownEffect(MarketBootstrapPolicyAdministrationPayloadSchema)(
          CZECH_LAUNCH_COMMERCE_FIXTURE.policies.marketBootstrap,
        ),
        Effect.all(
          CZECH_LAUNCH_COMMERCE_FIXTURE.policies.purchaseCurrency.map((payload) =>
            Schema.decodeUnknownEffect(PurchaseCurrencyPolicyAdministrationPayloadSchema)(payload),
          ),
          { concurrency: 'unbounded' },
        ),
        Effect.all(
          CZECH_LAUNCH_COMMERCE_FIXTURE.policies.paymentTerm.map((payload) =>
            Schema.decodeUnknownEffect(PaymentTermPolicyAdministrationPayloadSchema)(payload),
          ),
          { concurrency: 'unbounded' },
        ),
        Schema.decodeUnknownEffect(CommerceQuantityRuleAdministrationPayloadSchema)(
          CZECH_LAUNCH_COMMERCE_FIXTURE.policies.quantity,
        ),
        Schema.decodeUnknownEffect(AssociateStorefrontPayloadSchema)(
          buildCzechLaunchStorefrontAssociation(definitionRevisionRef),
        ),
      ],
      { concurrency: 'unbounded' },
    );
  });
