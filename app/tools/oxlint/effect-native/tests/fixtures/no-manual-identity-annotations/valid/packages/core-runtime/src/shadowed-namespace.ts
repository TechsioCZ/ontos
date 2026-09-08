// A real `effect` import in the file, but the annotation call resolves to a local shadow.
import { Effect as RealEffect } from 'effect';

interface FakeEffect {
	readonly annotateLogs: (annotations: Record<string, unknown>) => unknown;
	readonly withSpan: (name: string, options: Record<string, unknown>) => unknown;
}

export const untraced = RealEffect.logInfo('no annotations here');

export function withVendorTracer(Effect: FakeEffect): unknown {
	return Effect.annotateLogs({ correlationId: 'c-1', tenantId: 't-1' });
}

export function withVendorSpan(RealEffect: FakeEffect): unknown {
	return RealEffect.withSpan('vendor', { attributes: { actionKey: 'a', readKey: 'r' } });
}
