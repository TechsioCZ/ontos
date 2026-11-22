import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CORE_MEDIA_ASSET_RESOURCE_TYPE,
  CoreMediaOwnerResourceRefSchema,
  CORE_MEDIA_MODULE_ID,
  MediaAssetIdSchema,
  TenantMediaAssetKeySchema,
  mediaAssetRefFor,
  resolveMediaAssetRef,
} from '../../src/media/identity.ts';
import { MediaAssetNotFound, mediaAssetNotFound } from '../../src/media/errors.ts';
import { MediaAssetRefSchema, mediaAssetResourceDescriptor } from '../../src/resources/media-asset.ts';
import { OntosResourceTypeSchema } from '../../src/modules/manifest.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const otherTenantId = '00000000-0000-4000-8000-000000000009';
const mediaAssetId = '00000000-0000-4000-8000-000000000002';
const ref = {
  moduleId: 'core.media',
  resourceId: mediaAssetId,
  resourceType: 'core.media.asset',
  tenantId,
};

const CatalogUuid = Schema.String.check(Schema.isUUID());
const CatalogModuleId = Schema.String.pipe(Schema.brand('CatalogModuleId'));
const CatalogResourceId = CatalogUuid.pipe(Schema.brand('CatalogResourceId'));
const CatalogTenantId = CatalogUuid.pipe(Schema.brand('CatalogTenantId'));
/** The Catalog contract's rule, restated: Core must not import a vertical's private source. */
const CatalogOwnerResourceRefContract = Schema.Struct({
  moduleId: CatalogModuleId,
  resourceId: CatalogResourceId,
  resourceType: Schema.String,
  tenantId: CatalogTenantId,
}).check(
  Schema.makeFilter(({ moduleId, resourceType }) =>
    resourceType.startsWith(`${moduleId}.`) ? undefined : 'Resource type must be qualified by its owner',
  ),
);

it('accepts exactly the owner-qualified Core Media Asset ref and round-trips it', () => {
  const decoded = Schema.decodeUnknownSync(MediaAssetRefSchema)(ref);
  expect(Schema.encodeSync(MediaAssetRefSchema)(decoded)).toEqual(ref);
  expect(CORE_MEDIA_MODULE_ID).toBe(ref.moduleId);
  expect(CORE_MEDIA_ASSET_RESOURCE_TYPE).toBe(ref.resourceType);
  expect(CORE_MEDIA_ASSET_RESOURCE_TYPE.startsWith(`${CORE_MEDIA_MODULE_ID}.`)).toBe(true);
});

it('rejects a ref of another module, another resource type prefix, a malformed id or extra identity fields', () => {
  for (const invalid of [
    { ...ref, moduleId: 'core.identity' },
    { ...ref, moduleId: 'catalog' },
    { ...ref, resourceType: 'core.identity.legal-entity' },
    { ...ref, resourceType: 'core.media' },
    { ...ref, resourceType: 'core.mediaasset' },
    { ...ref, resourceType: 'catalog.media.asset' },
    { ...ref, resourceId: 'not-a-uuid' },
    { ...ref, resourceId: `${mediaAssetId} ` },
    { ...ref, resourceId: 'file.png' },
    { ...ref, tenantId: 'not-a-uuid' },
    Object.fromEntries(Object.entries(ref).filter(([field]) => field !== 'tenantId')),
  ]) {
    expect(Exit.isFailure(Schema.decodeUnknownExit(MediaAssetRefSchema)(invalid))).toBe(true);
  }
});

it('decodes a tenant-qualified key and refuses a malformed asset id', () => {
  expect(Schema.decodeUnknownSync(TenantMediaAssetKeySchema)({ mediaAssetId, tenantId })).toEqual({
    mediaAssetId,
    tenantId,
  });
  expect(() => Schema.decodeUnknownSync(MediaAssetIdSchema)('00000000-0000-4000-8000-00000000000z')).toThrow();
  expect(() => Schema.decodeUnknownSync(TenantMediaAssetKeySchema)({ mediaAssetId })).toThrow();
});

it('builds the ref from the trusted key and describes it as a non-attachable Core resource', () => {
  const key = Schema.decodeUnknownSync(TenantMediaAssetKeySchema)({ mediaAssetId, tenantId });
  expect(mediaAssetRefFor(key)).toEqual(ref);
  const descriptor = Schema.decodeUnknownSync(OntosResourceTypeSchema)(mediaAssetResourceDescriptor);
  expect(descriptor.key.startsWith(`${descriptor.owningModuleId}.`)).toBe(true);
  expect(descriptor.key).toBe(ref.resourceType);
  expect(Object.values(descriptor.capabilities)).toEqual([false, false, false, false, false]);
});

const decodedRef = Schema.decodeUnknownSync(MediaAssetRefSchema)(ref);

it.effect(
  'resolves a same-tenant ref to its asset id and treats a foreign-tenant ref exactly like a missing asset',
  () =>
    Effect.gen(function* resolvesRef() {
      expect(yield* resolveMediaAssetRef(decodedRef, tenantId)).toBe(mediaAssetId);
      const foreign = yield* Effect.flip(resolveMediaAssetRef(decodedRef, otherTenantId));
      expect(foreign).toEqual(mediaAssetNotFound());
      expect(Schema.is(MediaAssetNotFound)(foreign)).toBe(true);
    }),
);

it('maps the Core ref to the Catalog owner-ref shape and back without widening either', () => {
  const key = Schema.decodeUnknownSync(TenantMediaAssetKeySchema)({ mediaAssetId, tenantId });
  const owner = mediaAssetRefFor(key);
  expect(owner).toEqual(ref);
  expect(Schema.decodeUnknownSync(CoreMediaOwnerResourceRefSchema)(owner)).toEqual(owner);
  expect(Schema.decodeUnknownSync(MediaAssetRefSchema)(owner)).toEqual(ref);
  expect(Schema.is(CatalogOwnerResourceRefContract)(owner)).toBe(true);
  // A Catalog-shaped ref that is not a Core Media Asset never becomes a Core ref.
  expect(Exit.isFailure(Schema.decodeUnknownExit(MediaAssetRefSchema)({ ...owner, moduleId: 'files.center' }))).toBe(
    true,
  );
});
