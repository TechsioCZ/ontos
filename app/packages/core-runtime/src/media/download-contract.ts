import { Context, Effect, Schema } from 'effect';

import { mediaUnavailable } from './errors.ts';
import { MediaAssetRefSchema } from '../resources/media-asset.ts';
import type { MediaAssetRef } from '../resources/media-asset.ts';
import { MediaByteSizeSchema, MediaContentSha256Schema } from './public-contract.ts';
import type { MediaVerifiableAsset } from './verified-read.ts';

/*
 * The public shapes of the download decision. The governed Read answers WHETHER and WHAT may be delivered: the
 * confirmed identity of one ready asset and the name and type to present it under. It never answers WHERE the
 * bytes are. The stored object's locator reaches the byte edge on a different, in-process path that has no wire
 * representation (`MediaDownloadSource`), so no Read result, route or DTO carries a storage provider, key, version
 * reference or URL (design-review M9).
 */

export const AssetDownloadRequestSchema = Schema.Struct({ mediaAssetRef: MediaAssetRefSchema });
export type AssetDownloadRequest = typeof AssetDownloadRequestSchema.Type;

/** What a download is allowed to present: exactly the confirmed identity, and the recorded name and type. */
export const AssetDownloadAuthorizationSchema = Schema.Struct({
  byteSize: MediaByteSizeSchema,
  contentSha256: MediaContentSha256Schema,
  displayFilename: Schema.String,
  mediaAssetRef: MediaAssetRefSchema,
  mimeType: Schema.String,
});
export type AssetDownloadAuthorization = typeof AssetDownloadAuthorizationSchema.Type;

/**
 * The request-scoped channel on which the governed download Read hands the stored object's facts to the byte edge
 * that ran it. Only the composing host provides it, only the Read calls it, and it is called after the access
 * decision allowed the request and inside the Read's own tenant-scoped transaction. The host uses what it was
 * offered only after the Read completed (its evidence is durable then), so a failed or refused Read releases
 * nothing. It is deliberately not part of any result schema.
 */
export class MediaDownloadSource extends Context.Service<
  MediaDownloadSource,
  { readonly offer: (asset: MediaVerifiableAsset) => Effect.Effect<void> }
>()('@app/core-runtime/media/download-contract/MediaDownloadSource') {}

/** The confirmed identity of a sealed row, validated as the values Core could have written, or unavailable. */
export const toAssetDownloadAuthorization = (
  asset: Pick<MediaVerifiableAsset, 'byteSize' | 'contentSha256'> & {
    readonly displayFilename: string;
    readonly mimeType: string;
  },
  mediaAssetRef: MediaAssetRef,
) =>
  Schema.decodeUnknownEffect(AssetDownloadAuthorizationSchema)({
    byteSize: Number(asset.byteSize),
    contentSha256: asset.contentSha256,
    displayFilename: asset.displayFilename,
    mediaAssetRef,
    mimeType: asset.mimeType,
  }).pipe(Effect.mapError((cause) => mediaUnavailable('The confirmed identity of the asset is not readable', cause)));
