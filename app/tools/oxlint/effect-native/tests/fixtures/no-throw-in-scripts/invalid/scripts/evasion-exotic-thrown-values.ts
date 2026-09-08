// expect-count: 10
declare const registry: { readonly Ctor: new (message: string) => Error };
declare const errors: { readonly missing?: Error; readonly [key: string]: unknown };
declare const cause: unknown;

export function exotic(kind: number): void {
	if (kind === 0) throw errors?.missing;
	if (kind === 1) throw errors["contract-invalid"];
	if (kind === 2) throw `contract ${kind} is invalid`;
	if (kind === 3) throw cause as Error;
	if (kind === 4) throw cause satisfies unknown;
	if (kind === 5) throw (cause as Error)!;
	if (kind === 6) throw <Error>cause;
	if (kind === 7) throw new registry.Ctor("failed");
	if (kind === 8) throw (console.log("side effect"), new Error("comma sequence"));
	throw kind > 9 ? new Error("high") : "low";
}
