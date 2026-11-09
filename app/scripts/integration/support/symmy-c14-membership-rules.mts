import { customerWorkerKey } from './symmy-c14-customer-rules.mts';

export const membershipActionKey = 'commerce.customer-context.apply-customer-group-membership-source';
export const membershipReceiptKey = 'commerce.customer-context.api.customer-group-membership-source-receipt';
const common = {
  audience: 'commerce-customer-context',
  jobKey: customerWorkerKey,
  legalEntityScope: 'required',
  schemaVersion: '1',
} as const;

/** Fixed native workload enrollment; route data cannot select another principal or permission. */
export const membershipWorkerRules = [
  {
    ...common,
    declarationKey: 'commerce.customer-context.customer-group.create',
    entrypointKey: 'commerce.customer-context.create-customer-group',
    sourceActionKey: 'integration.symmy.admit-symmy-sync',
    workloadKey: 'commerce.customer-context.source-write',
  },
  {
    ...common,
    declarationKey: 'commerce.customer-context.customer-group-definition-source.read',
    entrypointKey: 'commerce.customer-context.api.customer-group-definition-source',
    workerKey: customerWorkerKey,
    workloadKey: 'commerce.customer-context.source-read',
  },
  {
    ...common,
    declarationKey: 'commerce.customer-context.customer-group-membership-source.apply',
    entrypointKey: membershipActionKey,
    workerKey: customerWorkerKey,
    workloadKey: 'commerce.customer-context.source-write',
  },
  {
    ...common,
    allowHistoricalDeliveryRecovery: true,
    declarationKey: 'commerce.customer-context.customer-group-membership-source-receipt.read',
    entrypointKey: membershipReceiptKey,
    recoveryOf: { actionKey: membershipActionKey, jobKey: customerWorkerKey },
    workerKey: customerWorkerKey,
    workloadKey: 'commerce.customer-context.source-read',
  },
] as const;
