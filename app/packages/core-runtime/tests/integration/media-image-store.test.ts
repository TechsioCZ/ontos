import { NodeCrypto } from '@effect/platform-node';
import { eq } from 'drizzle-orm';
import { Crypto, Effect, Option, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import { Base64 } from 'effect/encoding';

import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../src/db/database-identities.ts';
import {
  actionInvocations,
  legalEntities,
  mediaAssetRenditions,
  mediaAssets,
  mediaLinks,
  principals,
  tenants,
} from '../../src/db/schema.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import type { ScopedTransactionExecutor } from '../../src/db/scoped-transaction.ts';
import {
  readLinkedMediaRendition,
  relinkMediaToResource,
  storeLinkedMediaImage,
  unlinkMediaFromResource,
} from '../../src/media/media-image-store.ts';
import { MediaUploadRejected } from '../../src/media/media-upload-rejected.ts';
import { purgeFixtureRows } from '../support/fixture-cleanup.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

// The smallest real PNG (1×1 px) and JPEG signatures: Core accepts content by signature, not by name.
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

const sha256 = (bytes: Uint8Array<ArrayBuffer>) =>
  Effect.promise(() => globalThis.crypto.subtle.digest('SHA-256', bytes)).pipe(
    Effect.map((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')),
  );

const mediaFixture = Effect.gen(function* mediaFixtureEffect() {
  const crypto = yield* Crypto.Crypto;
  const tenantId = yield* crypto.randomUUIDv4();
  const legalEntityId = yield* crypto.randomUUIDv4();
  const otherLegalEntityId = yield* crypto.randomUUIDv4();
  const principalId = yield* crypto.randomUUIDv4();
  const actionInvocationId = yield* crypto.randomUUIDv4();
  const configuration = yield* loadDatabaseConfig({ identity: SHARED_RUNTIME_IDENTITY });
  const database = yield* makeCoreDatabase({ ...configuration, maxConnections: 1 });
  const { executor } = database;
  yield* Effect.addFinalizer(() =>
    purgeFixtureRows([
      executor.delete(mediaLinks).where(eq(mediaLinks.tenantId, tenantId)),
      executor.delete(mediaAssetRenditions).where(eq(mediaAssetRenditions.tenantId, tenantId)),
      executor.delete(mediaAssets).where(eq(mediaAssets.tenantId, tenantId)),
      executor.delete(actionInvocations).where(eq(actionInvocations.tenantId, tenantId)),
      executor.delete(principals).where(eq(principals.tenantId, tenantId)),
      executor.delete(legalEntities).where(eq(legalEntities.tenantId, tenantId)),
      executor.delete(tenants).where(eq(tenants.tenantId, tenantId)),
    ]).pipe(Effect.orDie),
  );
  yield* executor
    .insert(tenants)
    .values({ defaultLocale: 'cs', name: 'Media tenant', slug: `media-${tenantId}`, status: 'active', tenantId });
  yield* executor.insert(legalEntities).values(
    [legalEntityId, otherLegalEntityId].map((id, index) => ({
      legalEntityId: id,
      legalName: `Media company ${index}`,
      registrationCountry: 'CZ',
      registrationNumber: `MEDIA-${index}-${tenantId}`,
      status: 'active' as const,
      tenantId,
    })),
  );
  yield* executor
    .insert(principals)
    .values({ displayName: 'Media person', kind: 'human', principalId, status: 'active', tenantId });
  yield* executor.insert(actionInvocations).values({
    actionInvocationId,
    actionKey: 'merchandise.apply-command',
    authMethod: 'session',
    legalEntityId,
    principalId,
    requestHash: 'media-store',
    status: 'received',
    tenantId,
  });
  /** One transaction of the given company with the Action's operational scope installed. */
  const inCompany = <A, E>(company: string, run: (transaction: ScopedTransactionExecutor) => Effect.Effect<A, E>) =>
    executor.transaction((transaction) =>
      installOperationalScope(
        transaction,
        {
          authContextRef: 'better-auth-session:media-store',
          authMethod: 'session',
          correlationId: 'media-store',
          legalEntityId: company,
          principalId,
          tenantId,
        },
        FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      ).pipe(Effect.flatMap(run)),
    );
  return { actionInvocationId, inCompany, legalEntityId, otherLegalEntityId, principalId };
});

const product = { linkKind: 'gallery', moduleKey: 'merchandise', resourceId: 'product-1', resourceType: 'product' };

it.layer(NodeCrypto.layer, { excludeTestServices: true })('Core Media image store', (suite) => {
  suite.effect('stores, serves, unlinks and relinks an uploaded image only for its company and resource', () =>
    Effect.scoped(
      Effect.gen(function* mediaStoreIntegration() {
        const fixture = yield* mediaFixture;
        const mediaAssetId = fixture.actionInvocationId;
        const store = (target = product) =>
          fixture.inCompany(fixture.legalEntityId, (transaction) =>
            storeLinkedMediaImage(transaction, {
              actionInvocationId: fixture.actionInvocationId,
              ingestionSource: 'user',
              mediaAssetId,
              principalId: fixture.principalId,
              target,
              upload: {
                filename: String.raw`C:\fotky\šroub.png`,
                full: { contentBase64: Base64.encode(PNG), height: 1, width: 1 },
                thumbnail: { contentBase64: Base64.encode(JPEG) },
              },
            }),
          );
        const read = (company: string, rendition: 'full' | 'thumbnail', target = product) =>
          fixture.inCompany(company, (transaction) =>
            readLinkedMediaRendition(transaction, { mediaAssetId, rendition, target }),
          );

        const stored = yield* store();
        expect(stored).toEqual({
          byteSize: PNG.byteLength,
          contentSha256: yield* sha256(PNG),
          mediaAssetId,
          mimeType: 'image/png',
        });
        // Storing the same asset again (a seed rerun) links nothing twice and rewrites nothing.
        yield* store();
        const asset = yield* fixture.inCompany(fixture.legalEntityId, (transaction) =>
          transaction
            .select({
              displayFilename: mediaAssets.displayFilename,
              storageKey: mediaAssets.storageKey,
              storageProvider: mediaAssets.storageProvider,
            })
            .from(mediaAssets)
            .where(eq(mediaAssets.mediaAssetId, mediaAssetId)),
        );
        expect(asset).toEqual([
          { displayFilename: 'šroub.png', storageKey: `media-asset/${mediaAssetId}`, storageProvider: 'database' },
        ]);
        const links = yield* fixture.inCompany(fixture.legalEntityId, (transaction) =>
          transaction
            .select({ id: mediaLinks.mediaLinkId })
            .from(mediaLinks)
            .where(eq(mediaLinks.mediaAssetId, mediaAssetId)),
        );
        expect(links).toHaveLength(1);

        const full = Option.getOrThrow(yield* read(fixture.legalEntityId, 'full'));
        expect(full).toMatchObject({ contentSha256: yield* sha256(PNG), mimeType: 'image/png', rendition: 'full' });
        expect(full.contentBase64).toBe(Base64.encode(PNG));
        const thumbnail = Option.getOrThrow(yield* read(fixture.legalEntityId, 'thumbnail'));
        expect(thumbnail).toMatchObject({ contentSha256: yield* sha256(JPEG), mimeType: 'image/jpeg' });

        // Delivery never serves an asset by identity alone: another company or resource sees nothing.
        expect(Option.isNone(yield* read(fixture.otherLegalEntityId, 'full'))).toBe(true);
        expect(Option.isNone(yield* read(fixture.legalEntityId, 'full', { ...product, resourceId: 'product-2' }))).toBe(
          true,
        );

        const unlinked = yield* fixture.inCompany(fixture.legalEntityId, (transaction) =>
          unlinkMediaFromResource(transaction, { mediaAssetIds: [mediaAssetId], target: product }),
        );
        expect(unlinked).toBe(1);
        expect(Option.isNone(yield* read(fixture.legalEntityId, 'full'))).toBe(true);

        const relinked = yield* fixture.inCompany(fixture.legalEntityId, (transaction) =>
          relinkMediaToResource(transaction, {
            actionInvocationId: fixture.actionInvocationId,
            mediaAssetId,
            principalId: fixture.principalId,
            target: product,
          }),
        );
        expect(relinked).toBe(true);
        expect(Option.isSome(yield* read(fixture.legalEntityId, 'full'))).toBe(true);
        // Another company cannot claim the asset by its identity.
        const foreignRelink = yield* fixture.inCompany(fixture.otherLegalEntityId, (transaction) =>
          relinkMediaToResource(transaction, {
            actionInvocationId: fixture.actionInvocationId,
            mediaAssetId,
            principalId: fixture.principalId,
            target: product,
          }),
        );
        expect(foreignRelink).toBe(false);
      }),
    ),
  );

  suite.effect('refuses content that is not an accepted image whatever its filename says', () =>
    Effect.scoped(
      Effect.gen(function* mediaRejectionIntegration() {
        const fixture = yield* mediaFixture;
        const failure = yield* fixture
          .inCompany(fixture.legalEntityId, (transaction) =>
            storeLinkedMediaImage(transaction, {
              actionInvocationId: fixture.actionInvocationId,
              ingestionSource: 'user',
              mediaAssetId: fixture.actionInvocationId,
              principalId: fixture.principalId,
              target: product,
              upload: {
                filename: 'faktura.png',
                full: { contentBase64: Base64.encode(new TextEncoder().encode('%PDF-1.7 not an image')) },
              },
            }),
          )
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'MediaUploadRejected')).toBe(true);
        expect(failure).toBeInstanceOf(MediaUploadRejected);
        const assets = yield* fixture.inCompany(fixture.legalEntityId, (transaction) =>
          transaction
            .select({ id: mediaAssets.mediaAssetId })
            .from(mediaAssets)
            .where(eq(mediaAssets.legalEntityId, fixture.legalEntityId)),
        );
        expect(assets).toEqual([]);
      }),
    ),
  );
});
