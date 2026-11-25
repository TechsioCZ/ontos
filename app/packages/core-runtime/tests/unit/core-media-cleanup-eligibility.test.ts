import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { assessTemporaryObjectCleanup } from '../../src/media/cleanup-eligibility.ts';
import type { MediaCleanupAssessmentInput, MediaCleanupFacts } from '../../src/media/cleanup-eligibility.ts';
import { MediaAssetIdSchema, MediaTenantIdSchema } from '../../src/media/identity.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';

/*
 * The cleanup eligibility check decides only whether a future, separately approved procedure may touch one
 * technical object. It deletes nothing. The suite is built around refusals: eligibility needs every condition
 * proven, and any single unproven, present or ambiguous one refuses, so the object stays for reconciliation.
 */

const tenantId = Schema.decodeUnknownSync(MediaTenantIdSchema)('00000000-0000-4000-8000-000000000001');
const mediaAssetId = Schema.decodeUnknownSync(MediaAssetIdSchema)('00000000-0000-4000-8000-0000000000a1');
const storageKey = deriveMediaStorageKey({ mediaAssetId, tenantId });
const target = { mediaAssetId, storageKey, storageProvider: 'p', tenantId };

const noFacts: MediaCleanupFacts = {
  assetStatusesAtStorageIdentity: [],
  assetStatusesById: [],
  evidenceReferenceCount: 0,
  invocationCount: 0,
  linkCount: 0,
};

const input = (overrides: Partial<MediaCleanupAssessmentInput> = {}): MediaCleanupAssessmentInput => ({
  authority: 'verified',
  facts: noFacts,
  providerProtection: 'none_recorded',
  target,
  ...overrides,
});

const refusalsOf = (assessment: ReturnType<typeof assessTemporaryObjectCleanup>) =>
  assessment.eligible ? [] : assessment.refusals;

it('is eligible only when every condition is proven: no intent, no reference, no protection, verified authority', () => {
  expect(assessTemporaryObjectCleanup(input())).toEqual({ eligible: true });
});

it('refuses a confirmed asset, whatever else is true', () => {
  for (const facts of [
    { ...noFacts, assetStatusesAtStorageIdentity: ['ready'], assetStatusesById: ['ready'] },
    { ...noFacts, assetStatusesById: ['ready'] },
    { ...noFacts, assetStatusesAtStorageIdentity: ['ready'] },
  ]) {
    expect(refusalsOf(assessTemporaryObjectCleanup(input({ facts })))).toContain('confirmed_asset');
  }
});

it('refuses every open or uncertain intent: uploaded, scanning, and a status it does not know', () => {
  for (const status of ['uploaded', 'scanning', 'something-new']) {
    const facts = { ...noFacts, assetStatusesById: [status] };
    expect(refusalsOf(assessTemporaryObjectCleanup(input({ facts })))).toEqual(['open_intent']);
  }
});

it('refuses a failed asset, because its bytes are evidence of proven corruption or of a closed intent', () => {
  const facts = { ...noFacts, assetStatusesAtStorageIdentity: ['failed'], assetStatusesById: ['failed'] };
  expect(refusalsOf(assessTemporaryObjectCleanup(input({ facts })))).toEqual(['failed_asset_evidence']);
});

it('refuses an ambiguous storage identity even when each row alone would be harmless', () => {
  const facts = { ...noFacts, assetStatusesAtStorageIdentity: ['failed', 'failed'] };
  expect(refusalsOf(assessTemporaryObjectCleanup(input({ facts })))).toContain('ambiguous_storage_identity');
});

it('refuses a linked asset, an evidence reference and any Action Invocation of the intent', () => {
  expect(refusalsOf(assessTemporaryObjectCleanup(input({ facts: { ...noFacts, linkCount: 1 } })))).toEqual(['linked']);
  expect(refusalsOf(assessTemporaryObjectCleanup(input({ facts: { ...noFacts, evidenceReferenceCount: 2 } })))).toEqual(
    ['evidence_reference'],
  );
  expect(refusalsOf(assessTemporaryObjectCleanup(input({ facts: { ...noFacts, invocationCount: 1 } })))).toEqual([
    'action_invocation_present',
  ]);
});

it('refuses when retention or a hold is recorded, and when its absence is merely unknown', () => {
  for (const providerProtection of ['recorded', 'unknown'] as const) {
    expect(refusalsOf(assessTemporaryObjectCleanup(input({ providerProtection })))).toEqual(['protection_unproven']);
  }
});

it('refuses without verified technical authority', () => {
  expect(refusalsOf(assessTemporaryObjectCleanup(input({ authority: 'absent' })))).toEqual(['authority_unverified']);
});

it('refuses a key that is not the one derived from the named intent, or one of another tenant or asset', () => {
  const otherAsset = Schema.decodeUnknownSync(MediaAssetIdSchema)('00000000-0000-4000-8000-0000000000a2');
  const otherTenant = Schema.decodeUnknownSync(MediaTenantIdSchema)('00000000-0000-4000-8000-000000000002');
  for (const mismatched of [
    { ...target, storageKey: deriveMediaStorageKey({ mediaAssetId: otherAsset, tenantId }) },
    { ...target, storageKey: deriveMediaStorageKey({ mediaAssetId, tenantId: otherTenant }) },
    { ...target, mediaAssetId: otherAsset },
    { ...target, tenantId: otherTenant },
  ]) {
    expect(refusalsOf(assessTemporaryObjectCleanup(input({ target: mismatched })))).toEqual(['target_unverified']);
  }
});

it('reports every refusal that applies, not only the first, and never turns a refusal into eligibility', () => {
  const facts: MediaCleanupFacts = {
    assetStatusesAtStorageIdentity: ['ready'],
    assetStatusesById: ['ready'],
    evidenceReferenceCount: 1,
    invocationCount: 1,
    linkCount: 1,
  };
  const refusals = refusalsOf(
    assessTemporaryObjectCleanup(input({ authority: 'absent', facts, providerProtection: 'unknown' })),
  );
  expect(new Set(refusals)).toEqual(
    new Set([
      'confirmed_asset',
      'linked',
      'evidence_reference',
      'action_invocation_present',
      'protection_unproven',
      'authority_unverified',
    ]),
  );
});
