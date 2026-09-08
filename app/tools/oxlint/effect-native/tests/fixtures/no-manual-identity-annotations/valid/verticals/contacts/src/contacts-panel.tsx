// TSX with non-identity annotations only.
import { Effect } from 'effect';

declare const rowCount: number;

export function ContactsList(): JSX.Element {
	const load = Effect.succeed(rowCount).pipe(
		Effect.annotateLogs({ rowCount, outcome: 'loaded' }),
		Effect.withSpan('Contacts.list.load', { attributes: { rowCount }, kind: 'client' }),
	);
	return <div data-effect={String(load)} />;
}
