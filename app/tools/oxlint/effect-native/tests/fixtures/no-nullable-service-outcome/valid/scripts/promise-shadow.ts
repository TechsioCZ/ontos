export interface Row {
	readonly rowId: string;
}

/** A same-file `Promise` alias is not the global promise, so it is not an async outcome wrapper. */
type Promise<T> = { readonly value: T };

export interface ShadowedPort {
	readonly load: () => Promise<Row | undefined>;
}
