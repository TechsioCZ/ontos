import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ModuleCredentialAttestationSchema,
  supersededByHolder,
  WorkloadCredentialAttestationSchema,
} from '../../api/auth/module-credential-attestation.ts';

const HOLDER_REVISION = 'a'.repeat(64);
const OLDER_REVISION = 'b'.repeat(64);
const SERVING_BOOT = '70000000-0000-4000-8000-000000000001';
const PEER_BOOT = '70000000-0000-4000-8000-000000000002';
const DEAD_BOOT = '70000000-0000-4000-8000-000000000003';
const cutoff = new Date('2026-11-15T10:00:00Z');
const beforeCutoff = new Date('2026-11-15T09:59:00Z');
const afterCutoff = new Date('2026-11-15T10:01:00Z');

const moduleAttestation = (compositionRevision: string, bootId: string) =>
  Option.some(
    Schema.decodeSync(ModuleCredentialAttestationSchema)({
      appId: 'commerce-order',
      bootId,
      buildMarker: 'order-build',
      compositionRevision,
      hostId: 'app-278',
      ontosModuleCredential: 'attested_v2',
    }),
  );
const workloadAttestation = (compositionRevision: string, bootId: string) =>
  Option.some(
    Schema.decodeSync(WorkloadCredentialAttestationSchema)({
      appId: 'commerce-order',
      bootId,
      buildMarker: 'order-build',
      compositionRevision,
      hostId: 'app-278',
      legalEntityId: '70000000-0000-4000-8000-000000000021',
      ontosModuleCredential: 'workload_attested_v2',
      principalId: '70000000-0000-4000-8000-000000000031',
      tenantId: '70000000-0000-4000-8000-000000000011',
      workloadKey: 'demo.order.intake',
    }),
  );
const bothKinds = (compositionRevision: string, bootId: string) => [
  moduleAttestation(compositionRevision, bootId),
  workloadAttestation(compositionRevision, bootId),
];
const holderWith = (current: readonly string[], liveBoots: readonly string[]) => ({
  current: new Set(current),
  cutoff,
  liveBoots: new Set(liveBoots),
  revision: HOLDER_REVISION,
});

describe('which platform keys the authority holder supersedes', () => {
  it('keeps the keys of a running container of the same release when a peer of that release boots', () => {
    // The serving container issued its keys before it published, so they were bound before the cutoff; the peer that
    // booted later and renewed the same revision runs the retirement, holding only its own keys.
    const peer = holderWith(['peer-key'], [SERVING_BOOT, PEER_BOOT]);
    for (const attestation of bothKinds(HOLDER_REVISION, SERVING_BOOT)) {
      expect(supersededByHolder({ attestation, boundAt: beforeCutoff, providerKeyId: 'serving-key' }, peer)).toBe(
        false,
      );
    }
  });

  it('retires the keys of an older release once the new release holds the authority, even while that host runs', () => {
    const holder = holderWith(['new-key'], [SERVING_BOOT, PEER_BOOT]);
    for (const attestation of [...bothKinds(OLDER_REVISION, SERVING_BOOT), Option.none()]) {
      expect(supersededByHolder({ attestation, boundAt: beforeCutoff, providerKeyId: 'old-key' }, holder)).toBe(true);
    }
  });

  it('retires the keys of a dead container of the same release, whenever they were bound', () => {
    const holder = holderWith(['serving-key'], [SERVING_BOOT]);
    for (const boundAt of [beforeCutoff, afterCutoff]) {
      for (const attestation of bothKinds(HOLDER_REVISION, DEAD_BOOT)) {
        expect(supersededByHolder({ attestation, boundAt, providerKeyId: 'dead-key' }, holder)).toBe(true);
      }
    }
  });

  it('keeps both containers of a release that boot at once, whichever retires first', () => {
    const both = [SERVING_BOOT, PEER_BOOT];
    const fromServing = holderWith(['serving-key'], both);
    const fromPeer = holderWith(['peer-key'], both);
    for (const boundAt of [beforeCutoff, afterCutoff]) {
      for (const attestation of bothKinds(HOLDER_REVISION, PEER_BOOT)) {
        expect(supersededByHolder({ attestation, boundAt, providerKeyId: 'peer-key' }, fromServing)).toBe(false);
      }
      for (const attestation of bothKinds(HOLDER_REVISION, SERVING_BOOT)) {
        expect(supersededByHolder({ attestation, boundAt, providerKeyId: 'serving-key' }, fromPeer)).toBe(false);
      }
    }
  });

  it('leaves keys of another revision or none bound after the cutoff, and every key the retiring host holds', () => {
    const holder = holderWith(['held-key'], []);
    for (const attestation of [...bothKinds(OLDER_REVISION, DEAD_BOOT), Option.none()]) {
      expect(supersededByHolder({ attestation, boundAt: afterCutoff, providerKeyId: 'late-key' }, holder)).toBe(false);
    }
    for (const attestation of [...bothKinds(HOLDER_REVISION, DEAD_BOOT), Option.none()]) {
      expect(supersededByHolder({ attestation, boundAt: beforeCutoff, providerKeyId: 'held-key' }, holder)).toBe(false);
    }
  });
});
