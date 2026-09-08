// Only ambient globals report: imported, locally declared and injected constructors stay legal.
import { WeakMap as PersistentWeakMap } from "immutable-identity";

declare const vendor: { readonly WeakSet: new () => { readonly size: number } };

class WeakSet {
	has(_value: object): boolean {
		return false;
	}
}

export const persistent = new PersistentWeakMap<object, string>();
export const localSet = new WeakSet();
export const vendorSet = new vendor.WeakSet();

export const makeWithInjected = (WeakMap: new () => { readonly kind: string }) => new WeakMap();

export type NativeWeakMap = typeof globalThis.WeakMap;
