import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AssetCurrentRequestSchema,
  AssetCurrentResponseSchema,
  MEDIA_CURRENT_REVISION,
  currentEntryOf,
} from '../../src/media/current-contract.ts';
import { MediaByteSizeSchema } from '../../src/media/public-contract.ts';
import { assetCurrentRead } from '../../src/generated-reads/asset-current.ts';
import { coreOperations } from '../../src/sdk/core-operations.ts';
import { mediaAssetRefFor, TenantMediaAssetKeySchema } from '../../src/media/identity.ts';
import type { MediaStatOutcome } from '../../src/media/verified-read.ts';

/*
 * Current V1 (#1443, ADR-0031) as the owner contract Catalog consumes: exactly one answer per requested ref, the
 * five-state vocabulary of `CatalogDocumentAvailability` (FORBIDDEN is the whole-call denial of the governed Read,
 * never an entry), and `revision` the constant 1 only for a stat-confirmed ready asset. There is no version table,
 * no pointer, no `revisionId` and never a provider version reference.
 */

const key = Schema.decodeUnknownSync(TenantMediaAssetKeySchema)({
  mediaAssetId: '00000000-0000-4000-8000-0000000000a1',
  tenantId: '00000000-0000-4000-8000-000000000001',
});
const ref = mediaAssetRefFor(key);
const present: MediaStatOutcome = { byteSize: Schema.decodeUnknownSync(MediaByteSizeSchema)(12), outcome: 'present' };
const verdictOf = (outcome: MediaStatOutcome) => currentEntryOf(ref, outcome).kind;

it('is revision 1 for a confirmed asset and carries no revisionId', () => {
  const entry = currentEntryOf(ref, present);
  expect(entry).toEqual({ current: { resourceRef: ref, revision: 1 }, kind: 'AVAILABLE', resourceRef: ref });
  expect(MEDIA_CURRENT_REVISION).toBe(1);
  expect(JSON.stringify(entry)).not.toContain('revisionId');
});

it('answers an asset that does not exist in the tenant as ABSENT, with no revision', () => {
  expect(currentEntryOf(ref, 'absent')).toEqual({ kind: 'ABSENT', resourceRef: ref });
});

it('judges a stat: only a present object confirms, an outage is unavailable, everything else unverified', () => {
  expect(verdictOf(present)).toBe('AVAILABLE');
  expect(verdictOf({ outcome: 'unavailable', reason: 'provider_failure' })).toBe('UNAVAILABLE');
  expect(verdictOf({ outcome: 'unavailable', reason: 'provider_mismatch' })).toBe('UNAVAILABLE');
  expect(verdictOf({ outcome: 'missing_object' })).toBe('CURRENT_UNVERIFIED');
  expect(verdictOf({ outcome: 'inconsistent_metadata', reason: 'not_ready' })).toBe('CURRENT_UNVERIFIED');
  expect(verdictOf({ outcome: 'inconsistent_metadata', reason: 'object_replaced' })).toBe('CURRENT_UNVERIFIED');
});

it('accepts only owner-qualified Core Media refs in a non-empty request, without any per-set bound', () => {
  const decode = Schema.decodeUnknownSync(AssetCurrentRequestSchema);
  expect(decode({ mediaAssetRefs: [ref] }).mediaAssetRefs).toHaveLength(1);
  expect(decode({ mediaAssetRefs: Array.from({ length: 500 }, () => ref) }).mediaAssetRefs).toHaveLength(500);
  expect(() => decode({ mediaAssetRefs: [] })).toThrow();
  expect(() => decode({ mediaAssetRefs: [{ ...ref, moduleId: 'commerce.catalog' }] })).toThrow();
  expect(() => decode({ mediaAssetRefs: [{ ...ref, resourceType: 'core.media.link' }] })).toThrow();
  expect(() => decode({ mediaAssetRefs: [{ ...ref, resourceId: 'not-a-uuid' }] })).toThrow();
});

it('refuses a response whose AVAILABLE entry names another ref, a revision other than 1 or a revisionId', () => {
  const decode = Schema.decodeUnknownSync(AssetCurrentResponseSchema, { onExcessProperty: 'error' });
  const other = { ...ref, resourceId: '00000000-0000-4000-8000-0000000000b2' };
  expect(decode({ entries: [currentEntryOf(ref, present)] }).entries).toHaveLength(1);
  expect(() =>
    decode({ entries: [{ current: { resourceRef: other, revision: 1 }, kind: 'AVAILABLE', resourceRef: ref }] }),
  ).toThrow();
  expect(() =>
    decode({ entries: [{ current: { resourceRef: ref, revision: 2 }, kind: 'AVAILABLE', resourceRef: ref }] }),
  ).toThrow();
  expect(() =>
    decode({
      entries: [{ current: { resourceRef: ref, revision: 1, revisionId: 'x' }, kind: 'AVAILABLE', resourceRef: ref }],
    }),
  ).toThrow();
  expect(() => decode({ entries: [{ kind: 'FORBIDDEN', resourceRef: ref }] })).toThrow();
});

it('is published as one Core operation whose provider is exactly the Current read and whose schemas are the contract', () => {
  const { entrypoint, schemaVersion } = assetCurrentRead.descriptor;
  expect(coreOperations.assetCurrent.provider).toEqual({
    entrypointKey: entrypoint.entrypointKey,
    moduleId: 'core.media',
    schemaVersion,
  });
  expect(coreOperations.assetCurrent.request).toBe(AssetCurrentRequestSchema);
  expect(coreOperations.assetCurrent.response).toBe(AssetCurrentResponseSchema);
  expect(coreOperations.assetCurrent.kind).toBe('read');
});
