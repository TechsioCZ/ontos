import { Data } from 'effect';

/** Why a connection gets no stream; the browser's EventSource treats every non-200 answer as final and backs off. */
export class LiveScopeUnavailable extends Data.TaggedError('LiveScopeUnavailable')<{
  readonly status: 401 | 409 | 503;
}> {}
