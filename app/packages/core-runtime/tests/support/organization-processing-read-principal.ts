import { Schema } from 'effect';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  RegisteredGatewayWorkloadSchema,
  trustVerifiedGatewayPrincipalContext,
} from '../../src/auth/system-principal-context-provenance.ts';

/** Core infrastructure fixture only; actual owner tokens are issued after independent native delivery and binding proof. */
export const organizationProcessingReadPrincipal = (requestHash: string, restricted = true) => {
  const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:organization-processing:run:60000000-0000-4000-8000-000000000002',
    authMethod: 'system',
    principalId: '00000000-0000-4000-8000-000000000003',
    tenantId: '00000000-0000-4000-8000-000000000001',
  });
  const common = {
    admissionInvocationId: '60000000-0000-4000-8000-000000000002',
    bindingIncarnation: '60000000-0000-4000-8000-000000000003',
    claimId: 'actual-processing-claim',
    declarationKey: 'integration.symmy.symmy-source-organization-facts.read',
    entrypointKey: 'integration.symmy.api.symmy-source-organization-facts',
    jobKey: 'organization-processing',
    legalEntityId: '00000000-0000-4000-8000-000000000002',
    legalEntityScope: 'required',
    originalOwnerBindingIncarnation: '60000000-0000-4000-8000-000000000006',
    originalPrincipalId: '40000000-0000-4000-8000-000000000002',
    originalWorkloadBindingIncarnation: '60000000-0000-4000-8000-000000000005',
    originalWorkloadKey: 'integration.source-admit',
    runReference: '60000000-0000-4000-8000-000000000002',
    schemaVersion: '1',
    sourceAppId: 'source-import',
    sourceBuildMarker: 'source-build',
    sourceMode: 'worker',
    workerKey: 'integration.source-worker',
    workerModuleKey: 'integration.source',
    workloadKey: 'integration.symmy.source-organization-facts.read',
  };
  const metadata = Schema.decodeUnknownSync(RegisteredGatewayWorkloadSchema)(
    restricted ? { ...common, organizationProcessingRead: { requestHash } } : common,
  );
  return trustVerifiedGatewayPrincipalContext(principal, 'a'.repeat(64), undefined, undefined, metadata);
};
