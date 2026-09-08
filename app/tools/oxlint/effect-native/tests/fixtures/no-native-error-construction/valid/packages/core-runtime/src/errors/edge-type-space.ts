// Type-space only: annotations, declaration merging, type queries and indexed access types.
declare global {
	interface Error {
		readonly traceId?: string;
	}
}

export type NativeCtor = new (message: string) => Error;

export type StackType = Error["stack"];

export type CtorType = typeof TypeError;

export declare function makeProblem(): Error;

export const annotated: Error | undefined = undefined;
