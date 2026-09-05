// expect-count: 4
// Mirrors verticals/contacts/src/routes/[lang]/contacts/customers/page.tsx:95 — frontend
// reclassification after the Promise boundary erases the typed failure union (audit A4/A9).
import { Effect } from "effect";

interface PanelProps {
	readonly cause: unknown;
}

const classify = (cause: unknown): string => {
	if (cause instanceof TypeError) return "invalid-request";
	if (cause instanceof Error) return cause.message;
	return "unknown";
};

export const loadCustomers = () =>
	Effect.tryPromise({
		try: () =>
			fetch("/api/contacts/customers").then((response) => {
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return response.json() as Promise<readonly unknown[]>;
			}),
		catch: (cause) => new Error(classify(cause)),
	});

export function ErrorPanel({ cause }: PanelProps) {
	return <p role="alert">{classify(cause)}</p>;
}
