// Reads, annotation bags and Schema field bags: values, never declared channels.
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

export const Row = Schema.Struct({ correlationId: Schema.String, traceparent: Schema.String });
export const read = (input: Record<string, string>) => input['correlationId'];
export const optional = (input?: { readonly nested?: Record<string, string> }) => input?.nested?.['correlationId'];
export const annotate = (id: string) => Effect.annotateLogs(Effect.void, { correlationId: id, traceId: id });
export const spanned = (id: string) => Effect.withSpan(Effect.void, 'op', { attributes: { correlationId: id } });
export const literal = { correlationId: 'x', traceId: 'y' } as const;
