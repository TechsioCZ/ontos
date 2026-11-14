import type { OntosRegisteredWorkloadCallInput } from '@app/core-runtime';

const commerceCustomerContext = 'commerce-customer-context';
const commerceCustomerContextApiCustomerProfileOrganizationIcoFacts =
  'commerce.customer-context.api.customer-profile-organization-ico-facts';
const commerceCustomerContextCustomerProfileOrganizationIcoFactsRead =
  'commerce.customer-context.customer-profile-organization-ico-facts.read';
const commerceCustomerContextOrganizationIcoFactsRead = 'commerce.customer-context.organization-ico-facts.read';
const integrationSymmyExecuteSymmyJob = 'integration.symmy.execute-symmy-job';
const partyRegistry = 'party-registry';
const partyRegistryApiOrganizationRecordFacts = 'party.registry.api.organization-record-facts';
const partyRegistryApiSourcePersonAdmission = 'party.registry.api.source-person-admission';
const partyRegistryOrganizationRecordFactsRead = 'party.registry.organization-record-facts.read';
const partyRegistrySourcePersonAdmissionRead = 'party.registry.source-person-admission.read';
const partyRegistrySourceRead = 'party.registry.source-read';
const privacyCoreOrganizationBusinessCheck = 'privacy.core.organization-business-check';
const privacyCoreOrganizationProfileIcoCheck = 'privacy.core.organization-profile-ico-check';
const privacyCoreSourceProcessingCheck = 'privacy.core.source-processing-check';

/**
 * The registered-workload calls this module's credential makes; its manifest declares them. Demo divergence
 * exception 8, to be offered upstream: upstream main has no production source for these rules
 * (`ONTOS_GATEWAY_MODULE_BINDINGS=[]` in `.env.example`), so each entry is verbatim from main's own fixture for its
 * flow. The Shell keeps an entry only while the installed receiver declares its workload and declaration, and a
 * tenant still needs an active registration of that workload.
 */
export const privacyRegisteredWorkloadCalls = [
  // origin/main 5608aae1d: symmy-c14-customer-rules.mts — INTERNAL_C14 actual customer revisions and GET round-trip retain native targets under current Privacy
  {
    audience: partyRegistry,
    declarationKey: partyRegistrySourcePersonAdmissionRead,
    entrypointKey: partyRegistryApiSourcePersonAdmission,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreSourceProcessingCheck,
    workloadKey: partyRegistrySourceRead,
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
    sourceWorkloadKey: privacyCoreSourceProcessingCheck,
    workloadKey: partyRegistrySourceRead,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: 'symmy-integration',
    declarationKey: 'integration.symmy.symmy-source-organization-facts.read',
    entrypointKey: 'integration.symmy.api.symmy-source-organization-facts',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreOrganizationBusinessCheck,
    workloadKey: 'integration.symmy.source-organization-facts.read',
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: partyRegistry,
    declarationKey: partyRegistryOrganizationRecordFactsRead,
    entrypointKey: partyRegistryApiOrganizationRecordFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreOrganizationBusinessCheck,
    workloadKey: partyRegistrySourceRead,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    allowRecoverySource: true,
    audience: partyRegistry,
    declarationKey: partyRegistryOrganizationRecordFactsRead,
    entrypointKey: partyRegistryApiOrganizationRecordFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreOrganizationBusinessCheck,
    workloadKey: partyRegistrySourceRead,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextCustomerProfileOrganizationIcoFactsRead,
    entrypointKey: commerceCustomerContextApiCustomerProfileOrganizationIcoFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreOrganizationBusinessCheck,
    workloadKey: commerceCustomerContextOrganizationIcoFactsRead,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    allowRecoverySource: true,
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextCustomerProfileOrganizationIcoFactsRead,
    entrypointKey: commerceCustomerContextApiCustomerProfileOrganizationIcoFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreOrganizationBusinessCheck,
    workloadKey: commerceCustomerContextOrganizationIcoFactsRead,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextCustomerProfileOrganizationIcoFactsRead,
    entrypointKey: commerceCustomerContextApiCustomerProfileOrganizationIcoFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreOrganizationProfileIcoCheck,
    workloadKey: commerceCustomerContextOrganizationIcoFactsRead,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: partyRegistry,
    declarationKey: 'party.registry.organization-ico-facts.read',
    entrypointKey: 'party.registry.api.organization-ico-facts',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreOrganizationProfileIcoCheck,
    workloadKey: partyRegistrySourceRead,
  },
] as const satisfies readonly OntosRegisteredWorkloadCallInput[];
