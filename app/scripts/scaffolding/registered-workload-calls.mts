/**
 * The calling modules (demo divergence exception 8) and the reviewed calls each built contract records, as
 * 'workloadKey audience declarationKey schemaVersion' with the number of declarations that make it, so a new
 * cross-module credential call is a visible diff here. The generation test and the merge adaptation preflight
 * both compare the built contracts with it.
 */
export const REVIEWED_REGISTERED_WORKLOAD_CALLS = {
  assortment: {
    'commerce.assortment.symmy-fixture-currentness catalog commerce.catalog.assortment-product-classification-v1.read 1': 1,
    'commerce.assortment.symmy-fixture-currentness commerce-customer-context commerce.customer-context.customer-group.read 1': 1,
    'commerce.assortment.symmy-fixture-currentness commerce-market-catalog commerce.market-catalog.assortment-fixture-market-association.read 1': 1,
    'commerce.assortment.symmy-fixture-currentness storefront-registry commerce.storefront-registry.storefront-application.read-current 1': 1,
  },
  'commerce-customer-context': {
    'party.registry.source-read party-registry party.registry.counterparty-organization-ico-facts.read 1': 2,
    'party.registry.source-read party-registry party.registry.source-person-admission.read 1': 3,
    'pricing.price-group-catalog.source-read price-group-catalog pricing.price-group-catalog.price-group.read.compatibility 1': 1,
    'privacy.core.organization-business-check privacy privacy.core.organization-business-applicability.read 1': 3,
    'privacy.core.organization-profile-ico-check privacy privacy.core.organization-profile-ico-applicability.read 1': 2,
    'privacy.core.source-processing-check privacy privacy.core.source-processing-eligibility.read 1': 3,
  },
  'party-registry': {
    'privacy.core.organization-business-check privacy privacy.core.organization-business-applicability.read 1': 1,
    'privacy.core.source-processing-check privacy privacy.core.source-processing-eligibility.read 1': 3,
  },
  payment: {
    'payment.source-ingress payment payment.core.observation.accept 1': 2,
  },
  pricing: {
    'commerce.catalog.symmy-product-read catalog commerce.catalog.selection-evidence.read 1': 1,
    'commerce.market-catalog.source-read commerce-market-catalog commerce.market-catalog.market-catalog.read 1': 1,
  },
  privacy: {
    'commerce.customer-context.organization-ico-facts.read commerce-customer-context commerce.customer-context.customer-profile-organization-ico-facts.read 1': 3,
    'integration.symmy.source-organization-facts.read symmy-integration integration.symmy.symmy-source-organization-facts.read 1': 1,
    'party.registry.source-read party-registry party.registry.organization-ico-facts.read 1': 1,
    'party.registry.source-read party-registry party.registry.organization-record-facts.read 1': 2,
    'party.registry.source-read party-registry party.registry.source-person-admission.read 1': 2,
  },
  'symmy-integration': {
    'commerce.assortment.symmy-fixture-rule-import assortment commerce.assortment.symmy-fixture-rule.import 1': 1,
    'commerce.catalog.symmy-product-import catalog commerce.catalog.product.create 2': 1,
    'commerce.catalog.symmy-product-import catalog commerce.catalog.product.update 1': 1,
    'commerce.catalog.symmy-product-import catalog commerce.catalog.variant.create 2': 1,
    'commerce.catalog.symmy-product-read catalog commerce.catalog.catalog-source-product-page.read 1': 1,
    'commerce.catalog.symmy-product-read catalog commerce.catalog.catalog-source-products.read 1': 1,
    'commerce.catalog.symmy-product-read catalog commerce.catalog.create-product-recovery.read 1': 1,
    'commerce.catalog.symmy-product-read catalog commerce.catalog.create-variant-recovery.read 1': 1,
    'commerce.catalog.symmy-variant-localized-facts-recovery catalog commerce.catalog.set-variant-localized-facts-recovery.read 1': 1,
    'commerce.catalog.symmy-variant-localized-facts catalog commerce.catalog.variant-localized-facts.set 1': 1,
    'commerce.customer-context.source-read commerce-customer-context commerce.customer-context.customer-group-definition-source.read 1': 4,
    'commerce.customer-context.source-read commerce-customer-context commerce.customer-context.customer-group-membership-source-receipt.read 1': 1,
    'commerce.customer-context.source-read commerce-customer-context commerce.customer-context.customer-price-group-assignment-receipt.read 1': 2,
    'commerce.customer-context.source-read commerce-customer-context commerce.customer-context.customer-profile-source.read 1': 2,
    'commerce.customer-context.source-read commerce-customer-context commerce.customer-context.saved-address-source-receipt.read 1': 3,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.counterparty-price-group.assign 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.counterparty-purchasing-profile.create 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.customer-group-membership-source.apply 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.customer-group.create 1': 2,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.customer-group.update 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.customer-price-group.assign 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.organization-customer-profile-ico.change 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.retail-customer-profile.ensure 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.saved-address.add 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.saved-address.remove 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.saved-address.update 1': 1,
    'commerce.inventory.source-read inventory commerce.inventory.inventory-source-import-receipt.read 1': 2,
    'commerce.inventory.source-write inventory commerce.inventory.source-assertion.import 1': 1,
    'commerce.pricing.source-read pricing commerce.pricing.price-source-result-lookup.read 1': 2,
    'commerce.pricing.source-read pricing commerce.pricing.price.read-definition 1': 1,
    'commerce.pricing.source-write pricing commerce.pricing.price.define 2': 1,
    'commerce.pricing.source-write pricing commerce.pricing.price.revise 2': 1,
    'commerce.tax.symmy-seller-vat-fixture-import tax commerce.tax.seller-vat-regime-declaration.import 1': 1,
    'party.registry.source-read party-registry party.registry.party-source-effect-receipt.read 1': 1,
    'party.registry.source-write party-registry party.registry.contact-point.add 1': 1,
    'party.registry.source-write party-registry party.registry.counterparty.onboard 1': 1,
    'party.registry.source-write party-registry party.registry.party.create 1': 1,
    'party.registry.source-write party-registry party.registry.party.update 1': 1,
    'pricing.price-group-catalog.source-read price-group-catalog pricing.price-group-catalog.price-group-catalog-head.read 1': 1,
    'pricing.price-group-catalog.source-read price-group-catalog pricing.price-group-catalog.price-group-result-lookup.read 1': 2,
    'pricing.price-group-catalog.source-read price-group-catalog pricing.price-group-catalog.price-group-source-associations.read 1': 1,
    'pricing.price-group-catalog.source-write price-group-catalog pricing.price-group-catalog.price-group-definition-revision.create 1': 1,
    'pricing.price-group-catalog.source-write price-group-catalog pricing.price-group-catalog.price-group.create 1': 1,
    'privacy.core.source-processing-check privacy privacy.core.source-processing-eligibility.read 1': 1,
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, number>>>>;

interface RegisteredWorkloadCall {
  readonly audience: string;
  readonly declarationKey: string;
  readonly schemaVersion: string;
  readonly workloadKey: string;
}

/**
 * Every call whose declarations in one built contract differ from the reviewed inventory, by
 * 'workloadKey audience declarationKey schemaVersion': `built` 0 is a reviewed call the contract lost, `reviewed` 0
 * a call nobody reviewed. A module the inventory does not name reviews none.
 */
export const registeredWorkloadCallDrift = (
  appId: string,
  calls: readonly RegisteredWorkloadCall[],
): readonly { readonly built: number; readonly call: string; readonly reviewed: number }[] => {
  const reviewed = new Map<string, number>(
    Object.entries(Object.entries(REVIEWED_REGISTERED_WORKLOAD_CALLS).find(([caller]) => caller === appId)?.[1] ?? {}),
  );
  const built = new Map<string, number>();
  for (const { audience, declarationKey, schemaVersion, workloadKey } of calls) {
    const call = [workloadKey, audience, declarationKey, schemaVersion].join(' ');
    built.set(call, (built.get(call) ?? 0) + 1);
  }
  return [...new Set([...reviewed.keys(), ...built.keys()])]
    .toSorted()
    .map((call) => ({ built: built.get(call) ?? 0, call, reviewed: reviewed.get(call) ?? 0 }))
    .filter((entry) => entry.built !== entry.reviewed);
};
