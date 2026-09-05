/** `Date` in a type position is not an expression. */
export interface Row {
	readonly createdAt: Date;
	readonly updatedAt: Date | null;
}

export type Stamps = ReadonlyMap<string, Date>;
export declare const DateConstructorRef: typeof Date;

export function widen(row: Row): Date | null {
	return row.updatedAt;
}

const registry = new Map<string, Date>();
export const size = registry.size;
