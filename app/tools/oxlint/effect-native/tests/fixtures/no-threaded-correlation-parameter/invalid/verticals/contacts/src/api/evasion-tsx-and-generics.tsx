// expect-count: 5
// TSX: generic arrows, async generators, `satisfies`, fragments, optional and rest parameters.
import type { ReactNode } from 'react';

export const Row = <T,>({ correlationId, value }: { readonly correlationId: string; readonly value: T }): ReactNode => (
	<>
		<div data-corr={correlationId}>{String(value)}</div>
	</>
);

export async function* stream(correlationId: string): AsyncGenerator<string> {
	yield correlationId;
}

export const tagged = (traceparent: string) => `trace-${traceparent}` as const;

const cast = ((correlationId: string) => correlationId) satisfies (c: string) => string;
export { cast };

export const weird = (correlationId?: string, ...rest: readonly [traceId?: string]) => correlationId ?? rest[0];
