import type { OntosRegisteredWorkloadCallInput } from '@app/core-runtime';

const commerceCustomerContext = 'commerce-customer-context';
const commerceCatalogCreateProduct = 'commerce.catalog.create-product';
const commerceCatalogCreateVariant = 'commerce.catalog.create-variant';
const commerceCatalogSetVariantLocalizedFacts = 'commerce.catalog.set-variant-localized-facts';
const commerceCatalogSymmyProductImport = 'commerce.catalog.symmy-product-import';
const commerceCatalogSymmyProductRead = 'commerce.catalog.symmy-product-read';
const commerceCustomerContextAddSavedAddress = 'commerce.customer-context.add-saved-address';
const commerceCustomerContextApiCustomerGroupDefinitionSource =
  'commerce.customer-context.api.customer-group-definition-source';
const commerceCustomerContextApiCustomerPriceGroupAssignmentReceipt =
  'commerce.customer-context.api.customer-price-group-assignment-receipt';
const commerceCustomerContextApiCustomerProfileSource = 'commerce.customer-context.api.customer-profile-source';
const commerceCustomerContextApiSavedAddressSourceReceipt =
  'commerce.customer-context.api.saved-address-source-receipt';
const commerceCustomerContextApplyCustomerGroupMembershipSource =
  'commerce.customer-context.apply-customer-group-membership-source';
const commerceCustomerContextAssignCounterpartyPriceGroup = 'commerce.customer-context.assign-counterparty-price-group';
const commerceCustomerContextAssignCustomerPriceGroup = 'commerce.customer-context.assign-customer-price-group';
const commerceCustomerContextCreateCustomerGroup = 'commerce.customer-context.create-customer-group';
const commerceCustomerContextCustomerGroupDefinitionSourceRead =
  'commerce.customer-context.customer-group-definition-source.read';
const commerceCustomerContextCustomerGroupCreate = 'commerce.customer-context.customer-group.create';
const commerceCustomerContextCustomerPriceGroupAssignmentReceiptRead =
  'commerce.customer-context.customer-price-group-assignment-receipt.read';
const commerceCustomerContextCustomerProfileSourceRead = 'commerce.customer-context.customer-profile-source.read';
const commerceCustomerContextEnsureRetailCustomerProfile = 'commerce.customer-context.ensure-retail-customer-profile';
const commerceCustomerContextRemoveSavedAddress = 'commerce.customer-context.remove-saved-address';
const commerceCustomerContextSavedAddressSourceReceiptRead =
  'commerce.customer-context.saved-address-source-receipt.read';
const commerceCustomerContextSourceRead = 'commerce.customer-context.source-read';
const commerceCustomerContextSourceWrite = 'commerce.customer-context.source-write';
const commerceCustomerContextUpdateCustomerGroup = 'commerce.customer-context.update-customer-group';
const commerceCustomerContextUpdateSavedAddress = 'commerce.customer-context.update-saved-address';
const commerceInventoryApiInventorySourceImportReceipt = 'commerce.inventory.api.inventory-source-import-receipt';
const commerceInventoryImportSourceAssertion = 'commerce.inventory.import-source-assertion';
const commerceInventoryInventorySourceImportReceiptRead = 'commerce.inventory.inventory-source-import-receipt.read';
const commerceInventorySourceRead = 'commerce.inventory.source-read';
const commercePricingApiPriceSourceResultLookup = 'commerce.pricing.api.price-source-result-lookup';
const commercePricingDefinePrice = 'commerce.pricing.define-price';
const commercePricingPriceSourceResultLookupRead = 'commerce.pricing.price-source-result-lookup.read';
const commercePricingRevisePrice = 'commerce.pricing.revise-price';
const commercePricingSourceRead = 'commerce.pricing.source-read';
const commercePricingSourceWrite = 'commerce.pricing.source-write';
const integrationSymmyAdmitSymmySync = 'integration.symmy.admit-symmy-sync';
const integrationSymmyExecuteSymmyJob = 'integration.symmy.execute-symmy-job';
const partyRegistry = 'party-registry';
const partyRegistrySourceWrite = 'party.registry.source-write';
const priceGroupCatalog = 'price-group-catalog';
const pricingPriceGroupCatalogApiPriceGroupResultLookup = 'pricing.price-group-catalog.api.price-group-result-lookup';
const pricingPriceGroupCatalogCreatePriceGroup = 'pricing.price-group-catalog.create-price-group';
const pricingPriceGroupCatalogCreatePriceGroupDefinitionRevision =
  'pricing.price-group-catalog.create-price-group-definition-revision';
const pricingPriceGroupCatalogPriceGroupResultLookupRead = 'pricing.price-group-catalog.price-group-result-lookup.read';
const pricingPriceGroupCatalogSourceRead = 'pricing.price-group-catalog.source-read';
const pricingPriceGroupCatalogSourceWrite = 'pricing.price-group-catalog.source-write';

/**
 * The registered-workload calls this module's credential makes; its manifest declares them. Demo divergence
 * exception 8, to be offered upstream: upstream main has no production source for these rules
 * (`ONTOS_GATEWAY_MODULE_BINDINGS=[]` in `.env.example`), so each entry is verbatim from main's own fixture for its
 * flow. The Shell keeps an entry only while the installed receiver declares its workload and declaration, and a
 * tenant still needs an active registration of that workload.
 */
export const symmyIntegrationRegisteredWorkloadCalls = [
  // origin/main 5608aae1d: symmy-c14-customer-rules.mts — INTERNAL_C14 actual customer revisions and GET round-trip retain native targets under current Privacy; organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: partyRegistry,
    declarationKey: 'party.registry.party.create',
    entrypointKey: 'party.registry.create-party',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: partyRegistrySourceWrite,
  },
  // origin/main 5608aae1d: symmy-c14-customer-rules.mts — INTERNAL_C14 actual customer revisions and GET round-trip retain native targets under current Privacy; organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: partyRegistry,
    declarationKey: 'party.registry.party.update',
    entrypointKey: 'party.registry.update-party',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: partyRegistrySourceWrite,
  },
  // origin/main 5608aae1d: symmy-c14-customer-rules.mts — INTERNAL_C14 actual customer revisions and GET round-trip retain native targets under current Privacy
  {
    audience: commerceCustomerContext,
    declarationKey: 'commerce.customer-context.retail-customer-profile.ensure',
    entrypointKey: commerceCustomerContextEnsureRetailCustomerProfile,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceWrite,
  },
  // origin/main 5608aae1d: symmy-c14-customer-rules.mts — INTERNAL_C14 actual customer revisions and GET round-trip retain native targets under current Privacy
  {
    allowHistoricalDeliveryRecovery: true,
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextCustomerProfileSourceRead,
    entrypointKey: commerceCustomerContextApiCustomerProfileSource,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    recoveryOf: {
      actionKey: commerceCustomerContextEnsureRetailCustomerProfile,
      jobKey: integrationSymmyExecuteSymmyJob,
    },
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-customer-assignment-fixture.mts — INTERNAL_C14 explicit Retail assignment retains its native command and admits only current minimal recovery after write retirement
  {
    audience: commerceCustomerContext,
    declarationKey: 'commerce.customer-context.customer-price-group.assign',
    entrypointKey: commerceCustomerContextAssignCustomerPriceGroup,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceWrite,
  },
  // origin/main 5608aae1d: symmy-c14-customer-assignment-fixture.mts — INTERNAL_C14 explicit Retail assignment retains its native command and admits only current minimal recovery after write retirement
  {
    allowHistoricalDeliveryRecovery: true,
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextCustomerPriceGroupAssignmentReceiptRead,
    entrypointKey: commerceCustomerContextApiCustomerPriceGroupAssignmentReceipt,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    recoveryOf: { actionKey: commerceCustomerContextAssignCustomerPriceGroup, jobKey: integrationSymmyExecuteSymmyJob },
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-customer-assignment-fixture.mts — INTERNAL_C14 explicit Retail assignment retains its native command and admits only current minimal recovery after write retirement; symmy-c14-pricing-routes-runtime.mts — INTERNAL_C14 Price List routes preserve real source Group identity, paging and current read authority; organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: priceGroupCatalog,
    declarationKey: 'pricing.price-group-catalog.price-group.create',
    entrypointKey: pricingPriceGroupCatalogCreatePriceGroup,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: pricingPriceGroupCatalogSourceWrite,
  },
  // origin/main 5608aae1d: symmy-c14-customer-assignment-fixture.mts — INTERNAL_C14 explicit Retail assignment retains its native command and admits only current minimal recovery after write retirement; symmy-c14-pricing-routes-runtime.mts — INTERNAL_C14 Price List routes preserve real source Group identity, paging and current read authority; organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    allowHistoricalDeliveryRecovery: true,
    audience: priceGroupCatalog,
    declarationKey: pricingPriceGroupCatalogPriceGroupResultLookupRead,
    entrypointKey: pricingPriceGroupCatalogApiPriceGroupResultLookup,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    recoveryOf: { actionKey: pricingPriceGroupCatalogCreatePriceGroup, jobKey: integrationSymmyExecuteSymmyJob },
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: pricingPriceGroupCatalogSourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-customer-assignment-fixture.mts — INTERNAL_C14 explicit Retail assignment retains its native command and admits only current minimal recovery after write retirement
  {
    audience: 'privacy',
    declarationKey: 'privacy.core.source-processing-eligibility.read',
    entrypointKey: 'privacy.core.api.source-processing-eligibility',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: 'privacy.core.source-processing-check',
  },
  // origin/main 5608aae1d: symmy-c14-membership-rules.mts — INTERNAL_C14 selected Group Membership route assigns the actual Retail profile and recovers its original native receipt; symmy-c14-sync-authority.mts — INTERNAL_C14 actual synchronous Group and Stock routes persist native effects and recover exact receipts without jobs
  {
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextCustomerGroupCreate,
    entrypointKey: commerceCustomerContextCreateCustomerGroup,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceActionKey: integrationSymmyAdmitSymmySync,
    workloadKey: commerceCustomerContextSourceWrite,
  },
  // origin/main 5608aae1d: symmy-c14-membership-rules.mts — INTERNAL_C14 selected Group Membership route assigns the actual Retail profile and recovers its original native receipt
  {
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextCustomerGroupDefinitionSourceRead,
    entrypointKey: commerceCustomerContextApiCustomerGroupDefinitionSource,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-membership-rules.mts — INTERNAL_C14 selected Group Membership route assigns the actual Retail profile and recovers its original native receipt; organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: commerceCustomerContext,
    declarationKey: 'commerce.customer-context.customer-group-membership-source.apply',
    entrypointKey: commerceCustomerContextApplyCustomerGroupMembershipSource,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceWrite,
  },
  // origin/main 5608aae1d: symmy-c14-membership-rules.mts — INTERNAL_C14 selected Group Membership route assigns the actual Retail profile and recovers its original native receipt; organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    allowHistoricalDeliveryRecovery: true,
    audience: commerceCustomerContext,
    declarationKey: 'commerce.customer-context.customer-group-membership-source-receipt.read',
    entrypointKey: 'commerce.customer-context.api.customer-group-membership-source-receipt',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    recoveryOf: {
      actionKey: commerceCustomerContextApplyCustomerGroupMembershipSource,
      jobKey: integrationSymmyExecuteSymmyJob,
    },
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-saved-address-rules.mts — INTERNAL_C14 native SavedAddress Add, Update, Remove and read-only recovery obey current Privacy
  {
    audience: commerceCustomerContext,
    declarationKey: 'commerce.customer-context.saved-address.add',
    entrypointKey: commerceCustomerContextAddSavedAddress,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceWrite,
  },
  // origin/main 5608aae1d: symmy-c14-saved-address-rules.mts — INTERNAL_C14 native SavedAddress Add, Update, Remove and read-only recovery obey current Privacy
  {
    audience: commerceCustomerContext,
    declarationKey: 'commerce.customer-context.saved-address.update',
    entrypointKey: commerceCustomerContextUpdateSavedAddress,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceWrite,
  },
  // origin/main 5608aae1d: symmy-c14-saved-address-rules.mts — INTERNAL_C14 native SavedAddress Add, Update, Remove and read-only recovery obey current Privacy
  {
    audience: commerceCustomerContext,
    declarationKey: 'commerce.customer-context.saved-address.remove',
    entrypointKey: commerceCustomerContextRemoveSavedAddress,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceWrite,
  },
  // origin/main 5608aae1d: symmy-c14-saved-address-rules.mts — INTERNAL_C14 native SavedAddress Add, Update, Remove and read-only recovery obey current Privacy
  {
    allowHistoricalDeliveryRecovery: true,
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextSavedAddressSourceReceiptRead,
    entrypointKey: commerceCustomerContextApiSavedAddressSourceReceipt,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    recoveryOf: { actionKey: commerceCustomerContextAddSavedAddress, jobKey: integrationSymmyExecuteSymmyJob },
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-saved-address-rules.mts — INTERNAL_C14 native SavedAddress Add, Update, Remove and read-only recovery obey current Privacy
  {
    allowHistoricalDeliveryRecovery: true,
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextSavedAddressSourceReceiptRead,
    entrypointKey: commerceCustomerContextApiSavedAddressSourceReceipt,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    recoveryOf: { actionKey: commerceCustomerContextUpdateSavedAddress, jobKey: integrationSymmyExecuteSymmyJob },
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-saved-address-rules.mts — INTERNAL_C14 native SavedAddress Add, Update, Remove and read-only recovery obey current Privacy
  {
    allowHistoricalDeliveryRecovery: true,
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextSavedAddressSourceReceiptRead,
    entrypointKey: commerceCustomerContextApiSavedAddressSourceReceipt,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    recoveryOf: { actionKey: commerceCustomerContextRemoveSavedAddress, jobKey: integrationSymmyExecuteSymmyJob },
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-sync-authority.mts — INTERNAL_C14 actual synchronous Group and Stock routes persist native effects and recover exact receipts without jobs
  {
    audience: commerceCustomerContext,
    declarationKey: 'commerce.customer-context.customer-group.update',
    entrypointKey: commerceCustomerContextUpdateCustomerGroup,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceActionKey: integrationSymmyAdmitSymmySync,
    workloadKey: commerceCustomerContextSourceWrite,
  },
  // origin/main 5608aae1d: symmy-c14-sync-authority.mts — INTERNAL_C14 actual synchronous Group and Stock routes persist native effects and recover exact receipts without jobs
  {
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextCustomerGroupDefinitionSourceRead,
    entrypointKey: commerceCustomerContextApiCustomerGroupDefinitionSource,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceActionKey: integrationSymmyAdmitSymmySync,
    workloadKey: commerceCustomerContextSourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-sync-authority.mts — INTERNAL_C14 actual synchronous Group and Stock routes persist native effects and recover exact receipts without jobs
  {
    audience: 'inventory',
    declarationKey: 'commerce.inventory.source-assertion.import',
    entrypointKey: commerceInventoryImportSourceAssertion,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    schemaVersion: '1',
    sourceActionKey: integrationSymmyAdmitSymmySync,
    workloadKey: 'commerce.inventory.source-write',
  },
  // origin/main 5608aae1d: symmy-c14-sync-authority.mts — INTERNAL_C14 actual synchronous Group and Stock routes persist native effects and recover exact receipts without jobs
  {
    audience: 'inventory',
    declarationKey: commerceInventoryInventorySourceImportReceiptRead,
    entrypointKey: commerceInventoryApiInventorySourceImportReceipt,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    schemaVersion: '1',
    sourceActionKey: integrationSymmyAdmitSymmySync,
    workloadKey: commerceInventorySourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-sync-authority.mts — INTERNAL_C14 actual synchronous Group and Stock routes persist native effects and recover exact receipts without jobs
  {
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextCustomerGroupDefinitionSourceRead,
    entrypointKey: commerceCustomerContextApiCustomerGroupDefinitionSource,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    recoveryOf: { actionKey: commerceCustomerContextCreateCustomerGroup, jobKey: integrationSymmyExecuteSymmyJob },
    schemaVersion: '1',
    sourceActionKey: integrationSymmyAdmitSymmySync,
    workloadKey: commerceCustomerContextSourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-sync-authority.mts — INTERNAL_C14 actual synchronous Group and Stock routes persist native effects and recover exact receipts without jobs
  {
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextCustomerGroupDefinitionSourceRead,
    entrypointKey: commerceCustomerContextApiCustomerGroupDefinitionSource,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    recoveryOf: { actionKey: commerceCustomerContextUpdateCustomerGroup, jobKey: integrationSymmyExecuteSymmyJob },
    schemaVersion: '1',
    sourceActionKey: integrationSymmyAdmitSymmySync,
    workloadKey: commerceCustomerContextSourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-sync-authority.mts — INTERNAL_C14 actual synchronous Group and Stock routes persist native effects and recover exact receipts without jobs
  {
    audience: 'inventory',
    declarationKey: commerceInventoryInventorySourceImportReceiptRead,
    entrypointKey: commerceInventoryApiInventorySourceImportReceipt,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    recoveryOf: { actionKey: commerceInventoryImportSourceAssertion, jobKey: integrationSymmyExecuteSymmyJob },
    schemaVersion: '1',
    sourceActionKey: integrationSymmyAdmitSymmySync,
    workloadKey: commerceInventorySourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-product-owner-conformance.test.mts — INTERNAL_C14 actual Shell and durable worker create one Catalog Product with two Variants and recover the original committed effect; symmy-privacy-dispatch-fixture.mts — INTERNAL actual Privacy dispatch enforces Tenant retention authority, rechecks concurrent holds and reports native execution receipts
  {
    audience: 'catalog',
    declarationKey: 'commerce.catalog.product.create',
    entrypointKey: commerceCatalogCreateProduct,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    schemaVersion: '2',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCatalogSymmyProductImport,
  },
  // origin/main 5608aae1d: symmy-c14-product-owner-conformance.test.mts — INTERNAL_C14 actual Shell and durable worker create one Catalog Product with two Variants and recover the original committed effect
  {
    audience: 'catalog',
    declarationKey: 'commerce.catalog.variant.create',
    entrypointKey: commerceCatalogCreateVariant,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    schemaVersion: '2',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCatalogSymmyProductImport,
  },
  // origin/main 5608aae1d: symmy-c14-product-owner-conformance.test.mts — INTERNAL_C14 actual Shell and durable worker create one Catalog Product with two Variants and recover the original committed effect
  {
    audience: 'catalog',
    declarationKey: 'commerce.catalog.product.update',
    entrypointKey: 'commerce.catalog.update-product',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCatalogSymmyProductImport,
  },
  // origin/main 5608aae1d: symmy-c14-product-owner-conformance.test.mts — INTERNAL_C14 actual Shell and durable worker create one Catalog Product with two Variants and recover the original committed effect
  {
    audience: 'catalog',
    declarationKey: 'commerce.catalog.variant-localized-facts.set',
    entrypointKey: commerceCatalogSetVariantLocalizedFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: 'commerce.catalog.symmy-variant-localized-facts',
  },
  // origin/main 5608aae1d: symmy-c14-product-owner-conformance.test.mts — INTERNAL_C14 actual Shell and durable worker create one Catalog Product with two Variants and recover the original committed effect
  {
    audience: 'catalog',
    declarationKey: 'commerce.catalog.catalog-source-products.read',
    entrypointKey: 'commerce.catalog.api.catalog-source-products',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCatalogSymmyProductRead,
  },
  // origin/main 5608aae1d: symmy-c14-product-owner-conformance.test.mts — INTERNAL_C14 actual Shell and durable worker create one Catalog Product with two Variants and recover the original committed effect
  {
    allowHistoricalDeliveryRecovery: true,
    audience: 'catalog',
    declarationKey: 'commerce.catalog.create-product-recovery.read',
    entrypointKey: 'commerce.catalog.api.create-product-recovery',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    recoveryOf: { actionKey: commerceCatalogCreateProduct, jobKey: integrationSymmyExecuteSymmyJob },
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCatalogSymmyProductRead,
  },
  // origin/main 5608aae1d: symmy-c14-product-owner-conformance.test.mts — INTERNAL_C14 actual Shell and durable worker create one Catalog Product with two Variants and recover the original committed effect
  {
    allowHistoricalDeliveryRecovery: true,
    audience: 'catalog',
    declarationKey: 'commerce.catalog.create-variant-recovery.read',
    entrypointKey: 'commerce.catalog.api.create-variant-recovery',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    recoveryOf: { actionKey: commerceCatalogCreateVariant, jobKey: integrationSymmyExecuteSymmyJob },
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCatalogSymmyProductRead,
  },
  // origin/main 5608aae1d: symmy-c14-product-owner-conformance.test.mts — INTERNAL_C14 actual Shell and durable worker create one Catalog Product with two Variants and recover the original committed effect
  {
    audience: 'catalog',
    declarationKey: 'commerce.catalog.set-variant-localized-facts-recovery.read',
    entrypointKey: 'commerce.catalog.api.set-variant-localized-facts-recovery',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    recoveryOf: { actionKey: commerceCatalogSetVariantLocalizedFacts, jobKey: integrationSymmyExecuteSymmyJob },
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: 'commerce.catalog.symmy-variant-localized-facts-recovery',
  },
  // origin/main 5608aae1d: symmy-c14-product-owner-conformance.test.mts — INTERNAL_C14 actual Shell and durable worker create one Catalog Product with two Variants and recover the original committed effect; symmy-c14-pricing-routes-runtime.mts — INTERNAL_C14 Price List routes preserve real source Group identity, paging and current read authority
  {
    audience: 'pricing',
    declarationKey: 'commerce.pricing.price.define',
    entrypointKey: commercePricingDefinePrice,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '2',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commercePricingSourceWrite,
  },
  // origin/main 5608aae1d: symmy-c14-product-owner-conformance.test.mts — INTERNAL_C14 actual Shell and durable worker create one Catalog Product with two Variants and recover the original committed effect; symmy-c14-pricing-routes-runtime.mts — INTERNAL_C14 Price List routes preserve real source Group identity, paging and current read authority
  {
    allowHistoricalDeliveryRecovery: true,
    audience: 'pricing',
    declarationKey: commercePricingPriceSourceResultLookupRead,
    entrypointKey: commercePricingApiPriceSourceResultLookup,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    recoveryOf: { actionKey: commercePricingDefinePrice, jobKey: integrationSymmyExecuteSymmyJob },
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commercePricingSourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-pricing-routes-runtime.mts — INTERNAL_C14 Price List routes preserve real source Group identity, paging and current read authority
  {
    audience: priceGroupCatalog,
    declarationKey: pricingPriceGroupCatalogPriceGroupResultLookupRead,
    entrypointKey: pricingPriceGroupCatalogApiPriceGroupResultLookup,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    recoveryOf: {
      actionKey: pricingPriceGroupCatalogCreatePriceGroupDefinitionRevision,
      jobKey: integrationSymmyExecuteSymmyJob,
    },
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: pricingPriceGroupCatalogSourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-pricing-routes-runtime.mts — INTERNAL_C14 Price List routes preserve real source Group identity, paging and current read authority
  {
    audience: 'pricing',
    declarationKey: commercePricingPriceSourceResultLookupRead,
    entrypointKey: commercePricingApiPriceSourceResultLookup,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    recoveryOf: { actionKey: commercePricingRevisePrice, jobKey: integrationSymmyExecuteSymmyJob },
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commercePricingSourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-pricing-routes-runtime.mts — INTERNAL_C14 Price List routes preserve real source Group identity, paging and current read authority
  {
    audience: priceGroupCatalog,
    declarationKey: 'pricing.price-group-catalog.price-group-source-associations.read',
    entrypointKey: 'pricing.price-group-catalog.api.price-group-source-associations',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: pricingPriceGroupCatalogSourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-pricing-routes-runtime.mts — INTERNAL_C14 Price List routes preserve real source Group identity, paging and current read authority
  {
    audience: priceGroupCatalog,
    declarationKey: 'pricing.price-group-catalog.price-group-definition-revision.create',
    entrypointKey: pricingPriceGroupCatalogCreatePriceGroupDefinitionRevision,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: pricingPriceGroupCatalogSourceWrite,
  },
  // origin/main 5608aae1d: symmy-c14-pricing-routes-runtime.mts — INTERNAL_C14 Price List routes preserve real source Group identity, paging and current read authority
  {
    audience: 'pricing',
    declarationKey: 'commerce.pricing.price.revise',
    entrypointKey: commercePricingRevisePrice,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '2',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commercePricingSourceWrite,
  },
  // origin/main 5608aae1d: symmy-c14-policy-fixture.mts — requires Current owner facts and exact SQL enrollment before an internal Assortment import can persist
  {
    audience: 'assortment',
    declarationKey: 'commerce.assortment.symmy-fixture-rule.import',
    entrypointKey: 'commerce.assortment.import-symmy-rule',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: 'commerce.assortment.symmy-fixture-rule-import',
  },
  // origin/main 5118b15eb: symmy-c14-policy-fixture.mts — recovers one dated seller VAT declaration through Shell and C14 after response loss and authority revocation
  {
    audience: 'tax',
    declarationKey: 'commerce.tax.seller-vat-regime-declaration.import',
    entrypointKey: 'commerce.tax.import-seller-vat-regime-declarations',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: 'commerce.tax.symmy-seller-vat-fixture-import',
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextCustomerProfileSourceRead,
    entrypointKey: commerceCustomerContextApiCustomerProfileSource,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceRead,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: commerceCustomerContext,
    declarationKey: 'commerce.customer-context.organization-customer-profile-ico.change',
    entrypointKey: 'commerce.customer-context.change-organization-customer-profile-ico',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceWrite,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: partyRegistry,
    declarationKey: 'party.registry.counterparty.onboard',
    entrypointKey: 'party.registry.counterparty-customer-onboard',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: partyRegistrySourceWrite,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: commerceCustomerContext,
    declarationKey: 'commerce.customer-context.counterparty-purchasing-profile.create',
    entrypointKey: 'commerce.customer-context.create-counterparty-purchasing-profile',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceWrite,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextCustomerGroupCreate,
    entrypointKey: commerceCustomerContextCreateCustomerGroup,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceWrite,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: commerceCustomerContext,
    declarationKey: 'commerce.customer-context.counterparty-price-group.assign',
    entrypointKey: commerceCustomerContextAssignCounterpartyPriceGroup,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceWrite,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    allowHistoricalDeliveryRecovery: true,
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextCustomerPriceGroupAssignmentReceiptRead,
    entrypointKey: commerceCustomerContextApiCustomerPriceGroupAssignmentReceipt,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    recoveryOf: {
      actionKey: commerceCustomerContextAssignCounterpartyPriceGroup,
      jobKey: integrationSymmyExecuteSymmyJob,
    },
    schemaVersion: '1',
    workerKey: integrationSymmyExecuteSymmyJob,
    workloadKey: commerceCustomerContextSourceRead,
  },
] as const satisfies readonly OntosRegisteredWorkloadCallInput[];
