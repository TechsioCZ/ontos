import { Data } from 'effect';

/** Czech `reason` is returned to the client as the problem detail (HTTP 422). */
export class AgentPlatformInvalid extends Data.TaggedError('AgentPlatformInvalid')<{ readonly reason: string }> {}
