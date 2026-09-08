// expect-count: 5
// Ambient declarations, augmented modules, namespaces, default exports and IIFEs stay covered.
export declare function logFailure(correlationId: string): void;

declare module 'shell-augment' {
	interface AugmentedScope {
		readonly correlationId: string;
	}
}

export namespace Wire {
	export interface Inner {
		readonly traceId: string;
	}
}

export default function boot(traceparent: string): string {
	return traceparent;
}

export const iife = ((correlationId: string) => correlationId)('x');
