// Identity threaded through a non-Effect tracer/logger is a different (unowned) API surface, and the
// Effect annotation here carries only per-event facts.
import { Effect } from 'effect';

declare const tracer: { readonly startActiveSpan: (name: string, options: unknown) => void };
declare const logger: { readonly child: (bindings: Record<string, unknown>) => void };
declare const identity: { readonly correlationId: string; readonly tenantId: string };

export function ContactsPanel(): JSX.Element {
	tracer.startActiveSpan('Contacts.panel', { attributes: { correlationId: identity.correlationId } });
	logger.child({ correlationId: identity.correlationId, tenantId: identity.tenantId });
	const load = Effect.annotateLogs(Effect.void, { rowCount: 10, outcome: 'loaded' });
	return <div data-effect={String(load)} />;
}
