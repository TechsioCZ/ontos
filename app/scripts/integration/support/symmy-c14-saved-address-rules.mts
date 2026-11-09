import { customerWorkerKey } from './symmy-c14-customer-rules.mts';

const addressOperations = [
  { action: 'add-saved-address', declaration: 'saved-address.add' },
  { action: 'update-saved-address', declaration: 'saved-address.update' },
  { action: 'remove-saved-address', declaration: 'saved-address.remove' },
] as const;

/** Finite INTERNAL_C14 native worker enrollment; no caller-selected authority. */
export const savedAddressWorkerRules = addressOperations.map(
  ({ action, declaration }) =>
    ({
      audience: 'commerce-customer-context',
      declarationKey: `commerce.customer-context.${declaration}`,
      entrypointKey: `commerce.customer-context.${action}`,
      jobKey: customerWorkerKey,
      legalEntityScope: 'required',
      schemaVersion: '1',
      workerKey: customerWorkerKey,
      workloadKey: 'commerce.customer-context.source-write',
    }) as const,
);

export const savedAddressRecoveryRules = addressOperations.map(
  ({ action }) =>
    ({
      allowHistoricalDeliveryRecovery: true,
      audience: 'commerce-customer-context',
      declarationKey: 'commerce.customer-context.saved-address-source-receipt.read',
      entrypointKey: 'commerce.customer-context.api.saved-address-source-receipt',
      jobKey: customerWorkerKey,
      legalEntityScope: 'required',
      recoveryOf: { actionKey: `commerce.customer-context.${action}`, jobKey: customerWorkerKey },
      schemaVersion: '1',
      workerKey: customerWorkerKey,
      workloadKey: 'commerce.customer-context.source-read',
    }) as const,
);
