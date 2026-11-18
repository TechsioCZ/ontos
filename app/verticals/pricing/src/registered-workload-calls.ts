import type { OntosRegisteredWorkloadCallInput } from '@app/core-runtime';

const commercePricingSourceWrite = 'commerce.pricing.source-write';
const integrationSymmyExecuteSymmyJob = 'integration.symmy.execute-symmy-job';

/**
 * The registered-workload calls this module's credential makes; its manifest declares them. Each entry is verbatim
 * from the fixture named on it. The Shell keeps an entry only while the installed receiver declares its workload and
 * declaration, and a tenant still needs an active registration of that workload.
 */
export const pricingRegisteredWorkloadCalls = [
  // origin/main 5608aae1d: symmy-c14-product-owner-conformance.test.mts — INTERNAL_C14 actual Shell and durable worker create one Catalog Product with two Variants and recover the original committed effect; symmy-c14-pricing-routes-runtime.mts — INTERNAL_C14 Price List routes preserve real source Group identity, paging and current read authority
  {
    audience: 'catalog',
    declarationKey: 'commerce.catalog.selection-evidence.read',
    entrypointKey: 'commerce.catalog.api.selection-evidence',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    schemaVersion: '1',
    sourceWorkloadKey: commercePricingSourceWrite,
    workloadKey: 'commerce.catalog.symmy-product-read',
  },
  // origin/main 5608aae1d: symmy-c14-product-owner-conformance.test.mts — INTERNAL_C14 actual Shell and durable worker create one Catalog Product with two Variants and recover the original committed effect; symmy-c14-pricing-routes-runtime.mts — INTERNAL_C14 Price List routes preserve real source Group identity, paging and current read authority
  {
    audience: 'commerce-market-catalog',
    declarationKey: 'commerce.market-catalog.market-catalog.read',
    entrypointKey: 'commerce.market-catalog.api.current-market-catalog',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: commercePricingSourceWrite,
    workloadKey: 'commerce.market-catalog.source-read',
  },
] as const satisfies readonly OntosRegisteredWorkloadCallInput[];
