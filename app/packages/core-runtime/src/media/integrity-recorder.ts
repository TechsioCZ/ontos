import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Context } from 'effect';
import type { Effect } from 'effect';
import { Hex } from 'effect/encoding';

import type { MediaAssetRef } from '../resources/media-asset.ts';
import type { MediaIntegrityFinding } from './verified-read.ts';

/*
 * The port through which a reader hands PROVEN corruption to the integrity Action. Reading never changes state:
 * the host composes this recorder with the bound integrity workload, runs `core.media.record-asset-integrity-failure`
 * with the finding as its proof service, and a failure to record never changes what the reader already answered.
 * The next verification of the same asset finds the same corruption and records it again.
 */
export class MediaIntegrityRecorder extends Context.Service<
  MediaIntegrityRecorder,
  { readonly record: (finding: MediaIntegrityFinding, mediaAssetRef: MediaAssetRef) => Effect.Effect<void> }
>()('@app/core-runtime/media/integrity-recorder/MediaIntegrityRecorder') {}

/**
 * The idempotent request of the integrity Action for one finding. The same finding of the same asset is the same
 * intent, whoever read it, so a replay returns the first answer and records nothing twice.
 */
export const integrityRecordRequest = (finding: MediaIntegrityFinding, mediaAssetRef: MediaAssetRef) => {
  const idempotencyKey = Hex.encode(
    sha256(
      utf8ToBytes(
        `core.media.integrity\0${mediaAssetRef.tenantId}\0${mediaAssetRef.resourceId}\0${finding.observed.contentSha256}\0${finding.observed.byteSize}`,
      ),
    ),
  );
  return {
    payload: { mediaAssetRef },
    transport: { correlationId: `core-media-integrity-${idempotencyKey.slice(0, 16)}`, idempotencyKey },
  } as const;
};
