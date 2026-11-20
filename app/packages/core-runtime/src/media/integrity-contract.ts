import { Context, Schema } from 'effect';

import { MediaAssetRefSchema } from '../resources/media-asset.ts';
import { MediaByteSizeSchema, MediaContentSha256Schema } from './public-contract.ts';
import type { MediaIntegrityFinding } from './verified-read.ts';

/*
 * The public shapes of the integrity Action. The proof that makes it legitimate is never in the payload: only the
 * composing host can hand it over, as a request-scoped service produced by the verified read.
 */

export const RecordAssetIntegrityFailurePayloadSchema = Schema.Struct({ mediaAssetRef: MediaAssetRefSchema });
export type RecordAssetIntegrityFailurePayload = typeof RecordAssetIntegrityFailurePayloadSchema.Type;

/** What was recorded: the asset is `failed`, and the digest and length of the corrupt bytes that proved it. */
export const RecordAssetIntegrityFailureResultSchema = Schema.Struct({
  mediaAssetRef: MediaAssetRefSchema,
  observed: Schema.Struct({ byteSize: MediaByteSizeSchema, contentSha256: MediaContentSha256Schema }),
  processingStatus: Schema.Literal('failed'),
});

/**
 * The proof the integrity Action decides on, handed to it as a request-scoped service by the trusted caller that
 * read the object: a payload field could be forged by any caller, a service only the composing host can provide.
 */
export class ProvenMediaIntegrityFinding extends Context.Service<ProvenMediaIntegrityFinding, MediaIntegrityFinding>()(
  '@app/core-runtime/media/integrity-contract/ProvenMediaIntegrityFinding',
) {}
