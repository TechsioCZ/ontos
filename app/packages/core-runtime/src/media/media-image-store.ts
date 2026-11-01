// Core Media: the governed file store for images that a module attaches to its own resources.
// Core owns the Media Asset (metadata, content identity, lifecycle), its stored renditions and the ResourceRef link.
// A module stores and links an image only inside its own Action transaction, and serves bytes only through a governed
// Read whose access evidence names the exact asset and content hash. Storage keys and asset identities stay internal.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Duration, Effect, Option, Result } from 'effect';
import { Base64 } from 'effect/encoding';

import { mediaAssetRenditions, mediaAssets, mediaLinks } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { MEDIA_IMAGE_LIMITS, MEDIA_IMAGE_MIME_TYPES, detectImageMimeType } from './media-image-contract.ts';
import type { MediaImageMimeType, MediaImageUpload, MediaRendition } from './media-image-contract.ts';
import { MediaStoreUnavailable } from './media-store-unavailable.ts';
import { MediaUploadRejected } from './media-upload-rejected.ts';

/** The module resource an asset is attached to (a ResourceRef without the tenant, which the scope supplies). */
export interface MediaLinkTarget {
  readonly linkKind: string;
  readonly moduleKey: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

type MediaTransaction = Pick<ScopedTransactionExecutor, 'insert' | 'scope' | 'select' | 'update'>;

export interface StoredMediaImage {
  readonly byteSize: number;
  readonly contentSha256: string;
  readonly mediaAssetId: string;
  readonly mimeType: MediaImageMimeType;
}

export interface MediaRenditionContent {
  readonly contentBase64: string;
  readonly contentSha256: string;
  readonly mediaAssetId: string;
  readonly mimeType: MediaImageMimeType;
  readonly rendition: MediaRendition;
}

const rejected = (code: MediaUploadRejected['code'], reason: string) => new MediaUploadRejected({ code, reason });
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new MediaStoreUnavailable({ code: 'media_store_unavailable', reason: 'Media storage is temporarily unavailable' }),
    'cause',
    { configurable: false, enumerable: false, value: cause, writable: false },
  );

const sha256Hex = (bytes: Uint8Array) =>
  Effect.tryPromise({
    catch: unavailable,
    try: globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle, 'SHA-256', new Uint8Array(bytes)),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(10),
      orElse: () => Effect.fail(unavailable('Hashing timed out')),
    }),
    Effect.map((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')),
  );

interface ValidatedRendition {
  readonly bytes: Uint8Array;
  readonly contentBase64: string;
  readonly contentSha256: string;
  readonly height: number | undefined;
  readonly mimeType: MediaImageMimeType;
  readonly rendition: MediaRendition;
  readonly width: number | undefined;
}

const validateRendition = Effect.fn('CoreMedia.validateRendition')(function* validateRendition(
  rendition: MediaRendition,
  input: MediaImageUpload['full'],
  maxBytes: number,
) {
  const decoded = Base64.decode(input.contentBase64);
  if (Result.isFailure(decoded) || decoded.success.byteLength === 0) {
    return yield* rejected('media_content_invalid', 'The image content is not valid base64');
  }
  const bytes = decoded.success;
  if (bytes.byteLength > maxBytes) {
    return yield* rejected('media_too_large', `The image exceeds the ${maxBytes} byte limit`);
  }
  const mimeType = detectImageMimeType(bytes);
  if (mimeType === undefined) {
    return yield* rejected('media_type_unsupported', 'Only JPEG, PNG and WebP images are accepted');
  }
  const contentSha256 = yield* sha256Hex(bytes);
  return {
    bytes,
    contentBase64: Base64.encode(bytes),
    contentSha256,
    height: input.height,
    mimeType,
    rendition,
    width: input.width,
  } satisfies ValidatedRendition;
});

/** Keeps a display name a person recognises; path separators and control characters never reach presentation. */
export const displayFilenameOf = (filename: string): string => {
  const base = filename.split(/[\\/]/u).at(-1) ?? '';
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what must be removed
  const cleaned = base.replaceAll(/[\u0000-\u001F\u007F]/gu, '').trim();
  return cleaned === '' ? 'obrazek' : cleaned.slice(0, 200);
};

const insertLink = (
  transaction: MediaTransaction,
  input: {
    readonly actionInvocationId: string | undefined;
    readonly linkSource: 'import' | 'system' | 'user';
    readonly mediaAssetId: string;
    readonly principalId: string | undefined;
    readonly target: MediaLinkTarget;
  },
) =>
  transaction
    .insert(mediaLinks)
    .values({
      actionInvocationId: input.actionInvocationId,
      linkedByPrincipalId: input.principalId,
      linkKind: input.target.linkKind,
      linkSource: input.linkSource,
      mediaAssetId: input.mediaAssetId,
      targetModuleKey: input.target.moduleKey,
      targetResourceId: input.target.resourceId,
      targetResourceType: input.target.resourceType,
      tenantId: transaction.scope.tenantId,
    })
    .pipe(Effect.mapError(unavailable), Effect.asVoid);

const activeLinkWhere = (transaction: MediaTransaction, target: MediaLinkTarget, mediaAssetIds: readonly string[]) =>
  and(
    eq(mediaLinks.tenantId, transaction.scope.tenantId),
    inArray(mediaLinks.mediaAssetId, [...mediaAssetIds]),
    eq(mediaLinks.targetModuleKey, target.moduleKey),
    eq(mediaLinks.targetResourceType, target.resourceType),
    eq(mediaLinks.targetResourceId, target.resourceId),
    eq(mediaLinks.linkKind, target.linkKind),
    isNull(mediaLinks.deletedAt),
  );

/**
 * Validates an uploaded image, stores it as a sealed Media Asset of the transaction's company with its renditions,
 * and links it to the target resource, all in the caller's Action transaction. `mediaAssetId` is supplied only by
 * native seed imports, which must be idempotent: an existing asset of the same company is linked, never rewritten.
 */
export const storeLinkedMediaImage = Effect.fn('CoreMedia.storeLinkedMediaImage')(function* storeLinkedMediaImage(
  transaction: MediaTransaction,
  input: {
    readonly actionInvocationId: string | undefined;
    readonly ingestionSource: 'import' | 'system' | 'user';
    readonly mediaAssetId: string;
    readonly principalId: string | undefined;
    readonly target: MediaLinkTarget;
    readonly upload: MediaImageUpload;
  },
) {
  const { legalEntityId, tenantId } = transaction.scope;
  if (legalEntityId === undefined) {
    return yield* rejected('media_content_invalid', 'Media requires a selected company');
  }
  const full = yield* validateRendition('full', input.upload.full, MEDIA_IMAGE_LIMITS.fullMaxBytes);
  const renditions: ValidatedRendition[] = [full];
  if (input.upload.thumbnail !== undefined) {
    renditions.push(
      yield* validateRendition('thumbnail', input.upload.thumbnail, MEDIA_IMAGE_LIMITS.thumbnailMaxBytes),
    );
  }
  const existing = yield* transaction
    .select({ legalEntityId: mediaAssets.legalEntityId })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.tenantId, tenantId), eq(mediaAssets.mediaAssetId, input.mediaAssetId)))
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  if (existing.length === 0) {
    yield* transaction
      .insert(mediaAssets)
      .values({
        byteSize: BigInt(full.bytes.byteLength),
        contentSha256: full.contentSha256,
        displayFilename: displayFilenameOf(input.upload.filename),
        ingestedByPrincipalId: input.principalId,
        ingestionSource: input.ingestionSource,
        legalEntityId,
        mediaAssetId: input.mediaAssetId,
        mimeType: full.mimeType,
        originalFilename: input.upload.filename,
        processingStatus: 'ready',
        sealedAt: sql`now()`,
        // Collision-resistant technical identity of the stored object; never a filename or business hierarchy.
        storageKey: `media-asset/${input.mediaAssetId}`,
        storageProvider: 'database',
        tenantId,
      })
      .pipe(Effect.mapError(unavailable));
    yield* Effect.forEach(
      renditions,
      (rendition) =>
        transaction
          .insert(mediaAssetRenditions)
          .values({
            bytes: sql`decode(${rendition.contentBase64}, 'base64')`,
            byteSize: rendition.bytes.byteLength,
            contentSha256: rendition.contentSha256,
            height: rendition.height,
            mediaAssetId: input.mediaAssetId,
            mimeType: rendition.mimeType,
            rendition: rendition.rendition,
            tenantId,
            width: rendition.width,
          })
          .pipe(Effect.mapError(unavailable)),
      { concurrency: 1, discard: true },
    );
  } else if (existing[0]?.legalEntityId !== legalEntityId) {
    return yield* rejected('media_content_invalid', 'The media asset belongs to another company');
  }
  const linked = yield* transaction
    .select({ mediaLinkId: mediaLinks.mediaLinkId })
    .from(mediaLinks)
    .where(activeLinkWhere(transaction, input.target, [input.mediaAssetId]))
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  if (linked.length === 0) {
    yield* insertLink(transaction, {
      actionInvocationId: input.actionInvocationId,
      linkSource: input.ingestionSource,
      mediaAssetId: input.mediaAssetId,
      principalId: input.principalId,
      target: input.target,
    });
  }
  return {
    byteSize: full.bytes.byteLength,
    contentSha256: full.contentSha256,
    mediaAssetId: input.mediaAssetId,
    mimeType: full.mimeType,
  } satisfies StoredMediaImage;
});

/** Ends the active links of the assets to the target; the sealed assets and their evidence remain. */
export const unlinkMediaFromResource = Effect.fn('CoreMedia.unlinkMediaFromResource')(function* unlinkMedia(
  transaction: MediaTransaction,
  input: { readonly mediaAssetIds: readonly string[]; readonly target: MediaLinkTarget },
) {
  if (input.mediaAssetIds.length === 0) {
    return 0;
  }
  const rows = yield* transaction
    .update(mediaLinks)
    .set({ deletedAt: sql`now()` })
    .where(activeLinkWhere(transaction, input.target, input.mediaAssetIds))
    .returning({ mediaLinkId: mediaLinks.mediaLinkId })
    .pipe(Effect.mapError(unavailable));
  return rows.length;
});

/** Links an existing asset of the transaction's company to the target again (undo of a removal). */
export const relinkMediaToResource = Effect.fn('CoreMedia.relinkMediaToResource')(function* relinkMedia(
  transaction: MediaTransaction,
  input: {
    readonly actionInvocationId: string | undefined;
    readonly mediaAssetId: string;
    readonly principalId: string | undefined;
    readonly target: MediaLinkTarget;
  },
) {
  const { legalEntityId, tenantId } = transaction.scope;
  const asset = yield* transaction
    .select({ mediaAssetId: mediaAssets.mediaAssetId })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.tenantId, tenantId),
        eq(mediaAssets.mediaAssetId, input.mediaAssetId),
        legalEntityId === undefined ? sql`false` : eq(mediaAssets.legalEntityId, legalEntityId),
        eq(mediaAssets.processingStatus, 'ready'),
      ),
    )
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  if (asset.length === 0) {
    return false;
  }
  const linked = yield* transaction
    .select({ mediaLinkId: mediaLinks.mediaLinkId })
    .from(mediaLinks)
    .where(activeLinkWhere(transaction, input.target, [input.mediaAssetId]))
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  if (linked.length === 0) {
    yield* insertLink(transaction, { ...input, linkSource: 'user' });
  }
  return true;
});

/**
 * The stored rendition of one asset that is actively linked to the target in the transaction's company. A missing
 * thumbnail falls back to the full rendition. None when the asset is not linked there: delivery never serves an
 * asset by identity alone.
 */
export const readLinkedMediaRendition = Effect.fn('CoreMedia.readLinkedMediaRendition')(function* readRendition(
  transaction: MediaTransaction,
  input: { readonly mediaAssetId: string; readonly rendition: MediaRendition; readonly target: MediaLinkTarget },
) {
  const { legalEntityId, tenantId } = transaction.scope;
  if (legalEntityId === undefined) {
    return Option.none<MediaRenditionContent>();
  }
  const rows = yield* transaction
    .select({
      contentBase64: sql<string>`encode(${mediaAssetRenditions.bytes}, 'base64')`,
      contentSha256: mediaAssetRenditions.contentSha256,
      mimeType: mediaAssetRenditions.mimeType,
      rendition: mediaAssetRenditions.rendition,
    })
    .from(mediaAssetRenditions)
    .innerJoin(
      mediaAssets,
      and(
        eq(mediaAssets.tenantId, mediaAssetRenditions.tenantId),
        eq(mediaAssets.mediaAssetId, mediaAssetRenditions.mediaAssetId),
      ),
    )
    .where(
      and(
        eq(mediaAssetRenditions.tenantId, tenantId),
        eq(mediaAssetRenditions.mediaAssetId, input.mediaAssetId),
        inArray(mediaAssetRenditions.rendition, [...new Set<MediaRendition>([input.rendition, 'full'])]),
        eq(mediaAssets.legalEntityId, legalEntityId),
        eq(mediaAssets.processingStatus, 'ready'),
        sql`exists (select 1 from ${mediaLinks} where ${activeLinkWhere(transaction, input.target, [input.mediaAssetId])})`,
      ),
    )
    .pipe(Effect.mapError(unavailable));
  const row = rows.find((candidate) => candidate.rendition === input.rendition) ?? rows[0];
  const mimeType = MEDIA_IMAGE_MIME_TYPES.find((type) => type === row?.mimeType);
  if (row === undefined || mimeType === undefined) {
    return Option.none<MediaRenditionContent>();
  }
  return Option.some({
    // Postgres wraps encode() output every 76 characters.
    contentBase64: row.contentBase64.replaceAll('\n', ''),
    contentSha256: row.contentSha256,
    mediaAssetId: input.mediaAssetId,
    mimeType,
    rendition: row.rendition === 'thumbnail' ? 'thumbnail' : 'full',
  } satisfies MediaRenditionContent);
});
