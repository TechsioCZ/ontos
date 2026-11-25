import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

import { MediaAssetRefSchema } from '../resources/media-asset.ts';
import type { MediaByteHopAsset } from './byte-stream.ts';

/*
 * The public shapes of the byte-source read, the row step of the byte-ingress edge. The edge needs the reserved
 * row of one asset (its state, size, digest claim, reserving principal and storage identity) before it may move a
 * byte. That row is read by a Core Read in the trusted tenant scope, but its storage facts never travel as a Read
 * result: they reach the edge through the request-scoped, never serialized `MediaByteSource` channel, exactly as
 * the download Read hands its object to the download edge. The Read's own answer carries no storage value.
 */

export const AssetByteSourceRequestSchema = Schema.Struct({ mediaAssetRef: MediaAssetRefSchema });

/** All the Read answers: that the asset exists in the caller's tenant. The row itself goes through the channel. */
export const AssetByteSourceResultSchema = Schema.Struct({ mediaAssetRef: MediaAssetRefSchema });

/** What the edge learns of the reserved row: the byte hop's facts and the company the asset was reserved in. */
export interface MediaByteSourceOffer extends MediaByteHopAsset {
  readonly legalEntityId: string | null;
}

/**
 * The request-scoped channel on which the byte-source Read hands the reserved row to the edge that ran it. Only
 * the composing host provides it and only the Read calls it, inside the Read's own tenant-scoped transaction. The
 * host uses what it was offered only after the Read completed. It is deliberately not part of any result schema.
 */
export class MediaByteSource extends Context.Service<
  MediaByteSource,
  { readonly offer: (asset: MediaByteSourceOffer) => Effect.Effect<void> }
>()('@app/core-runtime/media/byte-source-contract/MediaByteSource') {}
