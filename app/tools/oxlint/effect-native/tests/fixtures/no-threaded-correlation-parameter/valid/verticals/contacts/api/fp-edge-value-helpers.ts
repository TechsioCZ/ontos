// FALSE POSITIVE regression fixture (adversarial review).
//
// Real sites reproduced verbatim in shape:
//   verticals/contacts/api/read-server-support.ts:34            `requireCorrelationId`
//   verticals/contacts/src/integrations/ares/ares-subject.service.ts:192  `safeCorrelationId`
//
// Neither threads identity through a layer. In both, `correlationId` is the *subject* of the
// function, not context carried alongside a payload:
//   - `requireCorrelationId` IS the outer HTTP adapter seam — it validates the raw inbound
//     `request.headers['x-correlation-id']` so identity can be established. The audit blesses the
//     single outer adapter seam, and A6's own target ("establish one outer HTTP instrumentation
//     seam", "put correlation into ambient annotations") still requires exactly this signature:
//     something has to accept the header string before a `Context.Reference` can be provided.
//   - `safeCorrelationId` is a pure string sanitiser feeding a span/log attribute. It survives the
//     A6 target unchanged (`correlationId: safeCorrelationId(yield* RequestIdentity)`).
// The rule's advice ("read it with `yield*` instead of passing it down") is inapplicable to both:
// nothing passes it down — it arrives from the transport, or it is the value being formatted.
import { Effect } from 'effect';

export const requireCorrelationId = <Problem>(
	correlationId: string | undefined,
	invalid: () => Problem,
) =>
	correlationId === undefined || correlationId.trim().length === 0
		? Effect.fail(invalid())
		: Effect.succeed(correlationId);

export const safeCorrelationId = (correlationId: string): string => {
	const sanitized = correlationId.replaceAll(/[\r\n\t]/gu, ' ').trim().slice(0, 128);
	return sanitized.length === 0 ? 'unavailable' : sanitized;
};
