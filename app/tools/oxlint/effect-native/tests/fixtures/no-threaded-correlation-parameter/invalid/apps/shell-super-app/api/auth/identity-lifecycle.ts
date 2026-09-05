// expect-count: 7
// A6: correlation threaded positionally through the shell auth seam and inward.
const transport = (correlationId: string, idempotencyKey: string) => ({ correlationId, idempotencyKey });

export const startIdentityLifecycle = (input: {
	readonly correlationId: string;
	readonly principalId: string;
}) => transport(input.correlationId, input.principalId);

export function annotateLifecycle(traceparent: string): string {
	return traceparent;
}

export class LifecycleGateway {
	private readonly correlationId: string = 'missing';

	constructor(private readonly traceId: string) {}

	run(correlationId: string): string {
		return `${this.correlationId}${this.traceId}${correlationId}`;
	}
}

const withFallback = ({ correlationId = 'missing' }: Record<string, string>) => correlationId;

export const lifecycle = { startIdentityLifecycle, withFallback };
