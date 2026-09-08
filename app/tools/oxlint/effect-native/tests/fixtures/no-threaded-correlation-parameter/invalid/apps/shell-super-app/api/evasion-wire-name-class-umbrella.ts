// expect-count: 2
// A6 evasion: the enclosing *class* name ends in `Request`, so its members' own names
// (`start`, `scope`) never get checked — an entire service is exempted by its class name.
export class ImpersonationStartRequest {
	readonly scope: { readonly traceId: string } = { traceId: 'unknown' };

	start(correlationId: string): string {
		return correlationId;
	}
}
