import { DateTime, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { MediaUnavailable } from '../../src/media/errors.ts';
import {
  MediaAssetMetadataSchema,
  MediaProcessingStatusSchema,
  canTransitionMediaStatus,
  mediaStatusesThatMayEnter,
  toMediaAssetMetadata,
} from '../../src/media/public-contract.ts';
import { TenantMediaAssetKeySchema } from '../../src/media/identity.ts';

const key = Schema.decodeUnknownSync(TenantMediaAssetKeySchema)({
  mediaAssetId: '00000000-0000-4000-8000-000000000002',
  tenantId: '00000000-0000-4000-8000-000000000001',
});
const digest = 'a'.repeat(64);
const source = {
  ...key,
  byteSize: 1234n,
  contentSha256: digest,
  displayFilename: 'Brochure.pdf',
  ingestionSource: 'user',
  mimeType: 'application/pdf',
  originalFilename: 'brochure-final.pdf',
  processingStatus: 'ready',
  sealedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-19T10:00:00.000Z')),
  // Persisted columns that must never leave Core.
  storageKey: 'core-media/v1/secret-key',
  storageObjectVersionRef: 'provider-version-9',
  storageProvider: 'provider-x',
};

const FORBIDDEN_PUBLIC_FIELDS = [
  'storageProvider',
  'storageKey',
  'storageObjectVersionRef',
  'credentials',
  'url',
  'revision',
  'revisionId',
  'version',
] as const;

it('never lets a storage, credential, URL or revision field into the public metadata schema', () => {
  for (const field of FORBIDDEN_PUBLIC_FIELDS) {
    expect(Object.keys(MediaAssetMetadataSchema.fields)).not.toContain(field);
  }
});

it.effect('projects a ready asset without any storage value, as the owner-qualified ref plus plain metadata', () =>
  Effect.gen(function* readyProjection() {
    const metadata = yield* toMediaAssetMetadata(source);
    expect(metadata).toEqual({
      byteSize: 1234,
      contentSha256: digest,
      displayFilename: 'Brochure.pdf',
      ingestionSource: 'user',
      mediaAssetRef: {
        moduleId: 'core.media',
        resourceId: key.mediaAssetId,
        resourceType: 'core.media.asset',
        tenantId: key.tenantId,
      },
      mimeType: 'application/pdf',
      originalFilename: 'brochure-final.pdf',
      processingStatus: 'ready',
    });
    const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(MediaAssetMetadataSchema))(metadata);
    for (const secret of ['secret-key', 'provider-version-9', 'provider-x', 'storage']) {
      expect(serialized).not.toContain(secret);
    }
  }),
);

it.effect('withholds an unsealed digest and an absent original file name', () =>
  Effect.gen(function* unsealed() {
    const metadata = yield* toMediaAssetMetadata({
      ...source,
      originalFilename: null,
      processingStatus: 'uploaded',
      sealedAt: null,
    });
    expect(metadata).not.toHaveProperty('contentSha256');
    expect(metadata).not.toHaveProperty('originalFilename');
    expect(metadata.processingStatus).toBe('uploaded');
  }),
);

it.effect('fails closed on a status or source outside the public vocabulary', () =>
  Effect.gen(function* outside() {
    for (const broken of [{ processingStatus: 'archived' }, { ingestionSource: 'scraper' }, { byteSize: -1n }]) {
      const exit = yield* Effect.exit(toMediaAssetMetadata({ ...source, ...broken }));
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some((reason) => 'error' in reason && Schema.is(MediaUnavailable)(reason.error)),
      ).toBe(true);
    }
  }),
);

it('lets a status move only forward and never regress from ready or failed', () => {
  const statuses = MediaProcessingStatusSchema.literals;
  const allowed = statuses.flatMap((from) =>
    statuses.filter((to) => canTransitionMediaStatus(from, to)).map((to) => `${from}->${to}`),
  );
  expect(allowed.toSorted()).toEqual([
    'scanning->failed',
    'scanning->ready',
    'uploaded->failed',
    'uploaded->ready',
    'uploaded->scanning',
  ]);
  expect(canTransitionMediaStatus('ready', 'uploaded')).toBe(false);
  expect(canTransitionMediaStatus('ready', 'ready')).toBe(false);
  expect(mediaStatusesThatMayEnter('ready')).toEqual(['uploaded', 'scanning']);
  expect(mediaStatusesThatMayEnter('uploaded')).toEqual([]);
});
