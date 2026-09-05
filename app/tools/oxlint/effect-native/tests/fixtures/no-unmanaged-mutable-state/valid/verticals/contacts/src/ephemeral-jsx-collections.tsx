// Audit boundary regression, formerly evasion-jsx-nested: D tier preserves native local
// computation. These fresh empty collections are immediately read and discarded, not retained
// error-cause, provenance, or UI state (A4/C3). Syntactic nesting alone proves no side channel.
import type { ReactElement } from "react";

export function ContactPanel({ items }: { readonly items: readonly object[] }): ReactElement {
	return (
		<ul onMouseEnter={(): boolean => new WeakSet<object>().has(items[0] ?? {})}>
			{items.map((item, index) => (
				<li key={index}>{new WeakMap<object, string>().get(item) ?? "none"}</li>
			))}
		</ul>
	);
}
