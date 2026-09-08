/** Lookalikes that merely mention throwing: no ThrowStatement, so nothing may report. */
const messages = { throwOther: "throw new Error(...)", rethrow: "throw error;" } as const;

export const describe = (key: keyof typeof messages): string => messages[key];
export const thrower = { throw: () => "not a statement" };
export const alias = thrower["throw"];
export function maybe(value: unknown): unknown {
	return value ?? Promise.reject(new Error("rejected, not thrown"));
}
