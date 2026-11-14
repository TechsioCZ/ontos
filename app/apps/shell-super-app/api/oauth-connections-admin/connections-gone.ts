import { Data } from 'effect';

/** HTTP 409: the client must reload the changed connection or agent. */
export class ConnectionsGone extends Data.TaggedError('ConnectionsGone')<{ readonly reason: string }> {}
