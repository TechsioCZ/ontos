import { Schema } from 'effect';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';

interface RegisteredGatewayRecoveryFixtureInput {
  readonly declarationKey: string;
  readonly entrypointKey: string;
  readonly originalPrincipalId?: string;
  readonly principalId: string;
  readonly requestHash: string;
  readonly tenantId: string;
  readonly workloadKey: string;
}

/** Core unit-test fixture: historical receipt authority intentionally carries no live original bindings. */
export const registeredGatewayRecoveryPrincipal = (input: RegisteredGatewayRecoveryFixtureInput) => {
  const runReference = '60000000-0000-4000-8000-000000000002';
  const authContextRef = `job:receipt-recovery:run:${runReference}`;
  const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef,
    authMethod: 'system',
    principalId: input.principalId,
    tenantId: input.tenantId,
  });
  return trustVerifiedGatewayPrincipalContext(principal, 'a'.repeat(64), undefined, undefined, {
    admissionInvocationId: runReference,
    bindingIncarnation: '60000000-0000-4000-8000-000000000003',
    claimId: 'native-current-recovery-claim',
    declarationKey: input.declarationKey,
    entrypointKey: input.entrypointKey,
    jobKey: 'receipt-recovery',
    legalEntityScope: 'forbidden',
    originalPrincipalId: '40000000-0000-4000-8000-000000000002',
    recovery: {
      originalActionInvocationId: '60000000-0000-4000-8000-000000000004',
      originalActionKey: 'owner.source.apply',
      originalAuthContextRef: authContextRef,
      originalIdempotencyKey: 'exact-permanent-owner-command',
      originalPrincipalId: input.originalPrincipalId ?? input.principalId,
      originalRequestHash: 'b'.repeat(64),
      requestHash: input.requestHash,
    },
    runReference,
    schemaVersion: '1',
    sourceAppId: 'source-import',
    sourceBuildMarker: 'source-build',
    sourceMode: 'worker',
    workerKey: 'integration.source-worker',
    workerModuleKey: 'integration.source',
    workloadKey: input.workloadKey,
  });
};
