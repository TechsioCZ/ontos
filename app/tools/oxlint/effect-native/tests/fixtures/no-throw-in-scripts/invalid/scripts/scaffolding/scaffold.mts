// expect-count: 3
/** The emitted template contains `throw` *text*; only the scaffold's own control flow reports. */
const template = (moduleId: string): string => `
export function assert${moduleId}(value: unknown): void {
	if (value === undefined) {
		throw new Error("missing ${moduleId}");
	}
}
`;

export function scaffold(moduleId: string, target: string | undefined): string {
	if (!/^[a-z][a-z0-9-]*$/u.test(moduleId)) {
		throw new Error(`invalid module id ${moduleId}`);
	}
	if (target === undefined) {
		throw new RangeError("target directory is required");
	}
	const rendered = template(moduleId);
	if (rendered.length === 0) throw "empty template";
	return rendered;
}
