// C3 target: success/invalidation state lives in the router/mutation/QueryClient contract, and the
// browser client is created per render tree instead of being memoized in a module-level `let`.
import type { ReactElement } from "react";

export interface ContactEditOutcome {
	readonly contactId: string;
	readonly customerId: string;
	readonly status: "saved" | "unchanged";
}

export const createContactsQueryClient = (): { readonly id: string } => ({ id: "contacts" });

export function EditSuccessBanner({ outcome }: { readonly outcome: ContactEditOutcome }): ReactElement | null {
	const labels = new Map([["saved", "Saved"]]);
	return outcome.status === "saved" ? <p>{labels.get(outcome.status)}</p> : null;
}
