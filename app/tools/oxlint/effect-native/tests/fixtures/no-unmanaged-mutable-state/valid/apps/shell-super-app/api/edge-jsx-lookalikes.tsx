// Crash probe: JSX member components, fragments, namespaced attributes, generic arrows, and a
// component-local `WeakMap` shadow. Nothing here is module-level mutable state.
import type { ReactElement } from "react";

const Panel = {
	Body: ({ children }: { readonly children: string }): ReactElement => <p>{children}</p>,
};

const identity = <Value,>(value: Value): Value => value;

export function Shell({ label }: { readonly label: string }): ReactElement {
	class WeakMap {
		has(_value: object): boolean {
			return false;
		}
	}
	const local = new WeakMap();
	return (
		<>
			<Panel.Body>{identity(label)}</Panel.Body>
			<svg xmlns:xlink="http://www.w3.org/1999/xlink" data-local={String(local.has({}))} />
		</>
	);
}
