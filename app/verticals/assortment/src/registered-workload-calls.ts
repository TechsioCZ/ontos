import type { OntosRegisteredWorkloadCallInput } from '@app/core-runtime';

const commerceAssortmentSymmyFixtureCurrentness = 'commerce.assortment.symmy-fixture-currentness';
const commerceAssortmentSymmyFixtureRuleImport = 'commerce.assortment.symmy-fixture-rule-import';
const integrationSymmyExecuteSymmyJob = 'integration.symmy.execute-symmy-job';

/**
 * The registered-workload calls this module's credential makes; its manifest declares them. Demo divergence
 * exception 8, to be offered upstream: upstream main has no production source for these rules
 * (`ONTOS_GATEWAY_MODULE_BINDINGS=[]` in `.env.example`), so each entry is verbatim from main's own fixture for its
 * flow. The Shell keeps an entry only while the installed receiver declares its workload and declaration, and a
 * tenant still needs an active registration of that workload.
 */
export const assortmentRegisteredWorkloadCalls = [
  // origin/main 5608aae1d: symmy-c14-policy-fixture.mts — requires Current owner facts and exact SQL enrollment before an internal Assortment import can persist
  {
    audience: 'catalog',
    declarationKey: 'commerce.catalog.assortment-product-classification-v1.read',
    entrypointKey: 'commerce.catalog.api.assortment-product-classification-v1',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    schemaVersion: '1',
    sourceWorkloadKey: commerceAssortmentSymmyFixtureRuleImport,
    workloadKey: commerceAssortmentSymmyFixtureCurrentness,
  },
  // origin/main 5608aae1d: symmy-c14-policy-fixture.mts — requires Current owner facts and exact SQL enrollment before an internal Assortment import can persist
  {
    audience: 'commerce-customer-context',
    declarationKey: 'commerce.customer-context.customer-group.read',
    entrypointKey: 'commerce.customer-context.api.customer-group-detail',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: commerceAssortmentSymmyFixtureRuleImport,
    workloadKey: commerceAssortmentSymmyFixtureCurrentness,
  },
  // origin/main 5608aae1d: symmy-c14-policy-fixture.mts — requires Current owner facts and exact SQL enrollment before an internal Assortment import can persist
  {
    audience: 'commerce-market-catalog',
    declarationKey: 'commerce.market-catalog.assortment-fixture-market-association.read',
    entrypointKey: 'commerce.market-catalog.api.assortment-fixture-market-association',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: commerceAssortmentSymmyFixtureRuleImport,
    workloadKey: commerceAssortmentSymmyFixtureCurrentness,
  },
  // origin/main 5608aae1d: symmy-c14-policy-fixture.mts — requires Current owner facts and exact SQL enrollment before an internal Assortment import can persist
  {
    audience: 'storefront-registry',
    declarationKey: 'commerce.storefront-registry.storefront-application.read-current',
    entrypointKey: 'commerce.storefront-registry.api.current-storefront-application',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    sourceWorkloadKey: commerceAssortmentSymmyFixtureRuleImport,
    workloadKey: commerceAssortmentSymmyFixtureCurrentness,
  },
] as const satisfies readonly OntosRegisteredWorkloadCallInput[];
