// The A6 target state itself: request identity as an ambient Context service. The service payload
// has to be written down somewhere, and `Context.Tag`'s second type argument is where. Flagging it
// makes the recommended migration report a violation of the rule that recommends it.
import { Context, Effect } from 'effect';

export class RequestIdentityTag extends Context.Tag('RequestIdentity')<
	RequestIdentityTag,
	{ readonly correlationId: string; readonly traceId: string }
>() {}

export const use = Effect.gen(function* () {
	const { correlationId } = yield* RequestIdentityTag;
	return correlationId;
});
