import { Data } from 'effect';

/** Czech reason becomes the HTTP 403 problem detail. */
export class ConnectionsForbidden extends Data.TaggedError('ConnectionsForbidden')<{ readonly reason: string }> {}
