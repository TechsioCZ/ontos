// A local, non-Effect `annotateLogs`/`Effect` must never match the Effect namespace.
const Effect = {
	annotateLogs: (message: string, annotations: Record<string, unknown>) => ({ message, annotations }),
	withSpan: (name: string, options: Record<string, unknown>) => ({ name, options }),
};

const annotateLogs = (annotations: Record<string, unknown>) => annotations;

export const localAnnotate = Effect.annotateLogs('local', { correlationId: 'c-1', tenantId: 't-1' });
export const localSpan = Effect.withSpan('local', { attributes: { actionKey: 'a', readKey: 'r' } });
export const localHelper = annotateLogs({ correlationId: 'c-1' });

export function shadowed(Effect: { annotateLogs: (a: Record<string, unknown>) => unknown }): unknown {
	return Effect.annotateLogs({ correlationId: 'c-1', invocationId: 'i-1' });
}
