// expect-count: 2
// Corrected A4/C3 fixture: retained identity-keyed state, not an immediate read of an empty
// collection. The former ephemeral reads are preserved as a valid boundary regression.
import type { ReactElement } from "react";

const channels = {
	causes: new WeakMap<object, unknown>(),
	trusted: new WeakSet<object>(),
};
export function ContactPanel({ item }: { readonly item: object }): ReactElement {
	return <section onMouseEnter={() => channels.trusted.add(item)}>{String(channels.causes.get(item))}</section>;
}
