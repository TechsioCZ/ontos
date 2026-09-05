// expect-count: 3
// Heritage positions: an `extends` / `implements` clause is not a `TSTypeReference`, so the very same
// dictionary escapes by moving one token to the left. (`interface E extends Readonly<Record<…>>` *is*
// caught, because there the `Record` sits in a type-argument list.)
export interface Environment extends Record<string, string | undefined> {}

export interface RouteOverrides extends Partial<Record<string, string>> {}

export class EnvironmentBag implements Record<string, string | undefined> {
	readonly ONTOS_DATABASE_URL?: string;
}

export const read = (environment: Environment): string | undefined => environment['ONTOS_DATABASE_URL'];
