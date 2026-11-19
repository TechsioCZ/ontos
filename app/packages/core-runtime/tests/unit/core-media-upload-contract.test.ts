import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ConfirmAssetPayloadSchema,
  ConfirmAssetResultSchema,
  MediaDisplayFilenameSchema,
  UploadAssetPayloadSchema,
  UploadAssetResultSchema,
} from '../../src/media/upload-contract.ts';

/*
 * The public shapes of the two short upload Actions. The size and SHA-256 are required here by a proposed
 * default; every assertion about them sits in one block so relaxing the default changes one place.
 */

const sha = 'a'.repeat(64);
const tenantId = '00000000-0000-4000-8000-000000000001';
const mediaAssetId = '00000000-0000-4000-8000-0000000000a1';
const validPayload = {
  declaredByteSize: 11,
  declaredContentSha256: sha,
  displayFilename: 'Brochure.pdf',
  ingestionSource: 'user',
  mimeType: 'application/pdf',
} as const;

const decodePayload = Schema.decodeUnknownSync(UploadAssetPayloadSchema);

it('accepts the minimal upload reservation and every provenance value alike', () => {
  for (const ingestionSource of ['user', 'system', 'integration', 'import'] as const) {
    expect(decodePayload({ ...validPayload, ingestionSource }).ingestionSource).toBe(ingestionSource);
  }
  expect(decodePayload(validPayload).displayFilename).toBe('Brochure.pdf');
});

it('keeps the original name and the external source reference optional and never invents them', () => {
  const decoded = decodePayload(validPayload);
  expect(decoded.originalFilename).toBeUndefined();
  expect(decoded.externalSourceRef).toBeUndefined();
  const withOrigin = decodePayload({
    ...validPayload,
    externalSourceRef: 'import-batch-7/row-3',
    originalFilename: 'camera-001.jpg',
  });
  expect(withOrigin.originalFilename).toBe('camera-001.jpg');
  expect(withOrigin.externalSourceRef).toBe('import-batch-7/row-3');
});

it('does not introduce a MIME allowlist: any recorded type, however unusual, is accepted', () => {
  for (const mimeType of ['application/pdf', 'application/x-unknown-binary', 'text/x-log; charset=utf-8', 'x/y']) {
    expect(decodePayload({ ...validPayload, mimeType }).mimeType).toBe(mimeType);
  }
  expect(() => decodePayload({ ...validPayload, mimeType: '' })).toThrow();
  expect(() => decodePayload({ ...validPayload, mimeType: 'text/plain\u0000' })).toThrow();
});

it('does not introduce a size cap: a zero-byte file and a very large safe integer are both well-formed', () => {
  expect(decodePayload({ ...validPayload, declaredByteSize: 0 }).declaredByteSize).toBe(0);
  expect(decodePayload({ ...validPayload, declaredByteSize: Number.MAX_SAFE_INTEGER }).declaredByteSize).toBe(
    Number.MAX_SAFE_INTEGER,
  );
});

it('rejects the unusable ingestion sources, sizes and digests structurally', () => {
  expect(() => decodePayload({ ...validPayload, ingestionSource: 'scanner' })).toThrow();
  expect(() => decodePayload({ ...validPayload, declaredByteSize: -1 })).toThrow();
  expect(() => decodePayload({ ...validPayload, declaredByteSize: 1.5 })).toThrow();
  expect(() => decodePayload({ ...validPayload, declaredByteSize: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  expect(() => decodePayload({ ...validPayload, declaredContentSha256: 'A'.repeat(64) })).toThrow();
  expect(() => decodePayload({ ...validPayload, declaredContentSha256: 'a'.repeat(63) })).toThrow();
});

it('requires the displayFilename and keeps it a safe presentation name', () => {
  const decodeName = Schema.decodeUnknownSync(MediaDisplayFilenameSchema);
  for (const safe of ['manual.pdf', 'Faktura 2026 (final).pdf', 'příloha č. 1.docx', 'no-extension', '.hidden']) {
    expect(decodeName(safe)).toBe(safe);
  }
  for (const unsafe of [
    '',
    '   ',
    '.',
    '..',
    'a/b.pdf',
    String.raw`a\b.pdf`,
    '../etc/passwd',
    'name\u0000.pdf',
    'name\n.pdf',
    'name\u007F.pdf',
    'invoice‮fdp.exe',
    '​',
    `a${String.fromCodePoint(8232)}b`,
    '﻿.pdf',
  ]) {
    expect(() => decodeName(unsafe)).toThrow();
  }
  const { displayFilename: _omitted, ...withoutName } = validPayload;
  expect(() => decodePayload(withoutName)).toThrow();
});

it('keeps an honest original name free of control characters but never forces a display-style rewrite', () => {
  expect(decodePayload({ ...validPayload, originalFilename: 'scan (1).PDF' }).originalFilename).toBe('scan (1).PDF');
  expect(() => decodePayload({ ...validPayload, originalFilename: 'a\u0000b' })).toThrow();
  expect(() => decodePayload({ ...validPayload, originalFilename: '' })).toThrow();
});

it('carries no tenant, scope or principal field a caller could choose', () => {
  const fields = Object.keys(UploadAssetPayloadSchema.fields);
  for (const forbidden of [
    'tenantId',
    'legalEntityId',
    'principalId',
    'storageKey',
    'storageProvider',
    'mediaAssetId',
  ]) {
    expect(fields).not.toContain(forbidden);
  }
  // A reservation names no business target either: it creates no link and no assignment.
  for (const forbidden of ['productId', 'targetResourceId', 'resourceRef', 'revision', 'revisionId']) {
    expect(fields).not.toContain(forbidden);
  }
});

it('answers a reservation with the asset ref and the honest uploaded status, never a usable success', () => {
  const result = Schema.decodeUnknownSync(UploadAssetResultSchema)({
    mediaAssetRef: { moduleId: 'core.media', resourceId: mediaAssetId, resourceType: 'core.media.asset', tenantId },
    processingStatus: 'uploaded',
  });
  expect(result.processingStatus).toBe('uploaded');
  expect(() => Schema.decodeUnknownSync(UploadAssetResultSchema)({ ...result, processingStatus: 'ready' })).toThrow();
});

it('confirms by the owner-qualified ref alone and reports success only at ready', () => {
  const ref = { moduleId: 'core.media', resourceId: mediaAssetId, resourceType: 'core.media.asset', tenantId };
  expect(Object.keys(ConfirmAssetPayloadSchema.fields)).toEqual(['mediaAssetRef']);
  expect(Schema.decodeUnknownSync(ConfirmAssetPayloadSchema)({ mediaAssetRef: ref }).mediaAssetRef.resourceId).toBe(
    mediaAssetId,
  );
  expect(() =>
    Schema.decodeUnknownSync(ConfirmAssetPayloadSchema)({
      mediaAssetRef: { ...ref, moduleId: 'catalog.documents' },
    }),
  ).toThrow();
  const ready = { byteSize: 11, contentSha256: sha, mediaAssetRef: ref, processingStatus: 'ready' };
  expect(Schema.decodeUnknownSync(ConfirmAssetResultSchema)(ready).processingStatus).toBe('ready');
  for (const status of ['uploaded', 'scanning', 'failed']) {
    expect(() => Schema.decodeUnknownSync(ConfirmAssetResultSchema)({ ...ready, processingStatus: status })).toThrow();
  }
});
