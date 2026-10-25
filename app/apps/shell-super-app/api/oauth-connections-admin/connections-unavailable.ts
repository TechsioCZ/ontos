import { Data } from 'effect';

/** HTTP 503 storage or SpiceDB failure, retaining its original cause. */
export class ConnectionsUnavailable extends Data.TaggedError('ConnectionsUnavailable')<{ readonly cause: unknown }> {}
