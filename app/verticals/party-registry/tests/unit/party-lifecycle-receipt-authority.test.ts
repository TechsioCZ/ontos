import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import {
  RegisteredGatewayWorkloadSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { partyLifecycleReceiptMatches } from '../../src/services/party-source-lifecycle.service.ts';

it('admits a different receipt reader only for the sealed original write and never for write replay', () => {
  const id = (n: number) => `ad130000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const principal = {
    ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authMethod: 'system',
      authContextRef: 'job:receipt:run:unit',
      tenantId: id(1),
      principalId: id(2),
    }),
    correlationId: 'receipt',
  };
  const receipt = {
    actionInvocationId: id(3),
    principalId: id(4),
    requestHash: 'd'.repeat(64),
    operation: 'ADD_CONTACT_POINT',
    partyId: id(5),
    legalEntityId: null,
  };
  const workload = Schema.decodeUnknownSync(RegisteredGatewayWorkloadSchema)({
    admissionInvocationId: id(6),
    bindingIncarnation: id(7),
    declarationKey: 'party.registry.party-source-effect-receipt.read',
    entrypointKey: 'party.registry.api.party-source-effect-receipt',
    jobKey: 'integration.symmy.execute-symmy-job',
    legalEntityScope: 'forbidden',
    originalPrincipalId: id(8),
    runReference: id(9),
    schemaVersion: '1',
    sourceAppId: 'symmy-integration',
    sourceBuildMarker: 'test',
    sourceMode: 'worker',
    workloadKey: 'party.registry.source-read',
    recovery: {
      originalActionInvocationId: receipt.actionInvocationId,
      originalActionKey: 'party.registry.add-contact-point',
      originalAuthContextRef: 'job:write:run:unit',
      originalIdempotencyKey: 'effect',
      originalPrincipalId: receipt.principalId,
      originalRequestHash: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
    },
  });
  const verified = trustVerifiedGatewayPrincipalContext(principal, 'c'.repeat(64), undefined, undefined, workload);
  const matches = (row: typeof receipt, scope: typeof principal, mode: 'RECOVER' | 'WRITE' = 'RECOVER') =>
    partyLifecycleReceiptMatches(row, scope, 'ADD_CONTACT_POINT', receipt.requestHash, receipt.partyId, mode);
  expect(matches(receipt, verified)).toBe(true);
  expect(matches({ ...receipt, actionInvocationId: id(10) }, verified)).toBe(false);
  expect(matches({ ...receipt, principalId: verified.principalId }, verified)).toBe(false);
  expect(matches({ ...receipt, requestHash: 'e'.repeat(64) }, verified)).toBe(false);
  expect(matches(receipt, verified, 'WRITE')).toBe(false);
  const unsealed = {
    ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)(principal),
    correlationId: 'receipt',
    workload,
  };
  expect(matches(receipt, unsealed)).toBe(false);
});
