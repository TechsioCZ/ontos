import { Data } from 'effect';

/** Czech reason becomes the HTTP 404 problem detail. */
export class ConnectionsNotFound extends Data.TaggedError('ConnectionsNotFound')<{ readonly reason: string }> {}
