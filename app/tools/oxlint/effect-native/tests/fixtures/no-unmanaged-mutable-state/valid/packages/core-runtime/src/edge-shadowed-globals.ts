// Shadowed or non-global constructors must never report, in every binding form.
import * as collections from "identity-collections";

declare const ambientChannel: WeakMap<object, string>;

type CauseChannel = WeakMap<Error, unknown>;

export interface TrackerProps {
	readonly seen: WeakSet<object>;
}

export const fromNamespace = (): unknown => new collections.WeakMap();

export const withShadowedContainer = (globalThis: {
	readonly WeakMap: new () => { readonly size: number };
}): { readonly size: number } => new globalThis.WeakMap();

export const inCatch = (): boolean => {
	try {
		return ambientChannel.has({});
	} catch (WeakSet) {
		const guard = new WeakSet();
		return guard !== undefined;
	}
};

export const fromLoop = (constructors: readonly (new () => object)[]): readonly object[] => {
	const built: object[] = [];
	for (const WeakMap of constructors) built.push(new WeakMap());
	return built;
};

export type NativeChannel = CauseChannel;
