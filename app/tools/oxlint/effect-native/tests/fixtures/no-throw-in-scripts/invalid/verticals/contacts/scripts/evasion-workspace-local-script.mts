// expect-count: 2
export function prepare(mode: string): string {
	if (mode !== "apply") throw new Error("only apply is supported");
	try {
		return mode;
	} catch (error) {
		throw error;
	}
}
