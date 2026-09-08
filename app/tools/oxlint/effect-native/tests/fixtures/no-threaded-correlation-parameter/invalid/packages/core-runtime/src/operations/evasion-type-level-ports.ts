// expect-count: 7
// Type-level ports and declaration forms that must stay covered.
export interface ScopeFactory {
	new (correlationId: string): { readonly id: string };
	(traceId: string): string;
	load(traceparent: string): void;
}

export type Ctor = new (correlationId: string) => object;
export type Fn = (correlationId: string) => void;

export function constrained<T extends { readonly correlationId: string }>(value: T): T {
	return value;
}

export type Aliased = { readonly base: string } & { readonly traceId: string };
