// expect-count: 3
// Every spelling of the weak-collection constructor reports, including inside JSX modules.
import type { ReactElement } from "react";

const registry = new globalThis.WeakSet<object>();
const shadowMap = new window["WeakMap"]();
const lazyOwner = () => new self.WeakMap<object, string>();

export const track = (value: object): void => {
	registry.add(value);
	shadowMap.set(value, "tracked");
};

export function RegistryPanel({ value }: { readonly value: object }): ReactElement {
	return <section data-tracked={registry.has(value)}>{String(lazyOwner() !== undefined)}</section>;
}
