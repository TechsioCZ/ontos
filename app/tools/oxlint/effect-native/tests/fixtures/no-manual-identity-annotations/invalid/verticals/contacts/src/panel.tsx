// expect-count: 3
// TSX: browser-side instrumentation copies the same identity into every span.
import { Effect } from 'effect';

declare const useIdentity: () => { correlationId: string; moduleKey: string; tenantId: string };

export function ContactsPanel(): JSX.Element {
	const identity = useIdentity();
	const load = Effect.succeed(1).pipe(
		Effect.withSpan('Contacts.panel.load', {
			attributes: {
				correlationId: identity.correlationId,
				moduleKey: identity.moduleKey,
				rowCount: 10,
			},
		}),
		Effect.annotateLogs('x-tenant-id', identity.tenantId),
	);
	return <div data-effect={String(load)} />;
}
