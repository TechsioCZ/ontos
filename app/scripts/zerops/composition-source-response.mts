/**
 * The loopback composition source's answer. Every owner bundle and Outbox loop asks it every 30 seconds; the snapshot
 * changes only when a composition is published or its lease renewed (every 6 hours). Each answer names its bytes with a
 * strong ETag (SHA-256), and a request that already holds those bytes gets a bodiless 304, so an unchanged snapshot is
 * neither sent nor decoded and parsed again by the reader.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Hex } from 'effect/encoding';
import { HttpServerResponse } from 'effect/http';

let lastEtag: { readonly etag: string; readonly snapshot: string } | undefined;

/** The snapshot's strong ETag; computed once per published value, not once per request. */
export const compositionSnapshotEtag = (snapshot: string): string => {
  if (lastEtag?.snapshot !== snapshot) {
    lastEtag = { etag: `"${Hex.encode(sha256(utf8ToBytes(snapshot)))}"`, snapshot };
  }
  return lastEtag.etag;
};

export const compositionSnapshotResponse = (snapshot: string, ifNoneMatch?: string) => {
  const etag = compositionSnapshotEtag(snapshot);
  const headers = { 'cache-control': 'no-store', etag };
  return ifNoneMatch === etag
    ? HttpServerResponse.empty({ headers, status: 304 })
    : HttpServerResponse.text(snapshot, { contentType: 'application/json', headers });
};
