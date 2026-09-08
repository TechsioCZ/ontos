// expect-count: 3
// A6 evasion: `wireTypeNames` is matched against *every* enclosing name up to the module, so an
// ordinary helper whose name happens to end in `Request` silently exempts everything declared
// inside it. None of the three declarations below is a wire type; each is plain inward threading.
export function decodeInboundRequest(raw: string): string {
	interface InternalScope {
		readonly correlationId: string;
	}
	const forward = (correlationId: string): string => correlationId;
	const scope: InternalScope = { correlationId: forward(raw) };
	return scope.correlationId;
}

export const buildGatewayRequest = () => {
	const annotate = ({ traceId }: { readonly traceId: string }) => traceId;
	return annotate;
};
