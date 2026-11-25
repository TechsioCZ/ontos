import type { OntosRegisteredWorkloadCallInput } from '@app/core-runtime';

const commerceCustomerContext = 'commerce-customer-context';
const commerceCustomerContextApiCustomerProfileOrganizationIcoFacts =
  'commerce.customer-context.api.customer-profile-organization-ico-facts';
const commerceCustomerContextCustomerProfileOrganizationIcoFactsRead =
  'commerce.customer-context.customer-profile-organization-ico-facts.read';
const commerceCustomerContextOrganizationIcoFactsRead = 'commerce.customer-context.organization-ico-facts.read';
const integrationSymmyApiSymmySourceOrganizationFacts = 'integration.symmy.api.symmy-source-organization-facts';
const integrationSymmyExecuteSymmyJob = 'integration.symmy.execute-symmy-job';
const integrationSymmySourceOrganizationFactsRead = 'integration.symmy.source-organization-facts.read';
const integrationSymmySymmySourceOrganizationFactsRead = 'integration.symmy.symmy-source-organization-facts.read';
const partyRegistry = 'party-registry';
const partyRegistryApiOrganizationIcoFacts = 'party.registry.api.organization-ico-facts';
const partyRegistryApiOrganizationRecordFacts = 'party.registry.api.organization-record-facts';
const partyRegistryApiSourcePersonAdmission = 'party.registry.api.source-person-admission';
const partyRegistryOrganizationIcoFactsRead = 'party.registry.organization-ico-facts.read';
const partyRegistryOrganizationRecordFactsRead = 'party.registry.organization-record-facts.read';
const partyRegistrySourcePersonAdmissionRead = 'party.registry.source-person-admission.read';
const partyRegistrySourceRead = 'party.registry.source-read';
const privacyCoreOrganizationBusinessCheck = 'privacy.core.organization-business-check';
const privacyCoreOrganizationProfileIcoCheck = 'privacy.core.organization-profile-ico-check';
const privacyCoreSourceProcessingCheck = 'privacy.core.source-processing-check';
const symmyIntegration = 'symmy-integration';

/**
 * The registered-workload calls this module's credential makes; its manifest declares them. Each entry is verbatim
 * from the fixture named on it. The Shell keeps an entry only while the installed receiver declares its workload and
 * declaration, and a tenant still needs an active registration of that workload.
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
  // symmy-route-bindings-main-contracts.test.ts — the Symmy customers and membership routes reach privacy.core.requirement.customer-intake-organization-party
  {
    audience: partyRegistry,
    declarationKey: partyRegistryOrganizationRecordFactsRead,
    entrypointKey: partyRegistryApiOrganizationRecordFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreSourceProcessingCheck,
    workloadKey: partyRegistrySourceRead,
  },
  // symmy-route-bindings-main-contracts.test.ts — the Symmy customers and membership routes reach privacy.core.requirement.customer-intake-organization-party
  {
    allowRecoverySource: true,
    audience: partyRegistry,
    declarationKey: partyRegistryOrganizationRecordFactsRead,
    entrypointKey: partyRegistryApiOrganizationRecordFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreSourceProcessingCheck,
    workloadKey: partyRegistrySourceRead,
  },
  // symmy-route-bindings-main-contracts.test.ts — the Symmy customers and membership routes reach privacy.core.requirement.customer-intake-organization-profile
  {
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextCustomerProfileOrganizationIcoFactsRead,
    entrypointKey: commerceCustomerContextApiCustomerProfileOrganizationIcoFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreSourceProcessingCheck,
    workloadKey: commerceCustomerContextOrganizationIcoFactsRead,
  },
  // symmy-route-bindings-main-contracts.test.ts — the Symmy customers and membership routes reach privacy.core.requirement.customer-intake-organization-profile
  {
    allowRecoverySource: true,
    audience: commerceCustomerContext,
    declarationKey: commerceCustomerContextCustomerProfileOrganizationIcoFactsRead,
    entrypointKey: commerceCustomerContextApiCustomerProfileOrganizationIcoFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreSourceProcessingCheck,
    workloadKey: commerceCustomerContextOrganizationIcoFactsRead,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: symmyIntegration,
    declarationKey: integrationSymmySymmySourceOrganizationFactsRead,
    entrypointKey: integrationSymmyApiSymmySourceOrganizationFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreOrganizationBusinessCheck,
    workloadKey: integrationSymmySourceOrganizationFactsRead,
  },
  // symmy-route-bindings-main-contracts.test.ts — the Symmy customers and membership routes reach privacy.core.requirement.organization-business-source-facts
  {
    allowRecoverySource: true,
    audience: symmyIntegration,
    declarationKey: integrationSymmySymmySourceOrganizationFactsRead,
    entrypointKey: integrationSymmyApiSymmySourceOrganizationFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreOrganizationBusinessCheck,
    workloadKey: integrationSymmySourceOrganizationFactsRead,
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
  // symmy-route-bindings-main-contracts.test.ts — the Symmy customers and membership routes reach privacy.core.requirement.organization-profile-ico-owner-facts, read when Symmy recovers a lost company ICO change
  {
    allowRecoverySource: true,
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
    declarationKey: partyRegistryOrganizationIcoFactsRead,
    entrypointKey: partyRegistryApiOrganizationIcoFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreOrganizationProfileIcoCheck,
    workloadKey: partyRegistrySourceRead,
  },
  // symmy-route-bindings-main-contracts.test.ts — the Symmy customers and membership routes reach privacy.core.requirement.organization-profile-ico-party-facts, read when Symmy recovers a lost company ICO change
  {
    allowRecoverySource: true,
    audience: partyRegistry,
    declarationKey: partyRegistryOrganizationIcoFactsRead,
    entrypointKey: partyRegistryApiOrganizationIcoFacts,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    sourceWorkloadKey: privacyCoreOrganizationProfileIcoCheck,
    workloadKey: partyRegistrySourceRead,
  },
] as const satisfies readonly OntosRegisteredWorkloadCallInput[];
