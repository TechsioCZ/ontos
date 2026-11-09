const jobKey = 'integration.symmy.execute-symmy-job';
const partyWrite = 'party.registry.source-write';
const partyRead = 'party.registry.source-read';
const commerceWrite = 'commerce.customer-context.source-write';
const commerceRead = 'commerce.customer-context.source-read';
const commerceApp = 'commerce-customer-context';
const privacyRead = 'privacy.core.source-processing-check';
const partyApp = 'party-registry';

const sourceProcessing = {
  audience: 'privacy',
  declarationKey: 'privacy.core.source-processing-eligibility.read',
  entrypointKey: 'privacy.core.api.source-processing-eligibility',
  jobKey,
  legalEntityScope: 'required',
  schemaVersion: '1',
  workloadKey: privacyRead,
} as const;
const personProof = {
  audience: partyApp,
  declarationKey: 'party.registry.source-person-admission.read',
  entrypointKey: 'party.registry.api.source-person-admission',
  jobKey,
  legalEntityScope: 'optional',
  schemaVersion: '1',
  workloadKey: partyRead,
} as const;

/** These are explicit fixture enrollment rules; no request can choose its caller identity. */
export const customerWorkerRules = [
  {
    audience: partyApp,
    declarationKey: 'party.registry.party.create',
    entrypointKey: 'party.registry.create-party',
    jobKey,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    workerKey: jobKey,
    workloadKey: partyWrite,
  },
  {
    audience: partyApp,
    declarationKey: 'party.registry.party.update',
    entrypointKey: 'party.registry.update-party',
    jobKey,
    legalEntityScope: 'optional',
    schemaVersion: '1',
    workerKey: jobKey,
    workloadKey: partyWrite,
  },
  {
    audience: commerceApp,
    declarationKey: 'commerce.customer-context.retail-customer-profile.ensure',
    entrypointKey: 'commerce.customer-context.ensure-retail-customer-profile',
    jobKey,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: jobKey,
    workloadKey: commerceWrite,
  },
] as const;

export const customerRecoveryRules = [
  {
    allowHistoricalDeliveryRecovery: true,
    audience: commerceApp,
    declarationKey: 'commerce.customer-context.customer-profile-source.read',
    entrypointKey: 'commerce.customer-context.api.customer-profile-source',
    jobKey,
    legalEntityScope: 'required',
    recoveryOf: { actionKey: 'commerce.customer-context.ensure-retail-customer-profile', jobKey },
    schemaVersion: '1',
    workerKey: jobKey,
    workloadKey: commerceRead,
  },
] as const;

export const customerOwnerRelaySources = [
  {
    registeredWorkloads: [
      { ...sourceProcessing, sourceWorkloadKey: partyWrite },
      { ...sourceProcessing, sourceWorkloadKey: partyRead },
      { ...sourceProcessing, allowRecoverySource: true, sourceWorkloadKey: partyRead },
    ],
    sourceAppId: partyApp,
  },
  {
    registeredWorkloads: [
      { ...sourceProcessing, sourceWorkloadKey: commerceWrite },
      { ...personProof, sourceWorkloadKey: commerceWrite },
      { ...sourceProcessing, sourceWorkloadKey: commerceRead },
      { ...personProof, sourceWorkloadKey: commerceRead },
      { ...sourceProcessing, allowRecoverySource: true, sourceWorkloadKey: commerceRead },
      { ...personProof, allowRecoverySource: true, sourceWorkloadKey: commerceRead },
    ],
    sourceAppId: commerceApp,
  },
  {
    registeredWorkloads: [
      { ...personProof, sourceWorkloadKey: privacyRead },
      { ...personProof, allowRecoverySource: true, sourceWorkloadKey: privacyRead },
    ],
    sourceAppId: 'privacy',
  },
] as const;

export const customerFixtureWorkloads = [
  'integration.symmy-admit',
  'integration.symmy-poll',
  partyWrite,
  partyRead,
  commerceWrite,
  commerceRead,
  privacyRead,
] as const;
export const customerWorkerKey = jobKey;
