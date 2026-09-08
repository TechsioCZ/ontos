/** Application source is not a script: throws here belong to the A4 rules, not this one. */
export function assertRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("expected a record");
	}
	return value as Record<string, unknown>;
}

export function rethrow(run: () => void): void {
	try {
		run();
	} catch (error) {
		throw error;
	}
}
