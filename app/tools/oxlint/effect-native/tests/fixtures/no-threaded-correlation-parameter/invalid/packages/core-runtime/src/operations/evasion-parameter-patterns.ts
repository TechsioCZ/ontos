// expect-count: 5
// Destructuring, defaults, rest parameters and one level of nesting stay covered.
export interface SearchInput {
	readonly context: { readonly correlationId: string };
}

export const withDefault = (correlationId: string = 'none') => correlationId;
export const renamed = ({ correlationId: cid }: { readonly correlationId: string }) => cid;
export const nested1 = ({ meta: { traceId } }: { readonly meta: { readonly traceId: string } }) => traceId;
export function spread(first: string, ...traceparent: readonly string[]): number {
	return traceparent.length + first.length;
}
