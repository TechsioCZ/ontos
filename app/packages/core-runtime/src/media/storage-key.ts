import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Schema } from 'effect';
import { Hex } from 'effect/encoding';

const STORAGE_KEY_PREFIX = 'core-media/v1/';
const STORAGE_KEY_DOMAIN = 'core.media.asset.object';

/**
 * A technical object key: collision-resistant, independent of the file name and of any user text, and never a
 * revision or a URL. It is derived only from the reserved asset row's identity.
 */
export const MediaStorageKeySchema = Schema.String.check(
  Schema.isPattern(new RegExp(`^${STORAGE_KEY_PREFIX}[0-9a-f]{64}$`, 'u')),
).pipe(Schema.brand('MediaStorageKey'));
export type MediaStorageKey = typeof MediaStorageKeySchema.Type;

/**
 * The key is a pure function of `(tenantId, mediaAssetId)` under a fixed domain-separation prefix. Both ids are
 * fixed-length uuids, so the NUL-joined pair is injective; two assets never share a key, whatever their bytes or
 * display names. The same asset always gets the same key, which is what lets a retry converge on one object.
 */
export const deriveMediaStorageKey = (key: {
  readonly mediaAssetId: string;
  readonly tenantId: string;
}): MediaStorageKey =>
  MediaStorageKeySchema.make(
    `${STORAGE_KEY_PREFIX}${Hex.encode(
      sha256(utf8ToBytes(`${STORAGE_KEY_DOMAIN}\0${key.tenantId.toLowerCase()}\0${key.mediaAssetId.toLowerCase()}`)),
    )}`,
  );
