import { describe, expect, it } from 'effect-rstest';

import { admitsWorkloadKey } from '../../api/auth/platform-workload-key-admission.ts';
import { PLATFORM_KEY_OWNER } from '../../api/auth/platform-key-owner.ts';

const input = {
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  providerKeyId: 'provider-key-1',
  tenantId: '10000000-0000-4000-8000-000000000001',
};
const release = { buildMarkers: { crm: 'crm-build-1' }, compositionRevision: 'a'.repeat(64) };
const attestation = JSON.stringify({
  appId: 'crm',
  bootId: '50000000-0000-4000-8000-000000000001',
  buildMarker: 'crm-build-1',
  compositionRevision: 'a'.repeat(64),
  hostId: 'host-1',
  legalEntityId: input.legalEntityId,
  ontosModuleCredential: 'workload_attested_v2',
  principalId: input.principalId,
  tenantId: input.tenantId,
  workloadKey: 'crm.client-onboarding',
});

describe('workload key admission', () => {
  it('admits the key the platform key owner holds with an attestation for this principal and release', () => {
    expect(admitsWorkloadKey({ metadata: attestation, referenceId: PLATFORM_KEY_OWNER.id }, input, release)).toBe(true);
  });

  it('refuses a key carrying a copied attestation when another provider user owns it', () => {
    expect(admitsWorkloadKey({ metadata: attestation, referenceId: 'tenant-admin-user' }, input, release)).toBe(false);
  });

  it('refuses a missing key, a key without an attestation, and an attestation for another release or build', () => {
    expect(admitsWorkloadKey(undefined, input, release)).toBe(false);
    expect(admitsWorkloadKey({ metadata: null, referenceId: PLATFORM_KEY_OWNER.id }, input, release)).toBe(false);
    expect(
      admitsWorkloadKey({ metadata: attestation, referenceId: PLATFORM_KEY_OWNER.id }, input, {
        ...release,
        compositionRevision: 'b'.repeat(64),
      }),
    ).toBe(false);
    expect(
      admitsWorkloadKey({ metadata: attestation, referenceId: PLATFORM_KEY_OWNER.id }, input, {
        ...release,
        buildMarkers: { crm: 'crm-build-2' },
      }),
    ).toBe(false);
  });

  it('refuses an attestation for another principal, tenant or company', () => {
    const record = { metadata: attestation, referenceId: PLATFORM_KEY_OWNER.id };
    expect(admitsWorkloadKey(record, { ...input, principalId: '20000000-0000-4000-8000-000000000002' }, release)).toBe(
      false,
    );
    expect(admitsWorkloadKey(record, { ...input, tenantId: '10000000-0000-4000-8000-000000000002' }, release)).toBe(
      false,
    );
    expect(
      admitsWorkloadKey(record, { ...input, legalEntityId: '30000000-0000-4000-8000-000000000002' }, release),
    ).toBe(false);
  });
});
