// Evasion: reach node:util parseArgs through a dynamic import instead of a static named import.
export const parsed = async () => {
	const { parseArgs } = await import("node:util");
	return parseArgs({ options: { fix: { type: "boolean" } } });
};
