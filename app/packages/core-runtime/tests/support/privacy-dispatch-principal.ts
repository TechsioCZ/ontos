import { Schema } from 'effect';
import type { TrustedPrincipalContext } from '../../src/actions/principal-context.ts';
import {
  RegisteredGatewayPrivacyDispatchSchema,
  trustVerifiedGatewayPrincipalContext,
} from '../../src/auth/system-principal-context-provenance.ts';
import type { PrivacyDispatchOperation } from '../../src/auth/system-principal-context-provenance.ts';

/** Core infrastructure fixture: production receives these claims only after official verification/redemption. */
export const privacyDispatchPrincipal = (
  principal: TrustedPrincipalContext,
  operation: PrivacyDispatchOperation,
  requestHash: string,
) => {
  if (principal.legalEntityId === undefined) {
    throw new Error('The finite Privacy dispatch fixture requires actual governance scope');
  }
  return trustVerifiedGatewayPrincipalContext(
    principal,
    'a'.repeat(64),
    undefined,
    {
      appId: 'symmy-integration',
      buildMarker: 'symmy-fixture-build',
      principalId: '00000000-0000-4000-8000-000000000010',
    },
    undefined,
    undefined,
    Schema.decodeSync(RegisteredGatewayPrivacyDispatchSchema)({
      claimId: 'privacy-dispatch-native-claim',
      deliveryId: '00000000-0000-4000-8000-000000000011',
      dispatchInvocationId: '00000000-0000-4000-8000-000000000012',
      domainEventId: '00000000-0000-4000-8000-000000000013',
      governanceLegalEntityId: principal.legalEntityId,
      handoffHash: 'b'.repeat(64),
      measureId: 'privacy.core.measure-fixture',
      messageId: '00000000-0000-4000-8000-000000000014',
      operation,
      principalId: principal.principalId,
      requestHash,
      sourceMode: 'worker',
      taskId: 'privacy.core.task-fixture',
      tenantId: principal.tenantId,
      workerKey: 'integration.symmy.symmy-job-privacy-dispatch',
      workerModuleKey: 'integration.symmy',
    }),
  );
};
