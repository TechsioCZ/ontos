// expect-count: 2
export function assertDatabaseUrl(value) {
	if (typeof value !== "string") throw new TypeError("DATABASE_URL must be a string");
	if (value === "") throw new Error("DATABASE_URL is required");
	return value;
}
