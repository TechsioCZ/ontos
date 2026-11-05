import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Hex } from 'effect/encoding';

const UUID_BYTES = 16;
const VERSION_POSITION = 6;
const VARIANT_POSITION = 8;
/** RFC 9562 version 5 is name-based and version 4 random; the version 8 nibble plus this offset marks a custom id. */
const VERSION_8_OFFSET = 128;
const VERSION_NIBBLE_MODULUS = 16;
const VARIANT_MODULUS = 64;

/**
 * A UUID derived from the content that identifies a Core row, for the two places where the identity
 * *is* the content and a random one would make a retry create a second record:
 *
 * 1. the release catalog, whose identity is the digest of the declarations it publishes (D3), and
 * 2. the rows a tenant bootstrap writes, whose identity is the tenant, the scope and the role (D27:
 *    a re-run resumes the tenant it already created instead of building a neighbour).
 *
 * The bytes are the first half of a SHA-256 over the seed, with the RFC 9562 version 8 (custom) and
 * the RFC 4122 variant nibbles set, so the value is a well-formed UUID and is never mistaken for a
 * name-based (v5) or random (v4) identifier. Two seeds never collide in practice, and the same seed
 * always yields the same identifier, which is what makes a repeated write a conflict to resume
 * rather than a duplicate to clean up.
 */
export const stableUuid = (seed: string): string => {
  // The version nibble becomes 8 and the variant becomes RFC 4122's `10`, arithmetically: bitwise
  // operators are not allowed in this codebase and the arithmetic states the same two facts.
  const bytes = [...sha256(utf8ToBytes(seed))].slice(0, UUID_BYTES).map((byte, index) => {
    if (index === VERSION_POSITION) {
      return (byte % VERSION_NIBBLE_MODULUS) + VERSION_8_OFFSET;
    }
    return index === VARIANT_POSITION ? (byte % VARIANT_MODULUS) + VERSION_8_OFFSET : byte;
  });
  const hex = Hex.encode(Uint8Array.from(bytes));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
