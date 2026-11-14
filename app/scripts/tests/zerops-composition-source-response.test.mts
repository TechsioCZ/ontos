import { Effect } from 'effect';
import { HttpBody, HttpServerResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { compositionSnapshotEtag, compositionSnapshotResponse } from '../zerops/composition-source-response.mts';

const snapshot = '{"composition":{"revision":"r1"},"validUntil":"2026-11-13T10:00:00.000Z"}';

it('names each snapshot with a strong SHA-256 ETag that changes with its bytes', () => {
  const etag = compositionSnapshotEtag(snapshot);
  expect(etag).toMatch(/^"[0-9a-f]{64}"$/u);
  expect(compositionSnapshotEtag(snapshot)).toBe(etag);
  expect(compositionSnapshotEtag(snapshot.replace('r1', 'r2'))).not.toBe(etag);
});

it.effect('answers a reader that holds the snapshot with a bodiless 304, every other reader with the bytes', () =>
  Effect.gen(function* conditional() {
    const etag = compositionSnapshotEtag(snapshot);
    const full = compositionSnapshotResponse(snapshot);
    expect(full.status).toBe(200);
    expect(full.headers.etag).toBe(etag);
    expect(full.headers['cache-control']).toBe('no-store');
    const stale = compositionSnapshotResponse(snapshot, '"0000"');
    expect(stale.status).toBe(200);
    const confirmed = compositionSnapshotResponse(snapshot, etag);
    expect(confirmed.status).toBe(304);
    expect(confirmed.headers.etag).toBe(etag);
    expect(confirmed.body).toBe(HttpBody.empty);
    expect(HttpServerResponse.isHttpServerResponse(confirmed)).toBe(true);
    return yield* Effect.void;
  }),
);
