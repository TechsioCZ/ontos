import {
  SymmyCustomerSourceIntakeConsumerModule,
  SymmyCustomerSourceIntakeOperation,
} from '@app/privacy/api/source-processing-eligibility';
import type { SourceProcessingEligibilityRequest } from '@app/privacy/api/source-processing-eligibility';

export const customerIntakeContext = (
  principalId: string,
  source: NonNullable<SourceProcessingEligibilityRequest['source']>,
  target: SourceProcessingEligibilityRequest['target'],
  partySourceReference?: SourceProcessingEligibilityRequest['partySourceReference'],
) => {
  const request: SourceProcessingEligibilityRequest = {
    consumerModuleId: SymmyCustomerSourceIntakeConsumerModule,
    operation: SymmyCustomerSourceIntakeOperation,
    source,
    target,
  };
  if (partySourceReference !== undefined) {
    Object.assign(request, { partySourceReference });
  }
  return { authMethod: 'api_key', principalId, request };
};

const jobKey = 'integration.symmy.execute-symmy-job';

export const customerFixtureWorkloads = [
  'integration.symmy-admit',
  'integration.symmy-poll',
  'party.registry.source-write',
  'party.registry.source-read',
  'commerce.customer-context.source-write',
  'commerce.customer-context.source-read',
  'privacy.core.source-processing-check',
] as const;
export const customerWorkerKey = jobKey;
