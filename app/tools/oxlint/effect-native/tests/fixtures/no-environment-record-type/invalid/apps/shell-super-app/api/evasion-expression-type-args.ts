// expect-count: 5
// Type arguments and type predicates in expression/declaration positions.
declare function parse<T>(raw: string): T;
declare function isBag(value: unknown): value is Record<string, string | undefined>;
declare function assertBag(value: unknown): asserts value is Record<string, string | undefined>;

export const parsed = parse<Record<string, string | undefined>>('{}');

export const cache = new Map<string, Record<string, string | undefined>>();

export function overloaded(environment: Record<string, string | undefined>): string;
export function overloaded(environment: string): string;
export function overloaded(environment: unknown): string {
	return String(environment);
}

export const guard = (value: unknown): string | undefined =>
	isBag(value) ? value['ONTOS_DATABASE_URL'] : undefined;

export { assertBag, parsed as bag };
