// The blessed outer HTTP/transport seam: wire-named declarations may carry correlation verbatim.
export interface ShellRequestHeaders {
	readonly 'x-correlation-id'?: string;
	readonly correlationId?: string;
}

export interface ShellActionProblem {
	readonly correlationId: string;
	readonly status: number;
}

export type ShellActionPayload = {
	readonly body: string;
	readonly traceId?: string;
};

export type ShellActionResponse = {
	readonly correlationId: string;
};

export interface GatewayRequest {
	readonly traceparent: string;
}

export const shellHeaders = (correlationId: string) => ({ 'x-correlation-id': correlationId });

export const inboundRequest = ({ traceparent }: GatewayRequest) => traceparent;
