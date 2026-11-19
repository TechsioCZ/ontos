import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ActionRequestHashConflict } from '../../src/actions/errors.ts';
import {
  MediaAssetNotFound,
  MediaContentConflict,
  MediaFailureSchema,
  MediaForbidden,
  MediaIngestUncertain,
  MediaIntegrityFailed,
  MediaNotReady,
  MediaUnavailable,
  isMediaFailure,
  mediaAssetNotFound,
  mediaFailureStatus,
} from '../../src/media/errors.ts';
import type { MediaFailure } from '../../src/media/errors.ts';

const reason = 'safe reason';

const everyFailure = {
  ActionRequestHashConflict: new ActionRequestHashConflict({ code: 'action_request_hash_conflict', reason }),
  MediaAssetNotFound: new MediaAssetNotFound({ code: 'media_asset_not_found', reason }),
  MediaContentConflict: new MediaContentConflict({ code: 'media_content_conflict', reason }),
  MediaForbidden: new MediaForbidden({ code: 'media_forbidden', reason }),
  MediaIngestUncertain: new MediaIngestUncertain({ code: 'media_ingest_uncertain', reason }),
  MediaIntegrityFailed: new MediaIntegrityFailed({ code: 'media_integrity_failed', reason }),
  MediaNotReady: new MediaNotReady({ code: 'media_not_ready', reason }),
  MediaUnavailable: new MediaUnavailable({ code: 'media_unavailable', reason }),
} satisfies Record<MediaFailure['_tag'], MediaFailure>;

it('keeps forbidden, unavailable, not found, integrity and the other outcomes as distinct tags and codes', () => {
  const failures = Object.values(everyFailure);
  expect(new Set(failures.map((failure) => failure._tag)).size).toBe(failures.length);
  expect(new Set(failures.map((failure) => failure.code)).size).toBe(failures.length);
});

it('maps every media failure to exactly one declared HTTP status, exhaustively', () => {
  expect(
    Object.fromEntries(Object.entries(everyFailure).map(([tag, failure]) => [tag, mediaFailureStatus(failure)])),
  ).toEqual({
    ActionRequestHashConflict: 409,
    MediaAssetNotFound: 404,
    MediaContentConflict: 409,
    MediaForbidden: 403,
    MediaIngestUncertain: 503,
    MediaIntegrityFailed: 422,
    MediaNotReady: 409,
    MediaUnavailable: 503,
  });
});

it('keeps integrity failure and not-ready off the 404 that means an absent asset', () => {
  expect(mediaFailureStatus(everyFailure.MediaIntegrityFailed)).not.toBe(404);
  expect(mediaFailureStatus(everyFailure.MediaNotReady)).not.toBe(404);
  expect(mediaFailureStatus(everyFailure.MediaUnavailable)).not.toBe(404);
});

it('decodes every failure through the closed union and rejects an unknown tag', () => {
  for (const failure of Object.values(everyFailure)) {
    expect(Schema.is(MediaFailureSchema)(failure)).toBe(true);
    expect(isMediaFailure(failure)).toBe(true);
  }
  expect(isMediaFailure({ _tag: 'SomethingElse', code: 'x', reason })).toBe(false);
});

it('answers a foreign tenant lookup exactly like an unknown id, so existence is not leaked', () => {
  const foreignTenant = mediaAssetNotFound();
  const unknownId = mediaAssetNotFound();
  expect(Schema.encodeSync(MediaAssetNotFound)(foreignTenant)).toEqual(
    Schema.encodeSync(MediaAssetNotFound)(unknownId),
  );
  expect(foreignTenant.reason).not.toMatch(/tenant|forbidden|exists/iu);
});
