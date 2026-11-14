import type { OntosRegisteredWorkloadCallInput } from '@app/core-runtime';

const integrationSymmyExecuteSymmyJob = 'integration.symmy.execute-symmy-job';
const partyRegistrySourceRead = 'party.registry.source-read';
const partyRegistrySourceWrite = 'party.registry.source-write';
const privacyCoreApiSourceProcessingEligibility = 'privacy.core.api.source-processing-eligibility';
const privacyCoreSourceProcessingCheck = 'privacy.core.source-processing-check';
const privacyCoreSourceProcessingEligibilityRead = 'privacy.core.source-processing-eligibility.read';

/**
 * The registered-workload calls this module's credential makes; its manifest declares them. Demo divergence
 * exception 8, to be offered upstream: upstream main has no production source for these rules
 * (`ONTOS_GATEWAY_MODULE_BINDINGS=[]` in `.env.example`), so each entry is verbatim from main's own fixture for its
 * flow. The Shell keeps an entry only while the installed receiver declares its workload and declaration, and a
 * tenant still needs an active registration of that workload.
 */
export const partyRegistryRegisteredWorkloadCalls = [
  // origin/main 5608aae1d: symmy-c14-customer-rules.mts — INTERNAL_C14 actual customer revisions and GET round-trip retain native targets under current Privacy
  {
    audience: 'privacy',
    declarationKey: privacyCoreSourceProcessingEligibilityRead,
    entrypointKey: privacyCoreApiSourceProcessingEligibility,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: partyRegistrySourceWrite,
    workloadKey: privacyCoreSourceProcessingCheck,
  },
  // origin/main 5608aae1d: symmy-c14-customer-rules.mts — INTERNAL_C14 actual customer revisions and GET round-trip retain native targets under current Privacy
  {
    audience: 'privacy',
    declarationKey: privacyCoreSourceProcessingEligibilityRead,
    entrypointKey: privacyCoreApiSourceProcessingEligibility,
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: partyRegistrySourceRead,
    workloadKey: privacyCoreSourceProcessingCheck,
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
    sourceWorkloadKey: partyRegistrySourceRead,
    workloadKey: privacyCoreSourceProcessingCheck,
  },
  // origin/main 5608aae1d: organization-source-customer-owner-fixture.mts — actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds
  {
    audience: 'privacy',
    declarationKey: 'privacy.core.organization-business-applicability.read',
    entrypointKey: 'privacy.core.api.organization-business-applicability',
    jobKey: integrationSymmyExecuteSymmyJob,
    legalEntityScope: 'required',
    schemaVersion: '1',
    sourceWorkloadKey: partyRegistrySourceWrite,
    workloadKey: 'privacy.core.organization-business-check',
  },
] as const satisfies readonly OntosRegisteredWorkloadCallInput[];
