/** A same-file `Promise` type shadow is not the global promise. */
type Promise<A> = { readonly value: A };

export interface Shadowed {
	readonly load: () => Promise<string>;
}
