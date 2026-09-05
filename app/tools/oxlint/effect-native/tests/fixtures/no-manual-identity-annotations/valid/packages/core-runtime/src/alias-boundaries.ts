import { Effect } from "effect";
const annotate = Effect.annotateLogs;
const { withSpan: span } = Effect;
export function shadow(annotate: (value: unknown) => unknown, span: (value: unknown) => unknown) {
	annotate({ correlationId: "domain" });
	span({ attributes: { tenantId: "domain" } });
}
let replaced = Effect.annotateLogs;
replaced = (_: unknown) => undefined;
replaced({ correlationId: "not-effect" });
// Opaque/nested records remain beyond this flat-record detector; this is not proof of safety.
annotate({ identity: { correlationId: "nested" } });
void span;
