import type { OntosRegisteredWorkloadCallInput } from '@app/core-runtime';

const commerceCustomerContextOrganizationIcoFactsRead = 'commerce.customer-context.organization-ico-facts.read';
const commerceCustomerContextSourceRead = 'commerce.customer-context.source-read';
const commerceCustomerContextSourceWrite = 'commerce.customer-context.source-write';
const integrationSymmyExecuteSymmyJob = 'integration.symmy.execute-symmy-job';
const partyRegistry = 'party-registry';
const partyRegistryApiCounterpartyOrganizationIcoFacts = 'party.registry.api.counterparty-organization-ico-facts';
const partyRegistryApiSourcePersonAdmission = 'party.registry.api.source-person-admission';
const partyRegistryCounterpartyOrganizationIcoFactsRead = 'party.registry.counterparty-organization-ico-facts.read';
const partyRegistrySourcePersonAdmissionRead = 'party.registry.source-person-admission.read';
const partyRegistrySourceRead = 'party.registry.source-read';
const privacyCoreApiOrganizationBusinessApplicability = 'privacy.core.api.organization-business-applicability';
const privacyCoreApiOrganizationProfileIcoApplicability = 'privacy.core.api.organization-profile-ico-applicability';
const privacyCoreApiSourceProcessingEligibility = 'privacy.core.api.source-processing-eligibility';
const privacyCoreOrganizationBusinessApplicabilityRead = 'privacy.core.organization-business-applicability.read';
const privacyCoreOrganizationBusinessCheck = 'privacy.core.organization-business-check';
const privacyCoreOrganizationProfileIcoApplicabilityRead = 'privacy.core.organization-profile-ico-applicability.read';
const privacyCoreOrganizationProfileIcoCheck = 'privacy.core.organization-profile-ico-check';
const privacyCoreSourceProcessingCheck = 'privacy.core.source-processing-check';
const privacyCoreSourceProcessingEligibilityRead = 'privacy.core.source-processing-eligibility.read';

/**
 * The registered-workload calls this module's credential makes; its manifest declares them. Demo divergence
 * exception 8, to be offered upstream: upstream main has no production source for these rules
 * (`ONTOS_GATEWAY_MODULE_BINDINGS=[]` in `.env.example`), so each entry is verbatim from main's own fixture for its
 * flow. The Shell keeps an entry only while the installed receiver declares its workload and declaration, and a
 * tenant still needs an active registration of that workload.
 */
export const commerceCustomerContextRegisteredWorkloadCalls = [
  // origin/main 5608aae1d: symmy-c14-customer-rules.mts — INTERNAL_C14 actual customer revisions and GET round-trip retain native targets under current Privacy
  {
    audience: 'privacy',
    declarationKey: privacyCoreSourceProcessingEligibilityRead,
    entrypointKey: privacyCoreApiSourceProcessingEligibility,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: commerceCustomerContextSourceWrite,
    workloadKey: privacyCoreSourceProcessingCheck,
  },
  // origin/main 5608aae1d: symmy-c14-customer-rules.mts — INTERNAL_C14 actual customer revisions and GET round-trip retain native targets under current Privacy
  {
    audience: partyRegistry,
    declarationKey: partyRegistrySourcePersonAdmissionRead,
    entrypointKey: partyRegistryApiSourcePersonAdmission,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    sourceWorkloadKey: commerceCustomerContextSourceWrite,
    workloadKey: partyRegistrySourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-customer-rules.mts — INTERNAL_C14 actual customer revisions and GET round-trip retain native targets under current Privacy
  {
    audience: 'privacy',
    declarationKey: privacyCoreSourceProcessingEligibilityRead,
    entrypointKey: privacyCoreApiSourceProcessingEligibility,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: commerceCustomerContextSourceRead,
    workloadKey: privacyCoreSourceProcessingCheck,
  },
  // origin/main 5608aae1d: symmy-c14-customer-rules.mts — INTERNAL_C14 actual customer revisions and GET round-trip retain native targets under current Privacy
  {
    audience: partyRegistry,
    declarationKey: partyRegistrySourcePersonAdmissionRead,
    entrypointKey: partyRegistryApiSourcePersonAdmission,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    sourceWorkloadKey: commerceCustomerContextSourceRead,
    workloadKey: partyRegistrySourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-customer-rules.mts — INTERNAL_C14 actual customer revisions and GET round-trip retain native targets under current Privacy
  {
    allowRecoverySource: true,
    audience: 'privacy',
    declarationKey: privacyCoreSourceProcessingEligibilityRead,
    entrypointKey: privacyCoreApiSourceProcessingEligibility,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: commerceCustomerContextSourceRead,
    workloadKey: privacyCoreSourceProcessingCheck,
  },
  // origin/main 5608aae1d: symmy-c14-customer-rules.mts — INTERNAL_C14 actual customer revisions and GET round-trip retain native targets under current Privacy
  {
    allowRecoverySource: true,
    audience: partyRegistry,
    declarationKey: partyRegistrySourcePersonAdmissionRead,
    entrypointKey: partyRegistryApiSourcePersonAdmission,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    sourceWorkloadKey: commerceCustomerContextSourceRead,
    workloadKey: partyRegistrySourceRead,
  },
  // origin/main 5608aae1d: symmy-c14-customer-assignment-fixture.mts — INTERNAL_C14 explicit Retail assignment retains its native command and admits only current minimal recovery after write retirement; organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: 'price-group-catalog',
    declarationKey: 'pricing.price-group-catalog.price-group.read.compatibility',
    entrypointKey: 'pricing.price-group-catalog.api.validate-price-group-compatibility',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'forbidden',
    schemaVersion: '1',
    sourceWorkloadKey: commerceCustomerContextSourceWrite,
    workloadKey: 'pricing.price-group-catalog.source-read',
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: 'privacy',
    declarationKey: privacyCoreOrganizationBusinessApplicabilityRead,
    entrypointKey: privacyCoreApiOrganizationBusinessApplicability,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: commerceCustomerContextSourceWrite,
    workloadKey: privacyCoreOrganizationBusinessCheck,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: 'privacy',
    declarationKey: privacyCoreOrganizationBusinessApplicabilityRead,
    entrypointKey: privacyCoreApiOrganizationBusinessApplicability,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: commerceCustomerContextSourceRead,
    workloadKey: privacyCoreOrganizationBusinessCheck,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    allowRecoverySource: true,
    audience: 'privacy',
    declarationKey: privacyCoreOrganizationBusinessApplicabilityRead,
    entrypointKey: privacyCoreApiOrganizationBusinessApplicability,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: commerceCustomerContextSourceRead,
    workloadKey: privacyCoreOrganizationBusinessCheck,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: 'privacy',
    declarationKey: privacyCoreOrganizationProfileIcoApplicabilityRead,
    entrypointKey: privacyCoreApiOrganizationProfileIcoApplicability,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: commerceCustomerContextSourceWrite,
    workloadKey: privacyCoreOrganizationProfileIcoCheck,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: 'privacy',
    declarationKey: privacyCoreOrganizationProfileIcoApplicabilityRead,
    entrypointKey: privacyCoreApiOrganizationProfileIcoApplicability,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: commerceCustomerContextSourceRead,
    workloadKey: privacyCoreOrganizationProfileIcoCheck,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: partyRegistry,
    declarationKey: partyRegistryCounterpartyOrganizationIcoFactsRead,
    entrypointKey: partyRegistryApiCounterpartyOrganizationIcoFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: commerceCustomerContextOrganizationIcoFactsRead,
    workloadKey: partyRegistrySourceRead,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    allowRecoverySource: true,
    audience: partyRegistry,
    declarationKey: partyRegistryCounterpartyOrganizationIcoFactsRead,
    entrypointKey: partyRegistryApiCounterpartyOrganizationIcoFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: commerceCustomerContextOrganizationIcoFactsRead,
    workloadKey: partyRegistrySourceRead,
  },
] as const satisfies readonly OntosRegisteredWorkloadCallInput[];
