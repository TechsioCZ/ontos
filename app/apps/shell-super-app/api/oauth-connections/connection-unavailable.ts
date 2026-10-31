import { Data } from 'effect';

/** Database, SpiceDB or catalog failure. */
export class ConnectionUnavailable extends Data.TaggedError('ConnectionUnavailable')<{ readonly cause: unknown }> {}
